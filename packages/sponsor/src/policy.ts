import {
  agentPolicyHookAbi,
  caliburAbi,
  erc20Abi,
  SponsorRejectCode,
} from "@0xwh1sker/mantle-aa-sdk";
import {
  type Address,
  BaseError,
  type Client,
  decodeFunctionData,
  getAddress,
  type Hex,
  type SignedAuthorization,
  toFunctionSelector,
} from "viem";
import { estimateFeesPerGas, estimateGas } from "viem/actions";
import type { SignedBatchedCall } from "./auth.js";
import { reject } from "./auth.js";
import type { SponsorConfig } from "./config.js";
import { relayerFeeBound } from "./fees.js";
import type { BudgetClass, DailyUsage } from "./store.js";

/**
 * Management calls: what init, grant, update, revoke and panic batches consist of. A root batch
 * made only of these draws on the management budget; anything else is business.
 */
const MANAGEMENT_SELF = ["approveNative", "register", "update", "revoke"].map((name) =>
  toFunctionSelector(caliburAbi.find((f) => f.type === "function" && f.name === name) as never),
);
const MANAGEMENT_HOOK = ["setPolicy", "updatePolicy", "revoke", "releaseInventory"].map((name) =>
  toFunctionSelector(
    agentPolicyHookAbi.find((f) => f.type === "function" && f.name === name) as never,
  ),
);

/** Which budget a batch draws on: session batches are always business. */
export function classify(
  batch: Pick<SignedBatchedCall, "keyHash" | "batchedCall">,
  account: Address,
  config: SponsorConfig,
): BudgetClass {
  if (BigInt(batch.keyHash) !== 0n || batch.batchedCall.calls.length === 0) return "business";
  const management = batch.batchedCall.calls.every(({ to, value, data }) => {
    if (value !== 0n) return false;
    const selector = data.slice(0, 10).toLowerCase() as Hex;
    if (getAddress(to) === account) return MANAGEMENT_SELF.includes(selector);
    if (getAddress(to) === config.addresses.agentPolicyHook) {
      return MANAGEMENT_HOOK.includes(selector);
    }
    // An allowance reset, as revoke and panic do: approve(spender, 0).
    try {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
      return functionName === "approve" && args[1] === 0n;
    } catch {
      return false;
    }
  });
  return management ? "management" : "business";
}

/** Headroom over the sponsor's own gas estimate, so a state change before submission does not run out. */
const GAS_HEADROOM_PERCENT = 20n;

/** The transaction the sponsor would send, with its worst-case fee in wei. */
export interface SponsoredTransaction {
  to: Address;
  data: Hex;
  authorizationList?: SignedAuthorization[];
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFee: bigint;
}

/**
 * Simulates the transaction from the relayer (`eth_estimateGas`, so a reverting batch is refused
 * here) and bounds its fee with `relayerFeeBound` (docs/infra.md §5, DESIGN §5.2).
 */
export async function simulate(
  client: Client,
  config: SponsorConfig,
  tx: { to: Address; data: Hex; authorizationList?: SignedAuthorization[] },
): Promise<SponsoredTransaction> {
  const estimate = await estimateOrReject(client, { account: config.relayer, ...tx });
  const gas = estimate + (estimate * GAS_HEADROOM_PERCENT) / 100n;
  try {
    const { maxFeePerGas, maxPriorityFeePerGas } = await estimateFeesPerGas(client);
    const priced = { ...tx, gas, maxFeePerGas, maxPriorityFeePerGas };
    return { ...priced, maxFee: await relayerFeeBound(client, config.chainId, priced) };
  } catch {
    return reject(SponsorRejectCode.FEE_UNBOUNDED, "the gas price oracle could not bound the fee");
  }
}

/** `eth_estimateGas` of the call; a revert is refused `SIMULATION_FAILED`. */
export async function estimateOrReject(
  client: Client,
  call: { account: Address; to: Address; data: Hex; authorizationList?: SignedAuthorization[] },
): Promise<bigint> {
  try {
    return await estimateGas(client, call);
  } catch (error) {
    return reject(
      SponsorRejectCode.SIMULATION_FAILED,
      error instanceof BaseError ? error.shortMessage : "eth_estimateGas failed",
    );
  }
}

/**
 * The sponsorship policy's caps for one request against today's persisted usage: per-request fee,
 * per-account daily gas (per budget class, so business traffic cannot lock out a revoke), and the
 * global daily budget, of which business requests may never use the unused management reserve.
 */
export function checkBudget(
  config: SponsorConfig,
  usage: DailyUsage,
  request: { budgetClass: BudgetClass; gas: bigint; maxFee: bigint },
): void {
  const { policy } = config;
  const { budgetClass, gas, maxFee } = request;
  if (maxFee > policy.maxFeePerRequest) {
    reject(
      SponsorRejectCode.REQUEST_FEE_CAP,
      `worst-case fee ${maxFee} wei exceeds ${policy.maxFeePerRequest}`,
    );
  }
  const accountGas = usage.account[budgetClass].gas + gas;
  if (accountGas > policy.accountDailyGas) {
    reject(
      SponsorRejectCode.ACCOUNT_GAS_CAP,
      `${budgetClass} gas today would be ${accountGas}, cap ${policy.accountDailyGas}`,
    );
  }
  const managementSpent = usage.global.management.fee;
  const spent = usage.global.business.fee + managementSpent + maxFee;
  if (budgetClass === "management") {
    if (spent > policy.dailyBudget) {
      reject(
        SponsorRejectCode.MANAGEMENT_BUDGET,
        `spend today would be ${spent} wei, budget ${policy.dailyBudget}`,
      );
    }
  } else {
    const unusedReserve =
      policy.managementReserve > managementSpent ? policy.managementReserve - managementSpent : 0n;
    if (spent + unusedReserve > policy.dailyBudget) {
      reject(
        SponsorRejectCode.DAILY_BUDGET,
        `business spend would leave less than the ${unusedReserve} wei management reserve`,
      );
    }
  }
}

export function checkAllowlist(config: SponsorConfig, account: Address): void {
  if (!config.policy.allowlist.includes(account)) {
    reject(SponsorRejectCode.NOT_ALLOWLISTED, `${account} is not allowlisted`);
  }
}
