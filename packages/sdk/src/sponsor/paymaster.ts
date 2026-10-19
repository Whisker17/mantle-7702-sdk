import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hex,
  keccak256,
  numberToHex,
  recoverMessageAddress,
  type SignedAuthorization,
  slice,
  toFunctionSelector,
} from "viem";
import {
  formatUserOperationRequest,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import type { Call } from "../account/executor.js";
import type { Signer } from "../signer.js";
import {
  address,
  authorizationList,
  authorizationTuple,
  hex,
  object,
  sponsorRequestDigest,
  uint,
} from "./wire.js";

/**
 * The sponsor's ERC-7677 paymaster methods (docs/DESIGN.md §5.2, §4.3), served by the same HTTP
 * JSON-RPC endpoint as `sponsor_relay`, for EntryPoint v0.8:
 *
 *   pm_getPaymasterStubData(userOp, entryPoint, chainId, context) → PaymasterStubDataResult
 *   pm_getPaymasterData(userOp, entryPoint, chainId, context)     → PaymasterDataResult
 *
 * `userOp` is the unsigned UserOperation in the bundler RPC form (hex quantities; `factory` /
 * `factoryData`; `eip7702Auth` for the root's init), as viem's `formatUserOperationRequest` writes
 * it; paymaster fields and the account signature in it are ignored. `chainId` is a hex quantity.
 * `context` is the request authentication, `PaymasterRequestAuth`.
 *
 * Request digest: the `SponsorRequest` EIP-712 digest of `sponsor_relay` (request.ts), with
 * `method` the JSON-RPC method, `keyHash` the key the account will sign the UserOp with (0 for the
 * root), `entry` the EntryPoint, and
 *
 *   payloadHash = keccak256(abi.encode(uint256 nonce, bytes initCode, bytes callData,
 *                   bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees,
 *                   (address,uint256,uint256,uint8,bytes32,bytes32)[] authorizationList))
 *
 * over the UserOp packed as the bundler packs it (`initCode = factory ‖ factoryData`, the 2-byte
 * `0x7702` for the root's init). The paymaster's gas limits are the sponsor's, so they are not
 * bound. The signature is EIP-191 over the digest by the root (the sender) or the session key.
 *
 * The UserOp's calldata must be `executeUserOp.selector ‖ abi.encode(BatchedCall)` (Calibur), its
 * nonce key the key's lane (0 for the root). Only the root's init carries `eip7702Auth`, and then
 * exactly the 2-byte `initCode` `0x7702`; every other UserOp has an empty `initCode`.
 */

export const PM_GET_PAYMASTER_STUB_DATA_METHOD = "pm_getPaymasterStubData";
export const PM_GET_PAYMASTER_DATA_METHOD = "pm_getPaymasterData";
export type PaymasterMethod =
  | typeof PM_GET_PAYMASTER_STUB_DATA_METHOD
  | typeof PM_GET_PAYMASTER_DATA_METHOD;

/** The `context` param: proves who asked, of which sponsor, as which key and for how long. */
export interface PaymasterRequestAuth {
  /** The sponsor's address (its relayer address names the sponsor instance). */
  sponsor: Address;
  /** The key that will sign the UserOp: 0 for the root. */
  keyHash: Hex;
  /** Unix seconds. */
  validAfter: number;
  /**
   * Unix seconds. Also the sponsorship's `validUntil`: the paymaster signature is good until then,
   * and a retry of the same request never extends it.
   */
  validUntil: number;
  /** EIP-191 signature over the request digest by the root (keyHash 0) or the session key. */
  signature: Hex;
}

/** The UserOp fields the sponsor reads; viem's `UserOperation<"0.8">` is one. */
export interface PaymasterUserOperation {
  sender: Address;
  nonce: bigint;
  factory?: Hex | undefined;
  factoryData?: Hex | undefined;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** `eip7702Auth` on the wire; only the root's init carries one. */
  authorization?: SignedAuthorization | undefined;
}

export interface PaymasterRequest {
  userOp: PaymasterUserOperation;
  entryPoint: Address;
  chainId: number;
  auth: PaymasterRequestAuth;
}

export type UnsignedPaymasterRequest = Omit<PaymasterRequest, "auth"> & {
  auth: Omit<PaymasterRequestAuth, "signature">;
};

/** Gas-estimation data: its signature is a placeholder that never validates (`isFinal: false`). */
export interface PaymasterStubDataResult {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  isFinal: false;
}

/**
 * The sponsorship: `paymasterData = abi.encode(uint48 validUntil, uint48 validAfter) ‖ signature`
 * over the UserOp with exactly these paymaster gas limits. Retrying the same request (same request
 * digest), or another request for the same UserOp and validity (same paymaster hash), returns this
 * result again and reserves nothing more.
 */
export interface PaymasterDataResult {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
}

/** Calibur's `IAccountExecute.executeUserOp`, which the EntryPoint calls with the whole UserOp. */
export const EXECUTE_USER_OP_SELECTOR = toFunctionSelector(
  "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)",
);
const batchedCallParam = [
  {
    type: "tuple",
    components: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "revertOnFailure", type: "bool" },
    ],
  },
] as const;

