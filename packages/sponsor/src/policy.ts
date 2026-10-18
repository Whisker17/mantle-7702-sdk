import { agentPolicyHookAbi, caliburAbi, erc20Abi, SponsorRejectCode } from "@mantle-aa/sdk";
import {
  type Address,
  BaseError,
  type Client,
  decodeFunctionData,
  getAddress,
  type Hex,
  parseAbi,
  type SignedAuthorization,
  serializeTransaction,
  size,
  toFunctionSelector,
} from "viem";
import { estimateFeesPerGas, estimateGas, readContract } from "viem/actions";
import type { SignedBatchedCall } from "./auth.js";
import { reject } from "./auth.js";
import type { SponsorConfig } from "./config.js";
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
  batch: SignedBatchedCall,
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

/** Mantle's GasPriceOracle predeploy (docs/infra.md §5). */
export const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";
const gasPriceOracleAbi = parseAbi([
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
  "function tokenRatio() view returns (uint256)",
]);

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
 * here) and bounds its fee: `gas × maxFeePerGas + operator fee(gas) + tokenRatio ×
 * L1-fee upper bound(size)` (docs/infra.md §5, DESIGN §5.2).
 */
export async function simulate(
  client: Client,
  config: SponsorConfig,
  tx: { to: Address; data: Hex; authorizationList?: SignedAuthorization[] },
): Promise<SponsoredTransaction> {
  let estimate: bigint;
  try {
    estimate = await estimateGas(client, { account: config.relayer, ...tx });
  } catch (error) {
    return reject(
      SponsorRejectCode.SIMULATION_FAILED,
      error instanceof BaseError ? error.shortMessage : "eth_estimateGas failed",
    );
  }
  const gas = estimate + (estimate * GAS_HEADROOM_PERCENT) / 100n;
  try {
    const { maxFeePerGas, maxPriorityFeePerGas } = await estimateFeesPerGas(client);
    const unsigned = serializeTransaction({
      chainId: config.chainId,
      nonce: Number.MAX_SAFE_INTEGER, // an upper bound on the relayer nonce's encoded size
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      ...tx,
      ...(tx.authorizationList ? { type: "eip7702" } : { type: "eip1559" }),
    } as never);
    const oracle = (functionName: string, args: unknown[] = []) =>
      readContract(client, {
        address: GAS_PRICE_ORACLE,
        abi: gasPriceOracleAbi,
        functionName,
        args,
      } as never) as Promise<bigint>;
    const [operatorFee, l1UpperBound, tokenRatio] = await Promise.all([
      oracle("getOperatorFee", [gas]),
      oracle("getL1FeeUpperBound", [BigInt(size(unsigned))]),
      oracle("tokenRatio"),
    ]);
    const maxFee = gas * maxFeePerGas + operatorFee + tokenRatio * l1UpperBound;
    return { ...tx, gas, maxFeePerGas, maxPriorityFeePerGas, maxFee };
  } catch {
    return reject(SponsorRejectCode.FEE_UNBOUNDED, "the gas price oracle could not bound the fee");
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
