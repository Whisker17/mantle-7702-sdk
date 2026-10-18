import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SponsorRejectCode } from "@mantle-aa/sdk";
import { type Address, type Hex, pad, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { SponsorRejection } from "../src/auth.js";
import type { SponsorConfig } from "../src/config.js";
import { Ledger, type PaidRequest } from "../src/ledger.js";
import { signRelayerTransaction } from "../src/relayer.js";
import { SponsorStore } from "../src/store.js";
import { FakeChain } from "./fakeChain.js";
import { testConfig } from "./fixtures.js";

const DAY = 20_000;
const ZERO = { gas: 0n, fee: 0n };
const relayer = privateKeyToAccount(generatePrivateKey());
const accounts = Array.from(
  { length: 10 },
  (_, i) => pad(toHex(0xa0 + i), { size: 20 }) as Address,
);
const [A, B] = accounts as [Address, Address];

let serial = 0;
/** An accepted request of 100k gas at 60 gwei; its bound as `relayerFeeBound` computes it. */
function paid(sender: Address, over: Partial<PaidRequest> = {}): PaidRequest {
  serial++;
  const gas = 100_000n;
  const maxFeePerGas = 60_000_000_000n;
  return {
    digest: pad(toHex(serial)),
    batchDigest: pad(toHex(1_000_000 + serial)),
    sender,
    budgetClass: "business",
    day: DAY,
    tx: {
      to: sender,
      data: "0x",
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas: 1_000_000n,
      maxFee: gas * (maxFeePerGas + 10_000_000_000n) + 4578n * 80_000n,
    },
    ...over,
  };
}

function setup(policy: Partial<SponsorConfig["policy"]> = {}, path = ":memory:") {
  const chain = new FakeChain();
  const store = new SponsorStore(path);
  const config: SponsorConfig = {
    ...testConfig(policy),
    relayer: relayer.address,
    settleTimeoutSeconds: 0.05,
  };
  const ledger = new Ledger({ config, client: chain.client, store, account: relayer });
  return { chain, store, config, ledger };
}

async function rejection(promise: Promise<unknown>): Promise<SponsorRejection> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SponsorRejection);
  return error as SponsorRejection;
}