/** A batch as Calibur's `executeUserOp` reads it: `executeUserOp.selector ‖ abi.encode(BatchedCall)`. */
export function encodeUserOpCallData(calls: readonly Call[], revertOnFailure = true): Hex {
  return `${EXECUTE_USER_OP_SELECTOR}${encodeAbiParameters(batchedCallParam, [
    { calls: calls.map((c) => ({ ...c })), revertOnFailure },
  ]).slice(2)}`;
}

/** The BatchedCall of UserOp calldata; throws unless it is canonically `encodeUserOpCallData`. */
export function decodeUserOpCallData(callData: Hex) {
  if (callData.slice(0, 10).toLowerCase() !== EXECUTE_USER_OP_SELECTOR) {
    throw new Error("callData is not executeUserOp.selector ‖ abi.encode(BatchedCall)");
  }
  const [batchedCall] = decodeAbiParameters(batchedCallParam, slice(callData, 4));
  if (
    encodeUserOpCallData(batchedCall.calls, batchedCall.revertOnFailure) !== callData.toLowerCase()
  ) {
    throw new Error("callData is not canonically ABI-encoded");
  }
  return batchedCall;
}

/** The UserOp packed as the bundler packs it, without paymaster data or signature. */
const packed = (op: PaymasterUserOperation) =>
  toPackedUserOperation({ ...op, signature: "0x" } as UserOperation<"0.8">);

/** The request digest a paymaster request is signed over (see the module comment). */
export function paymasterRequestDigest(
  method: PaymasterMethod,
  request: UnsignedPaymasterRequest,
): Hex {
  const p = packed(request.userOp);
  return sponsorRequestDigest({
    chainId: request.chainId,
    sponsor: request.auth.sponsor,
    method,
    sender: request.userOp.sender,
    keyHash: request.auth.keyHash,
    entry: request.entryPoint,
    payloadHash: keccak256(
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "bytes" },
          { type: "bytes" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "bytes32" },
          authorizationTuple,
        ],
        [
          p.nonce,
          p.initCode,
          p.callData,
          p.accountGasLimits,
          p.preVerificationGas,
          p.gasFees,
          authorizationList(request.userOp.authorization),
        ],
      ),
    ),
    validAfter: request.auth.validAfter,
    validUntil: request.auth.validUntil,
  });
}

/** Signs a paymaster request with the root (keyHash 0) or the session key that will sign the UserOp. */
export async function signPaymasterRequest(
  signer: Signer,
  method: PaymasterMethod,
  request: UnsignedPaymasterRequest,
): Promise<PaymasterRequest> {
  const signature = await signer.signMessage({
    message: { raw: paymasterRequestDigest(method, request) },
  });
  return { ...request, auth: { ...request.auth, signature } };
}

