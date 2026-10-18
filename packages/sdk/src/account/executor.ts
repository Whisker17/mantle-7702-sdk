import {
  type Address,
  type Client,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  type SignedAuthorization,
  zeroAddress,
  zeroHash,
} from "viem";
import { getCode, readContract } from "viem/actions";
import { getCaliburDomain } from "../domain.js";
import type { Signer } from "../signer.js";
import { caliburAbi } from "./abi.js";

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** One batch for `account`, executed under `keyHash` on nonce `lane` (docs/DESIGN.md §5.1). */
export interface ExecRequest {
  account: Address;
  /** `0x00…00` for the root. */
  keyHash: Hex;
  calls: readonly Call[];
  lane: bigint;
  /** Signs the batch for `keyHash`. */
  signer: Signer;
  /** Unix seconds; bounds the SignedBatchedCall entry. */
  deadline: bigint;
  /** EIP-7702 authorization; only the root's init carries one. */
  authorization?: SignedAuthorization;
}

export interface ExecResult {
  hash: Hex;
  success: boolean;
}

export interface Executor {
  kind: "relayer" | "bundler";
  submit(request: ExecRequest): Promise<ExecResult>;
}

export const ROOT_KEY_HASH: Hex = zeroHash;

/** Nonce lane of a key: `uint192(uint256(keyHash) >> 64)`; the root lane is 0 (docs/DESIGN.md §4.1). */
export const laneOf = (keyHash: Hex): bigint => BigInt(keyHash) >> 64n;

/** The next Calibur nonce on `lane` (`lane << 64 | getSeq(lane)`); 0 on an undelegated account. */
export async function readCaliburNonce(
  client: Client,
  account: Address,
  lane: bigint,
): Promise<bigint> {
  const code = await getCode(client, { address: account });
  if (!code || code === "0x") return lane << 64n;
  const seq = await readContract(client, {
    address: account,
    abi: caliburAbi,
    functionName: "getSeq",
    args: [lane],
  });
  return (lane << 64n) | seq;
}

/** EIP-712 types of Calibur's SignedBatchedCall, shared by the signer and the sponsor's check. */
export const signedBatchedCallTypes = {
  SignedBatchedCall: [
    { name: "batchedCall", type: "BatchedCall" },
    { name: "nonce", type: "uint256" },
    { name: "keyHash", type: "bytes32" },
    { name: "executor", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
  BatchedCall: [
    { name: "calls", type: "Call[]" },
    { name: "revertOnFailure", type: "bool" },
  ],
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;

/**
 * Signs a Calibur SignedBatchedCall (always `revertOnFailure = true`) and returns the calldata of
 * `execute(SignedBatchedCall, bytes)` to send to the account. A root batch must name its executor:
 * a broadly relayable root signature (executor 0) is refused.
 */
export async function signBatchedCall(
  client: Client,
  params: {
    account: Address;
    implementation: Address;
    chainId: number;
    signer: Signer;
    keyHash: Hex;
    calls: readonly Call[];
    nonce: bigint;
    executor: Address;
    deadline: bigint;
  },
): Promise<Hex> {
  if (BigInt(params.keyHash) === 0n && getAddress(params.executor) === zeroAddress) {
    throw new Error("Refusing to sign a root batch without an executor");
  }
  const message = {
    batchedCall: { calls: params.calls.map((c) => ({ ...c })), revertOnFailure: true },
    nonce: params.nonce,
    keyHash: params.keyHash,
    executor: params.executor,
    deadline: params.deadline,
  };
  const domain = await getCaliburDomain(client, params);
  const signature = await params.signer.signTypedData({
    domain,
    types: signedBatchedCallTypes,
    primaryType: "SignedBatchedCall",
    message,
  });
  const wrapped = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [signature, "0x"]);
  return encodeFunctionData({ abi: caliburAbi, functionName: "execute", args: [message, wrapped] });
}
