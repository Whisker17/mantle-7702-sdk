import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Call,
  caliburAbi,
  delegationDesignator,
  ERC20ETH,
  erc20Abi,
  getProfile,
  laneOf,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  PrivateKeySigner,
  type RelayResult,
  ROOT_KEY_HASH,
  RuleKind,
  readCaliburNonce,
  SELECTORS,
  type Signer,
  SPONSOR_REJECTED_RPC_CODE,
  SponsorRejectCode,
} from "@0xwh1sker/mantle-aa-sdk";
import { type Address, encodeFunctionData, type Hex, zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  RELAYER,
  startFork,
  TestRelayer,
  THIRD_PARTY,
  walletFor,
} from "../../sdk/test/account/fork.js";
import type { SponsorConfig } from "../src/config.js";
import { receiptCost } from "../src/fees.js";
import { Ledger } from "../src/ledger.js";
import { createSponsorServer, sponsorRelay } from "../src/server.js";
import { dayOf, OPEN_STATES, SponsorStore } from "../src/store.js";
import { book, nowSeconds, RELAYER_ADDRESS, relayRequest, testConfig } from "./fixtures.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;

const policy: Policy = {
  maxValuePerCall: 0n,
  mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
  quoteLimits: [{ token: USD, totalCap: 10n ** 9n, periodCap: 10n ** 9n }],
  periodLength: 86400,
  permissions: [{ target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE }],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
};
const approve = (amount: bigint): Call => ({
  to: USD,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAD, amount] }),
});
const approveNative = (account: Address): Call => ({
  to: account,
  value: 0n,
  data: encodeFunctionData({
    abi: caliburAbi,
    functionName: "approveNative",
    args: [ERC20ETH, 0n],
  }),
});

interface Rpc {
  result?: RelayResult;
  error?: { code: number; data?: { reason: string; detail: string } };
}

