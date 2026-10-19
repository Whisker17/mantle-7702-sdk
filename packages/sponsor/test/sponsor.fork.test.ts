import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPolicyHookAbi,
  type Call,
  caliburAbi,
  ERC20ETH,
  erc20Abi,
  getProfile,
  laneOf,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  PrivateKeySigner,
  ROOT_KEY_HASH,
  RuleKind,
  readCaliburNonce,
  SELECTORS,
  SPONSOR_REJECTED_RPC_CODE,
  SponsorRejectCode,
  secp256k1KeyHash,
} from "@0xwh1sker/mantle-aa-sdk";
import { type Address, encodeFunctionData, getAddress, type Hex, zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  RELAYER,
  startFork,
  TestRelayer,
  walletFor,
} from "../../sdk/test/account/fork.js";
import { SponsorRejection } from "../src/auth.js";
import type { SponsorConfig } from "../src/config.js";
import {
  authorizeRelay,
  createSponsorServer,
  type RelaySubmitter,
  type SponsorContext,
} from "../src/server.js";
import { dayOf, SponsorStore } from "../src/store.js";
import {
  book,
  nowSeconds,
  RELAYER_ADDRESS,
  type RequestOptions,
  relayRequest,
  testConfig,
} from "./fixtures.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const OTHER_SPENDER = getAddress("0x00000000000000000000000000000000000b0b00");

const policy: Policy = {
  maxValuePerCall: 0n,
  mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
  quoteLimits: [{ token: USD, totalCap: 10n ** 9n, periodCap: 10n ** 9n }],
  periodLength: 86400,
  permissions: [{ target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE }],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
};
const approve = (spender: Address, amount = 1n): Call => ({
  to: USD,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});