describe("Ledger", () => {
  it("reserves the worst case, settles from the receipt and releases the rest", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    const pending = await ledger.relay(r);
    expect(pending).toMatchObject({ status: "pending", batchDigest: r.batchDigest });
    expect(store.usage(DAY, A).account.business).toEqual({ gas: r.tx.gas, fee: r.tx.maxFee });
    expect(store.entry(r.digest)).toMatchObject({ state: "submitted", nonce: 0 });

    chain.mine();
    await ledger.reconcile();
    const hash = pending.hash as Hex;
    const charged = { gas: 70_000n, fee: chain.cost(hash) };
    expect(charged.fee).toBeLessThan(r.tx.maxFee);
    expect(await ledger.find(r.digest)).toEqual({
      status: "success",
      hash,
      batchDigest: r.batchDigest,
      fee: String(charged.fee),
    });
    expect(store.entry(r.digest)).toMatchObject({ state: "settled", reserved: ZERO, charged });
    expect(store.usage(DAY, A).account.business).toEqual(charged);
    expect(store.usage(DAY, A).global.business).toEqual(charged);
  });

  it("charges a transaction that reverted", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    const { hash } = await ledger.relay(r);
    chain.mine([hash as Hex]);
    await ledger.reconcile();
    expect(await ledger.find(r.digest)).toMatchObject({
      status: "reverted",
      fee: String(chain.cost(hash as Hex)),
    });
    expect(store.usage(DAY, A).account.business.fee).toBe(chain.cost(hash as Hex));
  });

  it("keeps at most one request per account in flight (SPONSOR_BUSY), not across accounts", async () => {
    const { chain, ledger } = setup();
    await ledger.relay(paid(A));
    const second = paid(A);
    expect((await rejection(ledger.relay(second))).reason).toBe(SponsorRejectCode.SPONSOR_BUSY);
    await expect(ledger.relay(paid(B))).resolves.toMatchObject({ status: "pending" });
    chain.mine();
    await ledger.reconcile();
    // Busy reserved nothing, so the same request goes through once the first has settled.
    await expect(ledger.relay(second)).resolves.toMatchObject({ status: "pending" });
  });

  it("pays a request digest, and a SignedBatchedCall, once: retries get the same result", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    const sameBatch = { ...paid(A), batchDigest: r.batchDigest };
    const results = await Promise.all([ledger.relay(r), ledger.relay(r), ledger.relay(sameBatch)]);
    expect(chain.accepted).toHaveLength(1);
    expect(new Set(results.map((x) => x.hash)).size).toBe(1);
    expect(store.usage(DAY, A).account.business.fee).toBe(r.tx.maxFee);

    chain.mine();
    await ledger.reconcile();
    const settled = await ledger.find(r.digest);
    const usage = store.usage(DAY, A);
    expect(await ledger.relay(r)).toEqual(settled);
    expect(await ledger.relay(sameBatch)).toEqual(settled);
    expect(store.usage(DAY, A)).toEqual(usage);
    expect(chain.accepted).toHaveLength(1);
  });

  it("never reserves past the daily budget, however requests interleave", async () => {
    const one = paid(A).tx.maxFee;
    const { chain, store, ledger } = setup({
      dailyBudget: (one * 5n) / 2n,
      managementReserve: 0n,
    });
    const settled = await Promise.allSettled(accounts.map((a) => ledger.relay(paid(a))));
    const accepted = settled.filter((s) => s.status === "fulfilled");
    expect(accepted).toHaveLength(2);
    for (const s of settled) {
      if (s.status === "rejected") {
        expect((s.reason as SponsorRejection).reason).toBe(SponsorRejectCode.DAILY_BUDGET);
      }
    }
    expect(store.usage(DAY, A).global.business.fee).toBe(2n * one);
    chain.mine();
    await ledger.reconcile();
    const charged = store.entries(["settled"]).reduce((sum, e) => sum + e.charged.fee, 0n);
    expect(store.usage(DAY, A).global.business.fee).toBe(charged);
  });

  it("gives several accounts gap-free relayer nonces", async () => {
    const { chain, store, ledger } = setup();
    await Promise.all(accounts.slice(0, 5).map((a) => ledger.relay(paid(a))));
    const nonces = store.entries().map((e) => e.nonce);
    expect(nonces.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(chain.mine()).toHaveLength(5);
    await ledger.reconcile();
    expect(store.entries(["settled"])).toHaveLength(5);
    expect(chain.nonce(relayer.address)).toBe(5);
  });

  it("releases a request the node refused, and reuses its nonce", async () => {
    const { chain, store, ledger } = setup();
    chain.failSends = ["refuse"];
    const r = paid(A);
    const e = await rejection(ledger.relay(r));
    expect([e.reason, e.detail]).toEqual([
      SponsorRejectCode.SUBMISSION_UNAVAILABLE,
      "the node refused the transaction: insufficient funds for gas * price + value",
    ]);
    expect(store.usage(DAY, A).account.business).toEqual(ZERO);
    expect(store.attempts(r.digest)).toEqual([]);
    // A retry gets the same answer and reserves nothing.
    expect((await rejection(ledger.relay(r))).reason).toBe(
      SponsorRejectCode.SUBMISSION_UNAVAILABLE,
    );
    expect(store.usage(DAY, A).account.business).toEqual(ZERO);
    await ledger.relay(paid(B));
    expect(store.entries(["submitted"])[0]?.nonce).toBe(0);
  });

  it("sends again a transaction whose broadcast never arrived", async () => {
    const { chain, ledger } = setup();
    chain.failSends = ["lose", "lose", "lose", "lose"]; // viem retries a transport failure 3 times
    const r = paid(A);
    expect(await ledger.relay(r)).toMatchObject({ status: "pending" });
    expect(chain.pool.size).toBe(0);
    await ledger.reconcile();
    expect(chain.pool.size).toBe(1);
    chain.mine();
    await ledger.reconcile();
    expect(await ledger.find(r.digest)).toMatchObject({ status: "success" });
  });

  it("reconciles with the chain after a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sponsor-ledger-")), "sponsor.sqlite");
    const first = setup({}, path);
    const mined = paid(A);
    const lost = paid(B);
    await first.ledger.relay(mined);
    await first.ledger.relay(lost);
    // A third request reserved, then the process died before signing it.
    const unsigned = paid(accounts[2] as Address);
    first.store.insertEntry({
      ...unsigned,
      account: unsigned.sender,
      state: "reserved",
      reserved: { gas: 1n, fee: 1n },
    });
    first.store.add(DAY, unsigned.sender, "business", { gas: 1n, fee: 1n });
    await first.ledger.close();
    first.store.close();

    // While it was down: the first transaction was mined, the node forgot the second.
    const chain = first.chain;
    chain.include(await chain.decode(chain.accepted[0] as Hex));
    chain.pool.clear();

    const store = new SponsorStore(path);
    const ledger = new Ledger({
      config: first.config,
      client: chain.client,
      store,
      account: relayer,
      pollIntervalMs: 5,
    });
    const before = await ledger.status();
    expect([before.latest, before.pending, before.nextNonce]).toEqual([1, 1, 2]);
    await ledger.start();
    try {
      expect(await ledger.find(mined.digest)).toMatchObject({ status: "success" });
      expect(store.entry(unsigned.digest)?.state).toBe("released");
      expect(store.usage(DAY, unsigned.sender).account.business).toEqual(ZERO);
      // The forgotten transaction was sent again; once mined, it settles in the background.
      expect(chain.pool.size).toBe(1);
      chain.mine();
      await expect.poll(() => store.entry(lost.digest)?.state).toBe("settled");
      expect(store.entries(["reserved", "submitted"])).toEqual([]);
    } finally {
      await ledger.close();
      store.close();
    }
  });

  it("refuses to start on unsettled transactions of another relayer", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sponsor-ledger-")), "sponsor.sqlite");
    const first = setup({}, path);
    await first.ledger.relay(paid(A));
    first.store.close();
    const store = new SponsorStore(path);
    const other = privateKeyToAccount(generatePrivateKey());
    const ledger = new Ledger({
      config: first.config,
      client: first.chain.client,
      store,
      account: other,
    });
    await expect(ledger.start()).rejects.toThrow(/unsettled transactions/);
    store.close();
  });

  it("bumps: reserves the extra first, then settles by the replacement", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    await ledger.relay(r);
    const reserved = store.entry(r.digest)?.reserved.fee as bigint;
    const hash = await ledger.bump();
    const bumped = store.entry(r.digest)?.reserved.fee as bigint;
    expect(bumped).toBeGreaterThan(reserved);
    expect(store.usage(DAY, A).account.business.fee).toBe(bumped);
    const status = await ledger.status();
    expect(status.open[0]?.attempts.map((a) => a.kind)).toEqual(["submit", "bump"]);
    const [first, second] = status.open[0]?.attempts ?? [];
    expect(second?.maxFeePerGas).toBeGreaterThan(first?.maxFeePerGas as bigint);

    chain.mine();
    await ledger.reconcile();
    expect(await ledger.find(r.digest)).toMatchObject({ status: "success", hash });
    expect(store.usage(DAY, A).account.business.fee).toBe(chain.cost(hash));
  });

  it("returns a refused bump's extra reservation", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    await ledger.relay(r);
    chain.failSends = ["refuse"];
    await expect(ledger.bump({ nonce: 0 })).rejects.toThrow(/bump of nonce 0 failed/);
    expect(store.entry(r.digest)?.reserved.fee).toBe(r.tx.maxFee);
    expect(store.usage(DAY, A).account.business.fee).toBe(r.tx.maxFee);
    expect(store.attempts(r.digest)).toHaveLength(1);
    await expect(ledger.bump({ nonce: 7 })).rejects.toThrow(/nonce 7 is not pending/);
  });

  it("settles a cancel that confirmed as cancelled, charging its cost", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    await ledger.relay(r);
    const hash = await ledger.cancel();
    chain.mine();
    await ledger.reconcile();
    expect(await ledger.find(r.digest)).toEqual({
      status: "cancelled",
      hash,
      batchDigest: r.batchDigest,
      fee: String(chain.cost(hash)),
    });
    expect(store.usage(DAY, A).account.business).toEqual({ gas: 21_000n, fee: chain.cost(hash) });
  });

  it("settles by the original when it beats its cancel", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    const { hash } = await ledger.relay(r);
    const original = await chain.decode(chain.accepted[0] as Hex);
    await ledger.cancel();
    chain.include(original);
    await ledger.reconcile();
    expect(await ledger.find(r.digest)).toMatchObject({ status: "success", hash });
    expect(store.usage(DAY, A).account.business.fee).toBe(chain.cost(hash as Hex));
  });

  it("releases a request whose nonce another transaction consumed", async () => {
    const { chain, store, ledger } = setup();
    const r = paid(A);
    await ledger.relay(r);
    const foreign = await signRelayerTransaction(relayer, 5003, {
      to: relayer.address,
      data: "0x",
      gas: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      nonce: 0,
    });
    chain.include(await chain.decode(foreign.raw));
    for (let i = 0; i < 2; i++) await ledger.reconcile();
    expect(store.entry(r.digest)?.state).toBe("submitted");
    await ledger.reconcile();
    expect((await rejection(ledger.find(r.digest) as Promise<unknown>)).detail).toMatch(
      /nonce 0 was used by another transaction/,
    );
    expect(store.usage(DAY, A).account.business).toEqual(ZERO);
  });

  it("checks the daily budget again for a bump's extra", async () => {
    const r = paid(A);
    const { store, ledger } = setup({
      dailyBudget: r.tx.maxFee + parseEther("0.000001"),
      managementReserve: 0n,
    });
    await ledger.relay(r);
    await expect(ledger.bump()).rejects.toMatchObject({ reason: SponsorRejectCode.DAILY_BUDGET });
    expect(store.entry(r.digest)?.reserved.fee).toBe(r.tx.maxFee);
  });
});
