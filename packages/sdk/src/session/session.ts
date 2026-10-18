import {
  type Abi,
  type AbiParameter,
  type Address,
  BaseError,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  decodeAbiParameters,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  type Hex,
  isHex,
  parseAbi,
  parseAbiParameters,
  slice,
  zeroAddress,
} from "viem";
import { call, getBlock, getCode, readContract } from "viem/actions";
import { agentPolicyHookAbi, caliburAbi, erc20Abi } from "../account/abi.js";
import { type Call, type ExecResult, type Executor, laneOf } from "../account/executor.js";
import { RuleKind } from "../account/policy.js";
import { type AddressBook, loadDeployments } from "../deployments.js";
import { delegationDesignator } from "../domain.js";
import {
  DeadlineOutOfRangeError,
  ExecutionRevertedError,
  InventoryExceededError,
  KeyExpiredError,
  LimitExceededError,
  PolicyViolationError,
} from "../errors.js";
import { secp256k1KeyHash } from "../keystore.js";
import type { Signer } from "../signer.js";

/** Agent SignedBatchedCalls expire 2 minutes after signing (docs/DESIGN.md §5.1). */
export const SESSION_DEADLINE_SECONDS = 120;

const sessionAbi = parseAbi([
  "struct Call { address to; uint256 value; bytes data; }",
  "struct BatchedCall { Call[] calls; bool revertOnFailure; }",
  // Calibur: a key executing as itself (`msg.sender.toKeyHash()`) runs the execution hooks.
  "function execute(BatchedCall batchedCall) payable",
  "function quoteToken() view returns (address)",
  // Reverts a session batch can produce (Calibur v1.1.0, AgentPolicyHook execution hooks).
  "error Unauthorized()",
  "error OnlyAdminCanSelfCall()",
  "error OnlyAdminCanCallEntryPoint()",
  "error Reentrancy()",
  "error SessionInactive()",
  "error TargetIsHook()",
  "error CallNotPermitted(address to, bytes4 selector)",
  "error ValueExceeded(uint256 value, uint256 maxValuePerCall)",
  "error LimitExceeded(address token)",
  "error NotQuoteAsset(address token)",
  "error UntrustedSpender(address spender)",
  "error RecipientNotAccount(address recipient)",
  "error DeadlineOutOfRange(uint256 deadline)",
  "error QuoteAssetNotTradable(address token)",
  "error InventoryExceeded(address token, uint256 held)",
  "error AttributionGap(address token)",
  "error CallFailed()",
  "error PartialFill(address token)",
]);

const approveArgs = parseAbiParameters("address spender, uint256 amount");
const tradeArgs = parseAbiParameters(
  "address token, uint256 amount, uint256 minOut, uint256 deadline, address recipient",
);

const MASK_160 = (1n << 160n) - 1n;

export interface AgentSessionOptions {
  client: Client;
  account: Address;
  /** The session key's Calibur keyHash; must be the signer's secp256k1 keyHash. */
  keyHash: Hex;
  signer: Signer;
  /** Needed by `exec` only. */
  executor?: Executor;
  /** Defaults to the committed Mantle Sepolia address book. */
  addresses?: AddressBook;
}

/**
 * An agent's view of one session key: `simulate` replicates the hook's rules locally and then
 * runs the batch in an `eth_call`; `exec` submits only batches that pass.
 */
export class AgentSession {
  readonly account: Address;
  readonly keyHash: Hex;
  readonly addresses: AddressBook;
  readonly #client: Client;
  readonly #signer: Signer;
  readonly #executor: Executor | undefined;

  constructor(options: AgentSessionOptions) {
    if (secp256k1KeyHash(options.signer.address) !== options.keyHash.toLowerCase()) {
      throw new Error(`Signer ${options.signer.address} is not session key ${options.keyHash}`);
    }
    this.#client = options.client;
    this.#signer = options.signer;
    this.#executor = options.executor;
    this.account = getAddress(options.account);
    this.keyHash = options.keyHash.toLowerCase() as Hex;
    this.addresses = options.addresses ?? loadDeployments();
  }

