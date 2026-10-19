import {
  BaseError,
  type Client,
  encodeFunctionData,
  type Hex,
  parseAbi,
  type SignedAuthorization,
  zeroAddress,
} from "viem";
import { toAccount } from "viem/accounts";
import { getTransactionCount, sendTransaction, waitForTransactionReceipt } from "viem/actions";
import type { Signer } from "../signer.js";
import type { Call, ExecResult } from "./executor.js";
import type { AllowancePair } from "./policy.js";

/** Bounds the receipt wait of each transaction the root sends itself. */
export const SELF_PAY_RECEIPT_TIMEOUT_MS = 120_000;

/** Calibur's `execute(BatchedCall)`: authorised for the root when the account calls itself. */
const selfExecuteAbi = parseAbi([
  "struct Call { address to; uint256 value; bytes data; }",
  "struct BatchedCall { Call[] calls; bool revertOnFailure; }",
  "function execute(BatchedCall batchedCall) payable",
]);

export interface PanicOptions {
  /**
   * The root EOA sends the revocation itself, as a normal transaction calling its own
   * `execute(BatchedCall)`: no sponsor is involved, and the root must hold MNT for gas.
   */
  selfPay?: boolean;
  /**
   * Phase 2, after the revocation is confirmed: a separate type-4 transaction delegating the EOA to
   * the zero address. The root sends it itself (the sponsor relays only delegations to
   * CaliburEntry), so it needs `selfPay`.
   */
  undelegate?: boolean;
}

export interface PanicResult {
  /** Phase 1: every non-root key revoked, its hook tombstone written, its allowances reset. */
  revocation: {
    /** `nothing-to-revoke`: no key was registered or active, so no transaction was sent. */
    status: "confirmed" | "nothing-to-revoke";
    hash: Hex | null;
    revokedKeys: Hex[];
    resetAllowances: AllowancePair[];
  };
  /** Phase 2; `null` unless `undelegate` was asked for. */
  undelegation: { status: "confirmed"; hash: Hex } | null;
}

/** Panic's phase 2 failed after its phase 1 (the revocation) was confirmed. */
export class UndelegationFailedError extends Error {
  override readonly name = "UndelegationFailedError";
  readonly revocation: PanicResult["revocation"];

  constructor(revocation: PanicResult["revocation"], cause: unknown) {
    const phase1 = revocation.hash
      ? `confirmed in transaction ${revocation.hash}`
      : "had nothing to revoke";
    const why = cause instanceof BaseError ? cause.shortMessage : (cause as Error)?.message;
    super(
      `Revocation (phase 1) ${phase1}; undelegation (phase 2) failed: ${why}. ` +
        "Every non-root key is revoked and the account is still delegated; retry the undelegation",
      { cause },
    );
    this.revocation = revocation;
  }
}

/** The root's own transaction to itself, signed by `root` and paid from its balance. */
export async function sendSelf(
  client: Client,
  root: Signer,
  tx: { data: Hex; nonce?: number; authorizationList?: SignedAuthorization[] },
): Promise<ExecResult> {
  const { signTransaction } = root;
  if (!signTransaction) throw new Error("The root signer cannot sign transactions (self-pay)");
  const account = toAccount({
    address: root.address,
    signMessage: (p) => root.signMessage(p),
    signTypedData: (p) => root.signTypedData(p as never),
    signTransaction: (t) => signTransaction.call(root, t),
  });
  const hash = await sendTransaction(client, {
    account,
    chain: client.chain,
    to: root.address,
    ...tx,
  } as never);
  const receipt = await waitForTransactionReceipt(client, {
    hash,
    timeout: SELF_PAY_RECEIPT_TIMEOUT_MS,
  });
  return { hash, success: receipt.status === "success" };
}

/** Calldata of the root's `execute(BatchedCall)` self-call (`revertOnFailure`). */
export const selfExecuteData = (calls: readonly Call[]): Hex =>
  encodeFunctionData({
    abi: selfExecuteAbi,
    functionName: "execute",
    args: [{ calls: calls.map((c) => ({ ...c })), revertOnFailure: true }],
  });

/**
 * Sends the type-4 transaction that delegates the root EOA to the zero address (EIP-7702 clears
 * the delegation). The root sends it itself, so the transaction uses nonce `n` before the
 * authorization is checked, which must then carry `n + 1` (as viem's `executor: "self"` does).
 */
export async function sendUndelegation(
  client: Client,
  root: Signer,
  chainId: number,
): Promise<ExecResult> {
  if (!root.signAuthorization) throw new Error("The root signer cannot sign EIP-7702");
  const nonce = await getTransactionCount(client, { address: root.address, blockTag: "pending" });
  const authorization = await root.signAuthorization({
    address: zeroAddress,
    chainId,
    nonce: nonce + 1,
  });
  return sendSelf(client, root, { data: "0x", nonce, authorizationList: [authorization] });
}
