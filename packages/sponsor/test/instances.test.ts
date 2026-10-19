import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SponsorRejectCode } from "@mantle-aa/sdk";
import { type Address, pad, toHex } from "viem";
import { generatePrivateKey, type LocalAccount, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import type { SponsorConfig } from "../src/config.js";
import { EMBEDDED_RELAYER_KEY_ENV, startEmbeddedSponsor } from "../src/embedded.js";
import { Ledger, type PaidRequest } from "../src/ledger.js";
import { PaymasterLedger } from "../src/paymaster.js";
import { SponsorStore } from "../src/store.js";
import { FakeChain } from "./fakeChain.js";
import { testConfig } from "./fixtures.js";

// Two sponsors on one database file, as two embedded CLI commands with one home are. The pauses are
// promises the test holds, never timing; the time bounds are generous for a loaded machine.

const DAY = 20_000;
const IN_USE = /sponsor\.sqlite is in use by another running sponsor/;
const ZERO = { gas: 0n, fee: 0n };
const SENDER = pad(toHex(0xa0), { size: 20 }) as Address;

const request = (): PaidRequest => {
  const gas = 100_000n;
  const maxFeePerGas = 60_000_000_000n;
  return {
    digest: pad(toHex(1)),
    batchDigest: pad(toHex(2)),
    sender: SENDER,
    budgetClass: "business",
    day: DAY,
    tx: {
      to: SENDER,
      data: "0x",
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas: 1_000_000n,
      maxFee: gas * (maxFeePerGas + 10_000_000_000n) + 4578n * 80_000n,
    },
  };
};

/** A relayer key whose next signature waits until the test lets it go. */
function heldSigner(account: LocalAccount) {
  let entered!: () => void;
  let release!: () => void;
  const signing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const go = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signer: LocalAccount = {
    ...account,
    async signTransaction(...args: Parameters<LocalAccount["signTransaction"]>) {
      entered();
      await go;
      return account.signTransaction(...args);
    },
  };
  return { signer, signing, release };
}

describe("two sponsors on one database", () => {
  const relayer = privateKeyToAccount(generatePrivateKey());
  const config: SponsorConfig = {
    ...testConfig(),
    relayer: relayer.address,
    settleTimeoutSeconds: 0.05,
  };
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });
  const database = () => join(mkdtempSync(join(tmpdir(), "sponsor-instances-")), "sponsor.sqlite");
  function open(path: string, chain: FakeChain, account: LocalAccount = relayer) {
    const store = new SponsorStore(path);
    const ledger = new Ledger({
      config,
      client: chain.client,
      store,
      account,
      pollIntervalMs: 3_600_000,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await ledger.close();
      store.close();
    };
    cleanup.push(close);
    return { store, ledger, close };
  }

  it("a second sponsor cannot release the reservation of a request the first is signing", async () => {
    const path = database();
    const chain = new FakeChain();
    const held = heldSigner(relayer);
    const a = open(path, chain, held.signer);
    await a.ledger.start();
    const r = request();
    const relayed = a.ledger.relay(r);
    await held.signing;
    expect(a.store.entry(r.digest)?.state).toBe("reserved");
    expect(a.store.usage(DAY, SENDER).global.business.fee).toBe(r.tx.maxFee);

    // The second sponsor starts while the first is between reservation and broadcast.
    const b = open(path, chain);
    await expect(b.ledger.start()).rejects.toThrow(IN_USE);
    expect(a.store.entry(r.digest)).toMatchObject({ state: "reserved", error: null });

    held.release();
    expect(await relayed).toMatchObject({ status: "pending", batchDigest: r.batchDigest });
    // Broadcast once, with its whole worst case still reserved.
    expect(chain.accepted).toHaveLength(1);
    expect(a.store.entry(r.digest)).toMatchObject({
      state: "submitted",
      reserved: { gas: r.tx.gas, fee: r.tx.maxFee },
      error: null,
    });
    expect(a.store.usage(DAY, SENDER).global.business).toEqual({ gas: r.tx.gas, fee: r.tx.maxFee });
  }, 60_000);

  it("never broadcasts a request whose reservation was released while it was signed", async () => {
    const chain = new FakeChain();
    const held = heldSigner(relayer);
    const store = new SponsorStore(":memory:");
    const ledger = new Ledger({ config, client: chain.client, store, account: held.signer });
    cleanup.push(async () => {
      await ledger.close();
      store.close();
    });
    const r = request();
    const relayed = ledger.relay(r);
    await held.signing;
    // Released behind the signing ledger's back (what a second sponsor's start-up did).
    store.transaction(() => {
      store.add(DAY, SENDER, "business", { gas: -r.tx.gas, fee: -r.tx.maxFee });
      store.updateEntry(r.digest, {
        state: "released",
        reserved: ZERO,
        error: { reason: SponsorRejectCode.SUBMISSION_UNAVAILABLE, detail: "released" },
      });
    });

    held.release();
    await expect(relayed).rejects.toMatchObject({
      reason: SponsorRejectCode.SUBMISSION_UNAVAILABLE,
    });
    expect(chain.accepted).toEqual([]);
    expect(store.attempts(r.digest)).toEqual([]);
    expect(store.entry(r.digest)).toMatchObject({ state: "released", nonce: null });
    expect(store.usage(DAY, SENDER).global.business).toEqual(ZERO);
  }, 60_000);

  it("holds the database until its sponsor closes; readers and in-memory databases need no claim", async () => {
    const path = database();
    const chain = new FakeChain();
    const a = open(path, chain);
    await a.ledger.start();
    // `sponsor relayer status` beside the running sponsor: a ledger that is never started.
    const reader = open(path, chain);
    await expect(reader.ledger.status()).resolves.toMatchObject({ open: [] });
    const paymaster = new PaymasterLedger({
      config,
      client: chain.client,
      store: reader.store,
      signer: relayer,
    });
    await expect(paymaster.start()).rejects.toThrow(IN_USE);
    await a.close();
    const b = open(path, chain);
    await b.ledger.start();

    const memory = [open(":memory:", chain), open(":memory:", chain)];
    for (const { ledger } of memory) await ledger.start();
  }, 60_000);

  it("holds the database against other processes, and frees it when its process dies", async () => {
    const path = database();
    const store = fileURLToPath(new URL("../src/store.ts", import.meta.url));
    /** Another process that claims the database, prints the outcome, and (`hold`) keeps it. */
    const claimer = (hold: boolean) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { SponsorStore } from ${JSON.stringify(store)};
           try {
             new SponsorStore(${JSON.stringify(path)}).claimSubmitter();
             console.log("claimed");
             if (${hold}) setInterval(() => {}, 1000);
           } catch (error) {
             console.log(error.message);
           }`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const exited = once(child, "exit");
      cleanup.push(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      const line = new Promise<string>((resolve, reject) => {
        child.stdout.on("data", () => out.includes("\n") && resolve(out.trim()));
        // `close` follows the last output, which `exit` may not.
        child.once("close", () => reject(new Error(`the claiming process exited: ${out}`)));
      });
      return { child, exited, line };
    };

    const holder = claimer(true);
    expect(await holder.line).toBe("claimed");
    const chain = new FakeChain();
    const b = open(path, chain);
    await expect(b.ledger.start()).rejects.toThrow(IN_USE);
    // Killed: it never closed the database.
    holder.child.kill("SIGKILL");
    expect(await holder.exited).toEqual([null, "SIGKILL"]);
    await b.ledger.start();

    // Held here now, also after a refused claim in this process closed its own handle on the lock.
    await expect(open(path, chain).ledger.start()).rejects.toThrow(IN_USE);
    const late = claimer(false);
    expect(await late.line).toMatch(IN_USE);
    expect(await late.exited).toEqual([0, null]);
  }, 120_000);

  it("refuses a second embedded sponsor on one database, as two CLI commands with one home", async () => {
    const path = database();
    const key = generatePrivateKey();
    const options = {
      // Never called: an empty ledger reconciles without the chain.
      rpcUrl: "http://127.0.0.1:1",
      allowlist: [SENDER],
      database: path,
      env: { MANTLE_AA_EMBEDDED_RELAYER: "1", [EMBEDDED_RELAYER_KEY_ENV]: key },
    };
    const first = await startEmbeddedSponsor(options);
    let running = true;
    cleanup.push(() => (running ? first.close() : undefined));
    await expect(startEmbeddedSponsor(options)).rejects.toThrow(IN_USE);
    // The first keeps serving; once it is closed the next one starts.
    expect(await fetch(`${first.url}/health`).then((r) => r.status)).toBe(200);
    await first.close();
    running = false;
    const next = await startEmbeddedSponsor(options);
    cleanup.push(() => next.close());
    expect(await fetch(`${next.url}/health`).then((r) => r.status)).toBe(200);
  }, 60_000);
});
