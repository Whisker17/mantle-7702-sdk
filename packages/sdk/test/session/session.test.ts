import {
  type Abi,
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Hex,
  numberToHex,
  parseAbi,
  zeroAddress,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentSession,
  agentPolicyHookAbi,
  type Call,
  caliburAbi,
  DeadlineOutOfRangeError,
  delegationDesignator,
  type ExecRequest,
  ExecutionRevertedError,
  type Executor,
  erc20Abi,
  InventoryExceededError,
  KeyExpiredError,
  LimitExceededError,
  laneOf,
  launchpadAbi,
  loadDeployments,
  type Policy,
  PolicyViolationError,
  PrivateKeySigner,
  RuleKind,
  SELECTORS,
  secp256k1KeyHash,
} from "../../src/index.js";

const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const ACCOUNT = getAddress("0x00000000000000000000000000000000000acc01");
const OTHER = getAddress("0x00000000000000000000000000000000000b0b00");
const NOW = 1_800_000_000n;

const extraAbi = parseAbi([
  "struct Call { address to; uint256 value; bytes data; }",
  "struct BatchedCall { Call[] calls; bool revertOnFailure; }",
  "function execute(BatchedCall batchedCall) payable",
  "function quoteToken() view returns (address)",
  "error LimitExceeded(address token)",
]);
const abis: Abi[] = [caliburAbi, agentPolicyHookAbi, erc20Abi, extraAbi];

const policy = (): Policy => ({
  maxValuePerCall: 10n,
  mntLimit: { token: zeroAddress, totalCap: 15n, periodCap: 15n },
  quoteLimits: [{ token: USD, totalCap: 1000n, periodCap: 500n }],
  periodLength: 86400,
  permissions: [
    { target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE },
    { target: PAD, selector: SELECTORS.buy, ruleKind: RuleKind.LAUNCHPAD_BUY },
    { target: PAD, selector: SELECTORS.sell, ruleKind: RuleKind.LAUNCHPAD_SELL },
    { target: OTHER, selector: "0x12345678", ruleKind: RuleKind.NONE },
  ],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
});

/** In-memory chain state that answers the reads `simulate` makes. */
interface Chain {
  delegated: boolean;
  registered: boolean;
  settings: bigint;
  summary: { initialized: boolean; active: boolean; revoked: boolean };
  policy: Policy;
  remaining: Record<string, bigint>;
  inventory: bigint;
  balance: bigint;
  reserved: bigint;
  /** Revert data for the final `eth_call`, if it should revert. */
  revert?: Hex;
}

const signer = new PrivateKeySigner(generatePrivateKey());
const keyHash = secp256k1KeyHash(signer.address);
const settingsFor = (expiry: bigint, hook: Address = book.agentPolicyHook) =>
  BigInt(hook) | (expiry << 160n);

let chain: Chain;
let simulatedCalls: number;

const client = createClient({
  transport: custom({
    async request({ method, params }) {
      if (method === "eth_getCode") {
        return chain.delegated ? delegationDesignator(book.caliburEntry) : "0x";
      }
      if (method === "eth_getBlockByNumber") {
        return { number: "0x1", timestamp: numberToHex(NOW), hash: `0x${"11".repeat(32)}` };
      }
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = (params as [{ to: Address; data: Hex }])[0];
      for (const abi of abis) {
        let decoded: { functionName: string; args?: readonly unknown[] };
        try {
          decoded = decodeFunctionData({ abi, data }) as never;
        } catch {
          continue;
        }
        const result = answer(getAddress(to), decoded.functionName, decoded.args ?? []);
        return encodeFunctionResult({
          abi,
          functionName: decoded.functionName,
          result,
        } as never);
      }
      throw new Error(`unknown call ${data.slice(0, 10)}`);
    },
  }),
});

function answer(to: Address, fn: string, args: readonly unknown[]): unknown {
  switch (fn) {
    case "isRegistered":
      return chain.registered;
    case "getKeySettings":
      return chain.settings;
    case "getSummary":
      return chain.summary;
    case "getPolicy":
      return [chain.policy, 0];
    case "remainingLimit":
      return chain.remaining[getAddress(args[2] as Address)] ?? 0n;
    case "inventory":
      return chain.inventory;
    case "reserved":
      return chain.reserved;
    case "balanceOf":
      return chain.balance;
    case "quoteToken":
      return USD;
    case "execute":
      simulatedCalls++;
      if (chain.revert)
        throw Object.assign(new Error("execution reverted"), { data: chain.revert });
      return undefined;
  }
  throw new Error(`unexpected ${fn} on ${to}`);
}