/** The address that signed the request digest. Throws on a malformed signature. */
export function recoverPaymasterRequestSigner(
  method: PaymasterMethod,
  request: PaymasterRequest,
  digest?: Hex,
): Promise<Address> {
  return recoverMessageAddress({
    message: { raw: digest ?? paymasterRequestDigest(method, request) },
    signature: request.auth.signature,
  });
}

/** The JSON-RPC params of a paymaster request: `[userOp, entryPoint, chainId, context]`. */
export function paymasterRequestParams(request: PaymasterRequest): unknown[] {
  return [
    formatUserOperationRequest(request.userOp),
    request.entryPoint,
    numberToHex(request.chainId),
    request.auth,
  ];
}

/** Validates untrusted paymaster params; throws an Error naming the first bad field. */
export function parsePaymasterRequest(params: unknown): PaymasterRequest {
  if (!Array.isArray(params) || params.length !== 4) {
    throw new Error("params must be [userOp, entryPoint, chainId, context]");
  }
  const [rawOp, entryPoint, chainId, rawAuth] = params;
  const op = object(rawOp, "userOp");
  const auth = object(rawAuth, "context");
  const userOp: PaymasterUserOperation = {
    sender: address(op.sender, "userOp.sender"),
    nonce: quantity(op.nonce, "userOp.nonce"),
    callData: hex(op.callData, "userOp.callData"),
    callGasLimit: quantity(op.callGasLimit, "userOp.callGasLimit"),
    verificationGasLimit: quantity(op.verificationGasLimit, "userOp.verificationGasLimit"),
    preVerificationGas: quantity(op.preVerificationGas, "userOp.preVerificationGas"),
    maxFeePerGas: quantity(op.maxFeePerGas, "userOp.maxFeePerGas"),
    maxPriorityFeePerGas: quantity(op.maxPriorityFeePerGas, "userOp.maxPriorityFeePerGas"),
  };
  if (op.factory !== undefined && op.factory !== null) {
    userOp.factory = hex(op.factory, "userOp.factory");
    if (op.factoryData !== undefined && op.factoryData !== null) {
      userOp.factoryData = hex(op.factoryData, "userOp.factoryData");
    }
  }
  if (op.eip7702Auth !== undefined && op.eip7702Auth !== null) {
    const a = object(op.eip7702Auth, "userOp.eip7702Auth");
    const yParity = Number(quantity(a.yParity, "userOp.eip7702Auth.yParity"));
    if (yParity !== 0 && yParity !== 1)
      throw new Error("userOp.eip7702Auth.yParity must be 0 or 1");
    userOp.authorization = {
      address: address(a.address, "userOp.eip7702Auth.address"),
      chainId: safe(
        quantity(a.chainId, "userOp.eip7702Auth.chainId"),
        "userOp.eip7702Auth.chainId",
      ),
      nonce: safe(quantity(a.nonce, "userOp.eip7702Auth.nonce"), "userOp.eip7702Auth.nonce"),
      yParity,
      r: hex(a.r, "userOp.eip7702Auth.r", 32),
      s: hex(a.s, "userOp.eip7702Auth.s", 32),
    };
  }
  return {
    userOp,
    entryPoint: address(entryPoint, "entryPoint"),
    chainId: safe(quantity(chainId, "chainId"), "chainId"),
    auth: {
      sponsor: address(auth.sponsor, "context.sponsor"),
      keyHash: hex(auth.keyHash, "context.keyHash", 32),
      validAfter: uint(auth.validAfter, "context.validAfter"),
      validUntil: uint(auth.validUntil, "context.validUntil"),
      signature: hex(auth.signature, "context.signature", 65),
    },
  };
}

/** A hex quantity (`0x0`, `0x1a`, …). */
function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`${field} must be a hex quantity`);
  }
  return BigInt(value);
}

function safe(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} is too large`);
  return Number(value);
}