  /**
   * Checks the batch against the key's Calibur settings and the hook policy as of the latest
   * block, call by call (spending and inventory accumulate across the batch), then runs it in an
   * `eth_call` as the key itself. Throws the structured error of the first rejection; sends
   * nothing. A BUY earlier in the batch is not credited to a later SELL's inventory (fail closed).
   */
  async simulate(calls: readonly Call[]): Promise<void> {
    const hook = this.addresses.agentPolicyHook;
    const code = (await getCode(this.#client, { address: this.account }))?.toLowerCase();
    if (code !== delegationDesignator(this.addresses.caliburEntry)) {
      throw new PolicyViolationError({ reason: `Account ${this.account} is not delegated` });
    }
    const [block, registered, summary, [policy]] = await Promise.all([
      getBlock(this.#client),
      this.#read(this.account, caliburAbi, "isRegistered", [this.keyHash]),
      this.#read(hook, agentPolicyHookAbi, "getSummary", [this.keyHash, this.account]),
      this.#read(hook, agentPolicyHookAbi, "getPolicy", [this.keyHash, this.account]),
    ]);
    if (!registered) {
      throw new PolicyViolationError({ reason: "Session key is not registered on the account" });
    }
    const now = block.timestamp;
    const settings = await this.#read(this.account, caliburAbi, "getKeySettings", [this.keyHash]);
    const expiry = Number((settings >> 160n) & 0xffffffffffn);
    if (expiry !== 0 && BigInt(expiry) < now) {
      throw new KeyExpiredError({ keyHash: this.keyHash, expiry });
    }
    const isAdmin = ((settings >> 200n) & 1n) === 1n;
    if (isAdmin || BigInt(hook) !== (settings & MASK_160)) {
      throw new PolicyViolationError({ reason: "Key is not a session key under the policy hook" });
    }
    if (summary.revoked) throw new PolicyViolationError({ reason: "Session is revoked" });
    if (!summary.active) throw new PolicyViolationError({ reason: "Session is not active" });

    const isQuote = (token: Address) =>
      policy.quoteLimits.some((q) => getAddress(q.token) === token);
    const remaining = new Map<Address, bigint>();
    const limitLeft = async (asset: Address) =>
      remaining.get(asset) ??
      (await this.#read(hook, agentPolicyHookAbi, "remainingLimit", [
        this.keyHash,
        this.account,
        asset,
      ]));
    const spend = async (asset: Address, amount: bigint) => {
      const left = await limitLeft(asset);
      if (amount > left)
        throw new LimitExceededError({ asset, remaining: left, requested: amount });
      remaining.set(asset, left - amount);
    };
    const held = new Map<Address, bigint>();

    for (const [i, c] of calls.entries()) {
      const violation = (reason: string) => new PolicyViolationError({ reason, callIndex: i });
      const to = getAddress(c.to);
      if (to === zeroAddress || to === this.account)
        throw violation("Session keys cannot self-call");
      if (to === this.addresses.entryPoint)
        throw violation("Session keys cannot call the EntryPoint");
      if (to === hook) throw violation("Session keys cannot call the policy hook");
      // The hook reads `bytes4(data)`: shorter calldata is zero-padded.
      const selector = `${c.data}00000000`.slice(0, 10).toLowerCase();
      const permission = policy.permissions.find(
        (p) => getAddress(p.target) === to && p.selector.toLowerCase() === selector,
      );
      if (!permission) throw violation(`${to} ${selector} is not a permitted call`);

      if (c.value > policy.maxValuePerCall) {
        throw new LimitExceededError({
          asset: zeroAddress,
          remaining: policy.maxValuePerCall,
          requested: c.value,
        });
      }
      if (c.value > 0n) await spend(zeroAddress, c.value);

      if (permission.ruleKind === RuleKind.ERC20_APPROVE) {
        const [spender, amount] = decodeArgs(approveArgs, c.data, i);
        if (!isQuote(to)) throw violation(`${to} is not a quote asset`);
        if (!policy.trustedSpenders.some((s) => getAddress(s) === getAddress(spender))) {
          throw violation(`${spender} is not a trusted spender`);
        }
        const left = await limitLeft(to);
        if (amount > left)
          throw new LimitExceededError({ asset: to, remaining: left, requested: amount });
      } else if (
        permission.ruleKind === RuleKind.LAUNCHPAD_BUY ||
        permission.ruleKind === RuleKind.LAUNCHPAD_SELL
      ) {
        const [rawToken, amount, , deadline, recipient] = decodeArgs(tradeArgs, c.data, i);
        const token = getAddress(rawToken);
        if (getAddress(recipient) !== this.account) {
          throw violation(`Recipient ${recipient} is not the account`);
        }
        const maxDeadline = now + BigInt(policy.maxDeadlineWindow);
        if (deadline < now || deadline > maxDeadline) {
          throw new DeadlineOutOfRangeError({
            deadline: Number(deadline),
            minDeadline: Number(now),
            maxDeadline: Number(maxDeadline),
          });
        }
        if (isQuote(token)) throw violation(`Quote asset ${token} cannot be traded`);
        if (permission.ruleKind === RuleKind.LAUNCHPAD_BUY) {
          const quote = getAddress(await this.#read(to, sessionAbi, "quoteToken", []));
          if (!isQuote(quote)) throw violation(`Launchpad quote asset ${quote} has no limit`);
          await spend(quote, amount);
        } else {
          const inventory =
            held.get(token) ??
            (await this.#read(hook, agentPolicyHookAbi, "inventory", [
              this.keyHash,
              this.account,
              token,
            ]));
          if (amount > inventory) {
            throw new InventoryExceededError({ token, held: inventory, requested: amount });
          }
          const [balance, reserved] = await Promise.all([
            this.#read(token, erc20Abi, "balanceOf", [this.account]),
            this.#read(hook, agentPolicyHookAbi, "reserved", [this.account, token]),
          ]);
          if (balance < reserved) throw violation(`Attribution gap on ${token}`);
          held.set(token, inventory - amount);
        }
      }
    }

    try {
      await call(this.#client, {
        account: this.#signer.address,
        to: this.account,
        data: encodeFunctionData({
          abi: sessionAbi,
          functionName: "execute",
          args: [{ calls: calls.map((c) => ({ ...c })), revertOnFailure: true }],
        }),
      });
    } catch (error) {
      // As viem's internal getRevertErrorData: the revert data sits on the deepest cause.
      const cause = error instanceof BaseError ? (error.walk() as { data?: unknown }) : undefined;
      const raw = cause?.data;
      const data = typeof raw === "object" ? (raw as { data?: unknown } | null)?.data : raw;
      if (!isHex(data)) throw error;
      const reason = revertReason(data);
      throw new ExecutionRevertedError({ data, ...(reason ? { reason } : {}) });
    }
  }

  /**
   * Simulates the batch and, only if it passes, submits it through the executor on this key's
   * nonce lane with a SignedBatchedCall deadline 2 minutes out.
   */
  async exec(
    calls: readonly Call[],
    options: { via?: Executor["kind"] } = {},
  ): Promise<ExecResult> {
    const executor = this.#executor;
    if (!executor) throw new Error("AgentSession has no executor");
    if (options.via && options.via !== executor.kind) {
      throw new Error(`The configured executor is a ${executor.kind}, not a ${options.via}`);
    }
    await this.simulate(calls);
    const result = await executor.submit({
      account: this.account,
      keyHash: this.keyHash,
      calls,
      lane: laneOf(this.keyHash),
      signer: this.#signer,
      deadline: BigInt(Math.floor(Date.now() / 1000) + SESSION_DEADLINE_SECONDS),
    });
    if (!result.success) {
      throw new ExecutionRevertedError({ reason: `Transaction ${result.hash} reverted` });
    }
    return result;
  }

  #read<
    const abi extends Abi,
    functionName extends ContractFunctionName<abi, "pure" | "view">,
    const args extends ContractFunctionArgs<abi, "pure" | "view", functionName>,
  >(
    address: Address,
    abi: abi,
    functionName: functionName,
    args: args,
  ): Promise<ContractFunctionReturnType<abi, "pure" | "view", functionName, args>> {
    return readContract(this.#client, { address, abi, functionName, args } as never) as never;
  }
}

/** The hook decodes the arguments with `abi.decode`; calldata it cannot decode is rejected. */
function decodeArgs<const params extends readonly AbiParameter[]>(
  params: params,
  data: Hex,
  callIndex: number,
) {
  try {
    return decodeAbiParameters(params, slice(data, 4));
  } catch {
    throw new PolicyViolationError({ reason: "Malformed calldata", callIndex });
  }
}

/** `ErrorName(args…)` of a known revert, else undefined. */
function revertReason(data: Hex): string | undefined {
  try {
    const { errorName, args } = decodeErrorResult({ abi: sessionAbi, data });
    return `${errorName}(${(args ?? []).map(String).join(", ")})`;
  } catch {
    return undefined;
  }
}
