import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, encodeFunctionData, getAddress, parseAbi, zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentSession,
  agentPolicyHookAbi,
  type Call,
  DeadlineOutOfRangeError,
  ExecutionRevertedError,
  erc20Abi,
  getProfile,
  InventoryExceededError,
  KeyExpiredError,
  LimitExceededError,
  laneOf,
  launchpadAbi,
  loadDeployments,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  PolicyViolationError,
  PrivateKeySigner,
  RuleKind,
  SELECTORS,
} from "../../src/index.js";
import {
  clientFor,
  mockUsdAbi,
  RELAYER,
  startFork,
  TestRelayer,
  walletFor,
} from "../account/fork.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const usd = (n: number) => BigInt(n) * 10n ** 6n;
const UNIT = 10n ** 21n; // MockLaunchpad: 1 mUSD buys 1e21 meme units

const policy: Policy = {
  maxValuePerCall: 0n,
  mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
  quoteLimits: [{ token: USD, totalCap: usd(1000), periodCap: usd(500) }],
  periodLength: 86400,
  permissions: [
    { target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE },
    { target: PAD, selector: SELECTORS.buy, ruleKind: RuleKind.LAUNCHPAD_BUY },
    { target: PAD, selector: SELECTORS.sell, ruleKind: RuleKind.LAUNCHPAD_SELL },
  ],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
};

describe.skipIf(!rpcUrl)("AgentSession on a Mantle Sepolia fork", () => {
  let url: string;
  let stop: () => void;
  let client: ReturnType<typeof clientFor>;

  beforeAll(async () => {
    ({ url, stop } = await startFork(rpcUrl as string));
    client = clientFor(url);
  }, 60_000);
  afterAll(() => stop?.(), 30_000);

  it("executes passing batches and rejects each violation locally without sending", async () => {
    const relayer = new TestRelayer(url, book);
    const keystore = {
      home: mkdtempSync(join(tmpdir(), "mantle-aa-session-")),
      password: "test",
      scrypt: { n: 1024, r: 8, p: 1 },
    };
    const root = new PrivateKeySigner(generatePrivateKey());
    const account = new MantleAccount({
      client,
      root,
      executor: relayer,
      addresses: book,
      keystore,
    });
    await account.init({ grant: { policy, agentName: "agent" } });
    const me = account.address;
    const mint = await walletFor(url, RELAYER).writeContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "mint",
      args: [me, usd(1000)],
    });
    await client.waitForTransactionReceipt({ hash: mint });

    const { keyHash } = getProfile("agent", keystore);
    const session = new AgentSession({
      client,
      account: me,
      keyHash,
      signer: loadProfileSigner("agent", keystore),
      executor: relayer,
      addresses: book,
    });

    const now = async () => (await client.getBlock()).timestamp;
    const approve = (amount: bigint): Call => ({
      to: USD,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAD, amount] }),
    });
    const trade = async (fn: "buy" | "sell", amount: bigint, deadline?: bigint): Promise<Call> => ({
      to: PAD,
      value: 0n,
      data: encodeFunctionData({
        abi: launchpadAbi,
        functionName: fn,
        args: [MEME, amount, 0n, deadline ?? (await now()) + 60n, me],
      }),
    });
    const hookRead = (functionName: "inventory" | "remainingLimit", token: Address) =>
      client.readContract({
        address: book.agentPolicyHook,
        abi: agentPolicyHookAbi,
        functionName: functionName as "inventory",
        args: [keyHash, me, token],
      });
    const relayerTxs = () => client.getTransactionCount({ address: RELAYER.address });

    /** The rejection carries the expected type, and neither the executor nor the chain saw a batch. */
    const rejectsLocally = async <E extends Error>(
      calls: Call[],
      type: new (...args: never[]) => E,
    ): Promise<E> => {
      const [requests, txs] = [relayer.requests.length, await relayerTxs()];
      const error = await session.exec(calls).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect(relayer.requests).toHaveLength(requests);
      expect(await relayerTxs()).toBe(txs);
      return error as E;
    };

    // A passing batch lands on the key's lane with a 2-minute SignedBatchedCall deadline.
    const bought = await session.exec([approve(usd(100)), await trade("buy", usd(100))], {
      via: "relayer",
    });
    expect(bought.success).toBe(true);
    const request = relayer.requests.at(-1);
    expect(request?.keyHash).toBe(keyHash);
    expect(request?.lane).toBe(laneOf(keyHash));
    expect(Number(request?.deadline) - Math.floor(Date.now() / 1000)).toBeGreaterThan(100);
    expect(await hookRead("inventory", MEME)).toBe(100n * UNIT);

    // Outside the allowlist: transfer on the quote asset.
    const transfer: Call = {
      to: USD,
      value: 0n,
      data: encodeFunctionData({
        abi: parseAbi(["function transfer(address to, uint256 amount)"]),
        args: [PAD, 1n],
      }),
    };
    const outside = await rejectsLocally([approve(1n), transfer], PolicyViolationError);
    expect(outside.callIndex).toBe(1);

    // Over the limit: 400 of the 500 period cap is left, as the hook reports.
    const remaining = await hookRead("remainingLimit", USD);
    expect(remaining).toBe(usd(400));
    const over = await rejectsLocally([approve(usd(401))], LimitExceededError);
    expect(over).toMatchObject({ asset: getAddress(USD), remaining, requested: usd(401) });

    // Insufficient inventory.
    const held = await hookRead("inventory", MEME);
    const short = await rejectsLocally([await trade("sell", held + 1n)], InventoryExceededError);
    expect(short).toMatchObject({ token: MEME, held, requested: held + 1n });

    // Deadline out of range, on both ends.
    await rejectsLocally([await trade("sell", 1n, (await now()) + 601n)], DeadlineOutOfRangeError);
    await rejectsLocally([await trade("buy", 1n, (await now()) - 1n)], DeadlineOutOfRangeError);

    // Passes every local rule but fails on chain (no allowance left): the eth_call catches it.
    const reverted = await rejectsLocally([await trade("buy", usd(1))], ExecutionRevertedError);
    expect(reverted.reason).toBe("CallFailed()");

    // Selling the attributed inventory passes.
    expect((await session.exec([await trade("sell", held)])).success).toBe(true);
    expect(await hookRead("inventory", MEME)).toBe(0n);

    // A revoked session is refused locally.
    await account.revokeSession(keyHash);
    await rejectsLocally([approve(1n)], PolicyViolationError);

    // An expired key: grant one expiring in 60 s, then move the fork past it.
    const expiry = Number(await now()) + 60;
    const grant = await account.grantSession(policy, { agentName: "brief", expiry });
    const brief = new AgentSession({
      client,
      account: me,
      keyHash: grant.keyHash,
      signer: loadProfileSigner("brief", keystore),
      executor: relayer,
      addresses: book,
    });
    await brief.simulate([approve(1n)]);
    await client.request({ method: "evm_increaseTime" as never, params: [120] as never });
    await client.request({ method: "evm_mine" as never });
    const [requests, txs] = [relayer.requests.length, await relayerTxs()];
    const expired = await brief.exec([approve(1n)]).catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(KeyExpiredError);
    expect(expired).toMatchObject({ keyHash: grant.keyHash.toLowerCase(), expiry });
    expect(relayer.requests).toHaveLength(requests);
    expect(await relayerTxs()).toBe(txs);
  }, 240_000);
});