/** Records submissions; a rejected batch must leave it empty. */
class RecordingExecutor implements Executor {
  readonly kind = "relayer" as const;
  readonly requests: ExecRequest[] = [];
  async submit(request: ExecRequest) {
    this.requests.push(request);
    return { hash: `0x${"ab".repeat(32)}` as Hex, success: true };
  }
}

const approve = (spender: Address, amount: bigint): Call => ({
  to: USD,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});
const trade = (
  fn: "buy" | "sell",
  amount: bigint,
  over: { token?: Address; deadline?: bigint; recipient?: Address } = {},
): Call => ({
  to: PAD,
  value: 0n,
  data: encodeFunctionData({
    abi: launchpadAbi,
    functionName: fn,
    args: [over.token ?? MEME, amount, 0n, over.deadline ?? NOW + 60n, over.recipient ?? ACCOUNT],
  }),
});

describe("AgentSession.simulate / exec (scripted chain)", () => {
  let executor: RecordingExecutor;
  let session: AgentSession;

  beforeEach(() => {
    chain = {
      delegated: true,
      registered: true,
      settings: settingsFor(NOW + 3600n),
      summary: { initialized: true, active: true, revoked: false },
      policy: policy(),
      remaining: { [USD]: 500n, [zeroAddress]: 15n },
      inventory: 100n,
      balance: 100n,
      reserved: 100n,
    };
    simulatedCalls = 0;
    executor = new RecordingExecutor();
    session = new AgentSession({
      client,
      account: ACCOUNT,
      keyHash,
      signer,
      executor,
      addresses: book,
    });
  });

  /** Runs `exec`, expects `type`, and proves nothing was simulated on chain or submitted. */
  const rejects = async <E extends Error>(
    calls: Call[],
    type: new (...args: never[]) => E,
  ): Promise<E> => {
    const error = await session.exec(calls).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect(executor.requests).toHaveLength(0);
    expect(simulatedCalls).toBe(0);
    return error as E;
  };

  it("submits a passing batch on the key's lane with a 2-minute deadline", async () => {
    const before = Math.floor(Date.now() / 1000);
    const calls = [approve(PAD, 400n), trade("buy", 400n), trade("sell", 100n)];
    await session.exec(calls, { via: "relayer" });
    expect(simulatedCalls).toBe(1);
    expect(executor.requests).toHaveLength(1);
    const [request] = executor.requests;
    expect(request).toMatchObject({ account: ACCOUNT, keyHash, calls, signer });
    expect(request?.lane).toBe(BigInt(keyHash) >> 64n);
    expect(request?.lane).toBe(laneOf(keyHash));
    expect(request?.lane).toBeLessThan(1n << 192n);
    expect(Number(request?.deadline) - before).toBeGreaterThanOrEqual(120);
    expect(Number(request?.deadline) - before).toBeLessThanOrEqual(121);
  });

  it("rejects a call outside the allowlist with its call index", async () => {
    const transfer: Call = { to: USD, value: 0n, data: "0xa9059cbb" };
    const error = await rejects([approve(PAD, 1n), transfer], PolicyViolationError);
    expect(error.callIndex).toBe(1);
    // An unknown target, and the hook itself, are outside it too.
    await rejects([{ to: MEME, value: 0n, data: SELECTORS.approve }], PolicyViolationError);
    await rejects([{ to: book.agentPolicyHook, value: 0n, data: "0x" }], PolicyViolationError);
  });

  it("rejects an approve over the remaining limit and spending across the batch", async () => {
    const error = await rejects([approve(PAD, 501n)], LimitExceededError);
    expect(error).toMatchObject({ asset: USD, remaining: 500n, requested: 501n });
    // Two buys of 300 exceed the remaining 500 together.
    const second = await rejects(
      [approve(PAD, 500n), trade("buy", 300n), trade("buy", 300n)],
      LimitExceededError,
    );
    expect(second).toMatchObject({ asset: USD, remaining: 200n, requested: 300n });
  });

  it("rejects MNT value over the per-call cap and over the MNT limit", async () => {
    const call = (value: bigint): Call => ({ to: OTHER, value, data: "0x12345678" });
    const error = await rejects([call(11n)], LimitExceededError);
    expect(error).toMatchObject({ asset: zeroAddress, remaining: 10n, requested: 11n });
    const total = await rejects([call(10n), call(6n)], LimitExceededError);
    expect(total).toMatchObject({ asset: zeroAddress, remaining: 5n, requested: 6n });
  });

  it("rejects approve parameter violations", async () => {
    await rejects([approve(OTHER, 1n)], PolicyViolationError); // untrusted spender
    await rejects([{ ...approve(PAD, 1n), data: SELECTORS.approve }], PolicyViolationError);
  });

  it("rejects a SELL over the key's inventory, also across the batch", async () => {
    const error = await rejects([trade("sell", 101n)], InventoryExceededError);
    expect(error).toMatchObject({ token: MEME, held: 100n, requested: 101n });
    const twice = await rejects([trade("sell", 60n), trade("sell", 60n)], InventoryExceededError);
    expect(twice).toMatchObject({ held: 40n, requested: 60n });
    // A BUY earlier in the batch is not credited.
    chain.inventory = 0n;
    await rejects(
      [approve(PAD, 10n), trade("buy", 10n), trade("sell", 1n)],
      InventoryExceededError,
    );
  });

  it("rejects a SELL on an attribution gap", async () => {
    chain.balance = 99n;
    await rejects([trade("sell", 1n)], PolicyViolationError);
  });

  it("rejects deadlines outside [now, now + maxDeadlineWindow]", async () => {
    for (const fn of ["buy", "sell"] as const) {
      const late = await rejects(
        [trade(fn, 1n, { deadline: NOW + 601n })],
        DeadlineOutOfRangeError,
      );
      expect(late).toMatchObject({
        deadline: Number(NOW + 601n),
        minDeadline: Number(NOW),
        maxDeadline: Number(NOW + 600n),
      });
      await rejects([trade(fn, 1n, { deadline: NOW - 1n })], DeadlineOutOfRangeError);
    }
    // Both ends are inclusive.
    await session.simulate([
      trade("sell", 1n, { deadline: NOW }),
      trade("sell", 1n, { deadline: NOW + 600n }),
    ]);
  });

  it("rejects a trade to another recipient or of a quote asset", async () => {
    await rejects([trade("buy", 1n, { recipient: OTHER })], PolicyViolationError);
    await rejects([trade("sell", 1n, { token: USD })], PolicyViolationError);
  });

  it("rejects an expired key", async () => {
    chain.settings = settingsFor(NOW - 1n);
    const error = await rejects([approve(PAD, 1n)], KeyExpiredError);
    expect(error).toMatchObject({ keyHash, expiry: Number(NOW - 1n) });
    // Expiry equal to now is still valid (Calibur: expired iff expiry < block.timestamp).
    chain.settings = settingsFor(NOW);
    await session.simulate([approve(PAD, 1n)]);
  });

  it("rejects revoked, inactive, unregistered, unhooked keys and undelegated accounts", async () => {
    chain.summary = { initialized: true, active: false, revoked: true };
    await rejects([approve(PAD, 1n)], PolicyViolationError);
    chain.summary = { initialized: false, active: false, revoked: false };
    await rejects([approve(PAD, 1n)], PolicyViolationError);
    chain.summary = { initialized: true, active: true, revoked: false };
    chain.settings = settingsFor(NOW + 60n, OTHER);
    await rejects([approve(PAD, 1n)], PolicyViolationError);
    chain.registered = false;
    await rejects([approve(PAD, 1n)], PolicyViolationError);
    chain.delegated = false;
    await rejects([approve(PAD, 1n)], PolicyViolationError);
  });

  it("reports an eth_call revert as ExecutionRevertedError and sends nothing", async () => {
    chain.revert = encodeErrorResult({
      abi: extraAbi,
      errorName: "LimitExceeded",
      args: [USD],
    });
    const error = await session.exec([approve(PAD, 1n)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutionRevertedError);
    expect(error).toMatchObject({ data: chain.revert, reason: `LimitExceeded(${USD})` });
    expect(executor.requests).toHaveLength(0);
  });

  it("refuses a signer that is not the session key, and a mismatched transport", async () => {
    const other = new PrivateKeySigner(generatePrivateKey());
    expect(() => new AgentSession({ client, account: ACCOUNT, keyHash, signer: other })).toThrow(
      /is not session key/,
    );
    await expect(session.exec([approve(PAD, 1n)], { via: "bundler" })).rejects.toThrow(
      /relayer, not a bundler/,
    );
    const noExecutor = new AgentSession({
      client,
      account: ACCOUNT,
      keyHash,
      signer,
      addresses: book,
    });
    await expect(noExecutor.exec([approve(PAD, 1n)])).rejects.toThrow(/no executor/);
  });
});