describe.skipIf(!rpcUrl)("sponsor authentication and policy on a Mantle Sepolia fork", () => {
  let stop: () => void;
  let url: string;
  let client: ReturnType<typeof clientFor>;
  let relayer: TestRelayer;
  let store: SponsorStore;
  let config: SponsorConfig;
  let ctx: SponsorContext;
  const keystore = {
    home: mkdtempSync(join(tmpdir(), "sponsor-fork-")),
    password: "test",
    scrypt: { n: 1024, r: 8, p: 1 },
  };
  const root = new PrivateKeySigner(generatePrivateKey());
  const fresh = new PrivateKeySigner(generatePrivateKey());
  const halfInit = new PrivateKeySigner(generatePrivateKey());
  let account: MantleAccount;
  let session: PrivateKeySigner;
  let keyHash: Hex;

  beforeAll(async () => {
    ({ url, stop } = await startFork(rpcUrl as string));
    client = clientFor(url);
    relayer = new TestRelayer(url, book);
    expect(RELAYER.address).toBe(RELAYER_ADDRESS);
    account = new MantleAccount({ client, root, executor: relayer, addresses: book, keystore });
    await account.init({ grant: { policy, agentName: "agent" } });
    session = loadProfileSigner("agent", keystore);
    keyHash = getProfile("agent", keystore).keyHash;
    store = new SponsorStore(":memory:");
    config = {
      ...testConfig({ allowlist: [root.address, fresh.address, halfInit.address] }),
      rpcUrl: url,
    };
    ctx = { config, client, store };
  }, 120_000);
  afterAll(() => {
    store?.close();
    stop?.();
  }, 30_000);

  /** A request for `account`, on the batch key's current Calibur nonce. */
  const request = async (o: Omit<RequestOptions, "client" | "account"> & { account?: Address }) => {
    const sender = o.account ?? root.address;
    return relayRequest({
      client,
      account: sender,
      nonce: await readCaliburNonce(client, sender, laneOf(o.keyHash)),
      ...o,
    });
  };
  const rejection = async (params: unknown) => {
    const error = await authorizeRelay(ctx, params).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SponsorRejection);
    return (error as SponsorRejection).reason;
  };

  it("accepts an allowed session request with its own simulation and a worst-case fee", async () => {
    const decision = await authorizeRelay(
      ctx,
      await request({ signer: session, keyHash, calls: [approve(PAD)] }),
    );
    expect(decision).toMatchObject({
      sender: root.address,
      keyHash,
      lane: laneOf(keyHash),
      budgetClass: "business",
      day: dayOf(nowSeconds()),
    });
    const { tx } = decision;
    expect(tx.to).toBe(root.address);
    expect(tx.gas).toBeGreaterThan(21_000n);
    // The operator fee and the L1 fee bound come on top of gas × maxFeePerGas.
    expect(tx.maxFee).toBeGreaterThan(tx.gas * tx.maxFeePerGas + tx.gas * 10n ** 9n);

    // The decided transaction is what lands: sent as is, it succeeds within the bound.
    const before = await client.getBalance({ address: RELAYER_ADDRESS });
    const hash = await walletFor(url, RELAYER).sendTransaction({
      to: tx.to,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    expect(receipt.status).toBe("success");
    expect(before - (await client.getBalance({ address: RELAYER_ADDRESS }))).toBeLessThanOrEqual(
      tx.maxFee,
    );
  }, 60_000);

  it("puts a root management batch on the management budget", async () => {
    const decision = await authorizeRelay(
      ctx,
      await request({
        signer: root,
        keyHash: ROOT_KEY_HASH,
        calls: [
          {
            to: root.address,
            value: 0n,
            data: encodeFunctionData({
              abi: caliburAbi,
              functionName: "approveNative",
              args: [ERC20ETH, 0n],
            }),
          },
        ],
      }),
    );
    expect([decision.budgetClass, decision.lane]).toEqual(["management", 0n]);
  }, 60_000);

  it("accepts the root's first init with an authorization, and refuses a stale one", async () => {
    const init: Call = {
      to: fresh.address,
      value: 0n,
      data: encodeFunctionData({
        abi: caliburAbi,
        functionName: "approveNative",
        args: [ERC20ETH, 0n],
      }),
    };
    const authorize = (nonce: number) =>
      fresh.signAuthorization({ address: book.caliburEntry, chainId: 5003, nonce });
    const ok = await authorizeRelay(
      ctx,
      await request({
        account: fresh.address,
        signer: fresh,
        keyHash: ROOT_KEY_HASH,
        calls: [init],
        authorization: await authorize(0),
      }),
    );
    expect(ok.budgetClass).toBe("management");
    expect(ok.tx.authorizationList).toHaveLength(1);
    const stale = await request({
      account: fresh.address,
      signer: fresh,
      keyHash: ROOT_KEY_HASH,
      calls: [init],
      authorization: await authorize(1),
    });
    expect(await rejection(stale)).toBe(SponsorRejectCode.AUTHORIZATION_INVALID);
  }, 60_000);

  it("rejects an unregistered session key", async () => {
    const stranger = new PrivateKeySigner(generatePrivateKey());
    const params = await request({
      signer: stranger,
      keyHash: secp256k1KeyHash(stranger.address),
      calls: [approve(PAD)],
    });
    expect(await rejection(params)).toBe(SponsorRejectCode.KEY_NOT_REGISTERED);
  }, 60_000);

  it("rejects a batch the session key did not sign, though the request is signed by it", async () => {
    const params = await request({
      signer: new PrivateKeySigner(generatePrivateKey()),
      requestSigner: session,
      keyHash,
      calls: [approve(PAD)],
    });
    expect(await rejection(params)).toBe(SponsorRejectCode.BAD_BATCH_SIGNATURE);
  }, 60_000);

  it("refuses a batch its own simulation reverts, whatever the client checked", async () => {
    const params = await request({ signer: session, keyHash, calls: [approve(OTHER_SPENDER)] });
    expect(await rejection(params)).toBe(SponsorRejectCode.SIMULATION_FAILED);
  }, 60_000);

  it("rejects a session request for an account whose safe initialisation is incomplete", async () => {
    // Delegated without `approveNative(ERC20ETH, 0)`: the DELEGATED state.
    await relayer.submit({
      account: halfInit.address,
      keyHash: ROOT_KEY_HASH,
      calls: [],
      lane: 0n,
      signer: halfInit,
      deadline: BigInt(nowSeconds() + 600),
      authorization: await halfInit.signAuthorization({
        address: book.caliburEntry,
        chainId: 5003,
        nonce: 0,
      }),
    });
    const agent = new PrivateKeySigner(generatePrivateKey());
    const params = await request({
      account: halfInit.address,
      signer: agent,
      keyHash: secp256k1KeyHash(agent.address),
      calls: [approve(PAD)],
    });
    expect(await rejection(params)).toBe(SponsorRejectCode.ACCOUNT_NOT_INITIALIZED);
  }, 60_000);

  it("checks the persisted daily counters", async () => {
    const day = dayOf(nowSeconds());
    const full = { gas: config.policy.accountDailyGas, fee: 0n };
    store.add(day, root.address, "business", full);
    try {
      const params = await request({ signer: session, keyHash, calls: [approve(PAD)] });
      expect(await rejection(params)).toBe(SponsorRejectCode.ACCOUNT_GAS_CAP);
    } finally {
      store.add(day, root.address, "business", { gas: -full.gas, fee: 0n });
    }
  }, 60_000);

  it("answers over HTTP: SUBMISSION_UNAVAILABLE without a relayer, the ledger's result with one", async () => {
    const params = await request({ signer: session, keyHash, calls: [approve(PAD)] });
    const call = async (ledger?: RelaySubmitter) => {
      const server = createSponsorServer({ ...ctx, ...(ledger ? { ledger } : {}) });
      const base = await server.listen();
      try {
        const res = await fetch(base, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sponsor_relay",
            params: [params],
          }),
        });
        return (await res.json()) as { result?: unknown; error?: { code: number; data: unknown } };
      } finally {
        await server.close();
      }
    };
    expect((await call()).error).toMatchObject({
      code: SPONSOR_REJECTED_RPC_CODE,
      data: { reason: SponsorRejectCode.SUBMISSION_UNAVAILABLE },
    });
    const ledger: RelaySubmitter = {
      find: () => undefined,
      relay: async (d) => ({ status: "pending", batchDigest: d.batchDigest }),
    };
    expect((await call(ledger)).result).toEqual({
      status: "pending",
      batchDigest: (await authorizeRelay(ctx, params)).batchDigest,
    });
  }, 60_000);

  it("rejects a session the hook no longer marks active", async () => {
    await account.grantSession(policy, { agentName: "paused" });
    const paused = getProfile("paused", keystore).keyHash;
    await account.exec([
      {
        to: book.agentPolicyHook,
        value: 0n,
        data: encodeFunctionData({
          abi: agentPolicyHookAbi,
          functionName: "revoke",
          args: [paused],
        }),
      },
    ]);
    const params = await request({
      signer: loadProfileSigner("paused", keystore),
      keyHash: paused,
      calls: [approve(PAD)],
    });
    expect(await rejection(params)).toBe(SponsorRejectCode.KEY_INACTIVE);
  }, 120_000);

  // Last: it moves the fork's clock forward.
  it("rejects a session key whose Calibur expiry has passed", async () => {
    const { timestamp } = await client.getBlock();
    await account.grantSession(policy, { agentName: "brief", expiry: Number(timestamp) + 60 });
    const brief = getProfile("brief", keystore).keyHash;
    await client.request({ method: "evm_increaseTime" as never, params: [120] as never });
    await client.request({ method: "evm_mine" as never });
    const params = await request({
      signer: loadProfileSigner("brief", keystore),
      keyHash: brief,
      calls: [approve(PAD)],
    });
    expect(await rejection(params)).toBe(SponsorRejectCode.KEY_EXPIRED);
  }, 120_000);
});