describe.skipIf(!rpcUrl)("sponsor ledger and relayer on a Mantle Sepolia fork", () => {
  let stop: () => void;
  let url: string;
  let client: ReturnType<typeof clientFor>;
  let config: SponsorConfig;
  let store: SponsorStore;
  let ledger: Ledger;
  let server: ReturnType<typeof createSponsorServer>;
  let base: string;
  const database = join(mkdtempSync(join(tmpdir(), "sponsor-ledger-fork-")), "sponsor.sqlite");
  const keystore = {
    home: mkdtempSync(join(tmpdir(), "sponsor-ledger-fork-")),
    password: "test",
    scrypt: { n: 1024, r: 8, p: 1 },
  };
  const root = new PrivateKeySigner(generatePrivateKey());
  const fresh = Array.from({ length: 4 }, () => new PrivateKeySigner(generatePrivateKey()));
  const agents: { signer: Signer; keyHash: Hex }[] = [];

  const rpc = (method: string, params: unknown[] = []) =>
    client.request({ method, params } as never) as Promise<unknown>;
  const relayerNonce = (blockTag: "latest" | "pending") =>
    client.getTransactionCount({ address: RELAYER_ADDRESS, blockTag });

  async function serve() {
    store = new SponsorStore(database);
    ledger = new Ledger({ config, client, store, account: RELAYER, pollIntervalMs: 200 });
    await ledger.start();
    server = createSponsorServer({ config, client, store, ledger });
    base = await server.listen();
  }
  async function shutdown() {
    await server.close();
    await ledger.close();
    store.close();
  }

  beforeAll(async () => {
    ({ url, stop } = await startFork(rpcUrl as string));
    client = clientFor(url);
    // Setup (init and grants) goes through a stand-in relayer with the same key, before the ledger.
    const setup = new TestRelayer(url, book);
    const account = new MantleAccount({
      client,
      root,
      executor: setup,
      addresses: book,
      keystore,
    });
    await account.init({ grant: { policy, agentName: "agent0" } });
    await account.grantSession(policy, { agentName: "agent1" });
    await account.grantSession(policy, { agentName: "agent2" });
    for (const name of ["agent0", "agent1", "agent2"]) {
      agents.push({
        signer: loadProfileSigner(name, keystore),
        keyHash: getProfile(name, keystore).keyHash,
      });
    }
    config = {
      ...testConfig({ allowlist: [root.address, ...fresh.map((f) => f.address)] }),
      rpcUrl: url,
      database,
      settleTimeoutSeconds: 1,
    };
    await serve();
  }, 180_000);
  afterAll(async () => {
    await shutdown().catch(() => undefined);
    stop?.();
  }, 30_000);

  const post = async (params: unknown): Promise<Rpc> => {
    const res = await fetch(base, {
      method: "POST",
      // A signed authorization carries `v` as a bigint, which the wire does not use.
      body: JSON.stringify(
        { jsonrpc: "2.0", id: 1, method: "sponsor_relay", params: [params] },
        (_, v) => (typeof v === "bigint" ? Number(v) : v),
      ),
    });
    return (await res.json()) as Rpc;
  };
  /** A session request of `agent` on its lane's current Calibur nonce. */
  const sessionRequest = async (
    agent: { signer: Signer; keyHash: Hex },
    calls: Call[],
    deadline?: bigint,
  ) =>
    relayRequest({
      client,
      account: root.address,
      signer: agent.signer,
      keyHash: agent.keyHash,
      calls,
      nonce: await readCaliburNonce(client, root.address, laneOf(agent.keyHash)),
      ...(deadline ? { deadline } : {}),
    });
  /** Posts a request until it settles: SPONSOR_BUSY and pending are retried with the same request. */
  async function untilSettled(params: unknown, counts = { busy: 0, pending: 0 }) {
    for (;;) {
      const { result, error } = await post(params);
      if (error?.data?.reason === SponsorRejectCode.SPONSOR_BUSY) {
        counts.busy++;
        await sleep(50 + Math.random() * 200);
      } else if (error) {
        throw new Error(`sponsor_relay failed: ${JSON.stringify(error)}`);
      } else if (result?.status === "pending") {
        counts.pending++;
      } else {
        return result as RelayResult;
      }
    }
  }
  /** Sends a request without mining, waits until the ledger has submitted it, returns its digest. */
  async function submitUnmined(params: Awaited<ReturnType<typeof relayRequest>>) {
    const pending = await sponsorRelay({ config, client, store, ledger }, params);
    expect(pending.status).toBe("pending");
    const entry = store.entries(OPEN_STATES).find((e) => e.batchDigest === pending.batchDigest);
    expect(entry?.state).toBe("submitted");
    return { ...pending, params, digest: entry?.digest as Hex, nonce: entry?.nonce as number };
  }
  const settledEntry = (digest: Hex) =>
    expect
      .poll(() => store.entry(digest)?.state, { timeout: 20_000, interval: 100 })
      .toBe("settled");
  const receipt = (hash: Hex) => client.waitForTransactionReceipt({ hash, timeout: 30_000 });

  it("3 agents × 5 requests on one account: busy and retried, all paid once, never over-reserved", async () => {
    const day = dayOf(nowSeconds());
    const latest = await relayerNonce("latest");
    const balance = await client.getBalance({ address: RELAYER_ADDRESS });
    const usage = store.usage(day, root.address);
    const counts = { busy: 0, pending: 0 };
    const samples: { open: number; accountGas: bigint; spent: bigint; reserved: bigint }[] = [];
    const sampler = setInterval(() => {
      const open = store.entries(OPEN_STATES);
      const u = store.usage(day, root.address);
      samples.push({
        open: open.filter((e) => e.account === root.address).length,
        accountGas: u.account.business.gas,
        spent: u.global.business.fee + u.global.management.fee,
        reserved: open.reduce((sum, e) => sum + e.reserved.fee, 0n),
      });
    }, 10);
    let results: RelayResult[];
    try {
      results = (
        await Promise.all(
          agents.map(async (agent) => {
            const out: RelayResult[] = [];
            for (let i = 1n; i <= 5n; i++) {
              out.push(await untilSettled(await sessionRequest(agent, [approve(i)]), counts));
            }
            return out;
          }),
        )
      ).flat();
    } finally {
      clearInterval(sampler);
    }

    // All 15 executed, each by its own relayer transaction: nothing submitted twice.
    expect(results.map((r) => r.status)).toEqual(Array(15).fill("success"));
    const hashes = results.map((r) => r.hash as Hex);
    expect(new Set(hashes).size).toBe(15);
    expect(await relayerNonce("latest")).toBe(latest + 15);
    const entries = results.map((r) => store.entryByBatch(r.batchDigest));
    const attempts = entries.flatMap((e) => store.attempts(e?.digest as Hex));
    expect(attempts).toHaveLength(15);
    expect(attempts.map((a) => a.nonce).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => latest + i),
    );
    for (const agent of agents) {
      expect(await readCaliburNonce(client, root.address, laneOf(agent.keyHash))).toBe(
        (laneOf(agent.keyHash) << 64n) | 5n,
      );
    }
    // Contention happened, and was answered SPONSOR_BUSY, never with a second request in flight.
    expect(counts.busy).toBeGreaterThan(0);
    expect(Math.max(...samples.map((s) => s.open))).toBe(1);
    // Reservations stayed within the caps and return to zero.
    const { policy: caps } = config;
    expect(samples.some((s) => s.reserved > 0n)).toBe(true);
    for (const s of samples) {
      expect(s.accountGas).toBeLessThanOrEqual(caps.accountDailyGas);
      expect(s.spent + caps.managementReserve).toBeLessThanOrEqual(caps.dailyBudget);
    }
    expect(store.entries(OPEN_STATES)).toEqual([]);
    // Charged = the receipts' costs = what the relayer paid.
    const costs = await Promise.all(hashes.map(async (h) => receiptCost(await rawReceipt(h))));
    const charged = entries.reduce((sum, e) => sum + (e?.charged.fee ?? 0n), 0n);
    const sum = costs.reduce((a, b) => a + b, 0n);
    expect(charged).toBe(sum);
    expect(balance - (await client.getBalance({ address: RELAYER_ADDRESS }))).toBe(sum);
    const after = store.usage(day, root.address);
    expect(after.account.business.fee - usage.account.business.fee).toBe(sum);
    expect(after.global.business.fee - usage.global.business.fee).toBe(sum);
    console.log(
      `3×5: ${counts.busy} SPONSOR_BUSY, ${counts.pending} pending answers; nonces ${latest}..${latest + 14}; charged ${sum} wei`,
    );
  }, 300_000);

  const rawReceipt = (hash: Hex) =>
    client.request({ method: "eth_getTransactionReceipt", params: [hash] }) as never;

  it("gives several accounts sharing the relayer gap-free nonces (type-4 inits)", async () => {
    const latest = await relayerNonce("latest");
    const results = await Promise.all(
      fresh.map(async (f) =>
        untilSettled(
          await relayRequest({
            client,
            account: f.address,
            signer: f,
            keyHash: ROOT_KEY_HASH,
            calls: [approveNative(f.address)],
            nonce: 0n,
            authorization: await f.signAuthorization({
              address: book.caliburEntry,
              chainId: 5003,
              nonce: 0,
            }),
          }),
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(4).fill("success"));
    const nonces = results.map((r) =>
      store.attempts(store.entryByBatch(r.batchDigest)?.digest as Hex),
    );
    expect(nonces.flatMap((a) => a.map((x) => x.nonce)).sort((a, b) => a - b)).toEqual([
      latest,
      latest + 1,
      latest + 2,
      latest + 3,
    ]);
    expect(await relayerNonce("latest")).toBe(latest + 4);
    for (const [i, f] of fresh.entries()) {
      expect((await client.getCode({ address: f.address }))?.toLowerCase()).toBe(
        delegationDesignator(book.caliburEntry),
      );
      const tx = await client.getTransaction({ hash: results[i]?.hash as Hex });
      expect(tx.type).toBe("eip7702");
      expect(store.entryByBatch(results[i]?.batchDigest as Hex)?.budgetClass).toBe("management");
    }
  }, 300_000);

  it("refuses an executor-0 batch: anyone can land it first, so the relayer's copy would revert", async () => {
    const agent = agents[0] as { signer: Signer; keyHash: Hex };
    const params = await relayRequest({
      client,
      account: root.address,
      signer: agent.signer,
      keyHash: agent.keyHash,
      calls: [approve(7n)],
      nonce: await readCaliburNonce(client, root.address, laneOf(agent.keyHash)),
      executor: zeroAddress,
    });
    const { error } = await post(params);
    expect(error).toMatchObject({
      code: SPONSOR_REJECTED_RPC_CODE,
      data: { reason: SponsorRejectCode.WRONG_EXECUTOR },
    });
    // The same signed batch, landed by a third party.
    const hash = await walletFor(url, THIRD_PARTY).sendTransaction({
      to: root.address,
      data: params.data,
      gas: 1_000_000n,
    });
    expect((await receipt(hash)).status).toBe("success");
    // A relayer-bound batch cannot be landed by anyone else.
    const bound = await sessionRequest(agent, [approve(8n)]);
    const stolen = await walletFor(url, THIRD_PARTY).sendTransaction({
      to: root.address,
      data: bound.data,
      gas: 1_000_000n,
    });
    expect((await receipt(stolen)).status).toBe("reverted");
  }, 120_000);

  describe("with mining paused", () => {
    beforeAll(() => rpc("evm_setAutomine", [false]), 30_000);
    afterAll(() => rpc("evm_setAutomine", [true]), 30_000);

    it("status shows the pending transaction; bump reserves the extra first and settles by the replacement", async () => {
      const sent = await submitUnmined(await sessionRequest(agents[0] as never, [approve(11n)]));
      const status = await ledger.status();
      expect(status).toMatchObject({ pending: status.latest + 1, nextNonce: status.latest + 1 });
      expect(status.open.map((e) => [e.digest, e.nonce])).toEqual([[sent.digest, sent.nonce]]);
      const reserved = store.entry(sent.digest)?.reserved.fee as bigint;

      const hash = await ledger.bump();
      expect(store.entry(sent.digest)?.reserved.fee).toBeGreaterThan(reserved);
      const [first, bumped] = (await ledger.status()).open[0]?.attempts ?? [];
      expect(bumped?.kind).toBe("bump");
      expect(bumped?.maxFeePerGas).toBeGreaterThan(first?.maxFeePerGas as bigint);
      expect(await client.getTransaction({ hash })).toMatchObject({ nonce: sent.nonce });

      await rpc("evm_mine");
      await settledEntry(sent.digest);
      const result = store.entry(sent.digest)?.result;
      expect(result).toMatchObject({ status: "success", hash });
      expect(store.entry(sent.digest)?.charged.fee).toBe(receiptCost(await rawReceipt(hash)));
      expect(store.entry(sent.digest)?.reserved.fee).toBe(0n);
      // A retry of the request returns that same result.
      expect(await sponsorRelay({ config, client, store, ledger }, sent.params)).toEqual(result);
    }, 120_000);

    it("a cancel that confirms settles as cancelled and is charged; the batch never runs", async () => {
      const agent = agents[1] as { signer: Signer; keyHash: Hex };
      const seq = await readCaliburNonce(client, root.address, laneOf(agent.keyHash));
      const sent = await submitUnmined(await sessionRequest(agent, [approve(12n)]));
      const hash = await ledger.cancel();
      await rpc("evm_mine");
      await settledEntry(sent.digest);
      expect(store.entry(sent.digest)?.result).toMatchObject({ status: "cancelled", hash });
      expect(store.entry(sent.digest)?.charged).toEqual({
        gas: 21_000n,
        fee: receiptCost(await rawReceipt(hash)),
      });
      expect(await readCaliburNonce(client, root.address, laneOf(agent.keyHash))).toBe(seq);
    }, 120_000);

    it("a cancel that loses to the original settles by the original", async () => {
      const sent = await submitUnmined(await sessionRequest(agents[2] as never, [approve(13n)]));
      const [original] = store.attempts(sent.digest);
      const cancel = await ledger.cancel();
      // The original wins the race: the node drops the cancel and mines the original.
      await rpc("anvil_dropTransaction", [cancel]);
      await rpc("eth_sendRawTransaction", [original?.raw]);
      await rpc("evm_mine");
      await settledEntry(sent.digest);
      expect(store.entry(sent.digest)?.result).toMatchObject({
        status: "success",
        hash: original?.hash,
      });
      expect(store.entry(sent.digest)?.charged.fee).toBe(
        receiptCost(await rawReceipt(original?.hash as Hex)),
      );
      expect(await client.getTransactionReceipt({ hash: cancel }).catch(() => null)).toBeNull();
    }, 120_000);

    it("reconciles with the chain after a restart: mined while down, and forgotten by the node", async () => {
      const mined = await submitUnmined(await sessionRequest(agents[0] as never, [approve(14n)]));
      const f = fresh[0] as PrivateKeySigner;
      const forgotten = await submitUnmined(
        await relayRequest({
          client,
          account: f.address,
          signer: f,
          keyHash: ROOT_KEY_HASH,
          calls: [approveNative(f.address)],
          nonce: await readCaliburNonce(client, f.address, 0n),
        }),
      );
      expect(forgotten.nonce).toBe(mined.nonce + 1);
      await shutdown();

      // While the service is down: the first is mined, the node loses the second.
      await rpc("anvil_dropTransaction", [forgotten.hash]);
      await rpc("evm_mine");
      expect(await relayerNonce("latest")).toBe(mined.nonce + 1);
      expect(await relayerNonce("pending")).toBe(mined.nonce + 1);

      // Restart: the persisted nonces are ahead of `pending`; both requests are still open.
      store = new SponsorStore(database);
      ledger = new Ledger({ config, client, store, account: RELAYER, pollIntervalMs: 200 });
      const before = await ledger.status();
      expect([before.latest, before.pending, before.nextNonce]).toEqual([
        mined.nonce + 1,
        mined.nonce + 1,
        forgotten.nonce + 1,
      ]);
      expect(before.open.map((e) => e.digest)).toEqual([mined.digest, forgotten.digest]);
      store.close();
      await serve();

      // The mined one was settled from its receipt; the forgotten one was sent again.
      expect(store.entry(mined.digest)?.result).toMatchObject({
        status: "success",
        hash: mined.hash,
      });
      expect(store.entry(forgotten.digest)?.state).toBe("submitted");
      expect(await relayerNonce("pending")).toBe(forgotten.nonce + 1);
      await rpc("evm_mine");
      await settledEntry(forgotten.digest);
      expect(store.entry(forgotten.digest)?.result).toMatchObject({
        status: "success",
        hash: forgotten.hash,
      });
      expect(store.entries(OPEN_STATES)).toEqual([]);
    }, 180_000);

    // Last: it moves the fork's clock past the batch deadline.
    it("charges a transaction that reverts on chain", async () => {
      const { timestamp } = await client.getBlock();
      const deadline = timestamp + 60n;
      const sent = await submitUnmined(
        await sessionRequest(agents[1] as never, [approve(15n)], deadline),
      );
      await rpc("evm_setNextBlockTimestamp", [Number(deadline + 1n)]);
      await rpc("evm_mine");
      await settledEntry(sent.digest);
      const r = await rawReceipt(sent.hash as Hex);
      expect(store.entry(sent.digest)?.result).toMatchObject({
        status: "reverted",
        hash: sent.hash,
      });
      expect(store.entry(sent.digest)?.charged.fee).toBe(receiptCost(r));
      expect(receiptCost(r)).toBeGreaterThan(0n);
    }, 120_000);
  });
});
