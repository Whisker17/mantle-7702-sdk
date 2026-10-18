import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  type Hex,
  hashTypedData,
  isAddress,
  isHex,
  keccak256,
  recoverMessageAddress,
  type SignedAuthorization,
  size,
} from "viem";
import { caliburAbi } from "../account/abi.js";
import type { Signer } from "../signer.js";

/**
 * The `sponsor_relay` wire request and its request digest (docs/DESIGN.md §5.2).
 *
 * Request digest: an EIP-712 typed-data hash (`0x1901 ‖ domainSeparator ‖ structHash`) of
 *
 *   SponsorRequest(string method,address sender,bytes32 keyHash,address entry,bytes32 payloadHash,
 *                  uint64 validAfter,uint64 validUntil)
 *
 * under the domain `{ name: "MantleAA Sponsor", version: "1", chainId, verifyingContract: sponsor }`,
 * where `sponsor` is the sponsor's relayer address (it names the sponsor instance), `keyHash` is the
 * key the request authenticates as (the SignedBatchedCall's), `entry` is the CaliburEntry
 * implementation the batch is for, and
 *
 *   payloadHash = keccak256(abi.encode(bytes data,
 *                   (address,uint256,uint256,uint8,bytes32,bytes32)[] authorizationList))
 *
 * binds the exact `execute` calldata and the (zero or one) EIP-7702 authorization
 * `(address, chainId, nonce, yParity, r, s)`. The request is valid for unix seconds
 * `validAfter ≤ now ≤ validUntil`. The signature is EIP-191 (`personal_sign`) over the 32-byte
 * digest, so it can never be mistaken for the raw EIP-712 signature Calibur checks on the batch.
 */

export const SPONSOR_DOMAIN_NAME = "MantleAA Sponsor";
export const SPONSOR_DOMAIN_VERSION = "1";
export const SPONSOR_RELAY_METHOD = "sponsor_relay";

/** Proves who sent the request, to which sponsor and chain, and for how long it is valid. */
export interface RequestAuth {
  chainId: number;
  /** The sponsor's relayer address. */
  sponsor: Address;
  /** The CaliburEntry implementation the batch targets. */
  entry: Address;
  /** Unix seconds. */
  validAfter: number;
  /** Unix seconds. */
  validUntil: number;
  /** EIP-191 signature over the request digest by the root (keyHash 0) or the session key. */
  signature: Hex;
}

/** The `sponsor_relay` params (JSON-safe as is). */
export interface RelayRequest {
  /** The account: the EOA delegated (or being delegated) to CaliburEntry. */
  sender: Address;
  /** Calldata of `execute(SignedBatchedCall, bytes wrappedSignature)` to the account. */
  data: Hex;
  /** EIP-7702 authorization; only the root's init carries one. */
  authorization?: SignedAuthorization;
  auth: RequestAuth;
}

export type UnsignedRelayRequest = Omit<RelayRequest, "auth"> & {
  auth: Omit<RequestAuth, "signature">;
};

/**
 * Why the sponsor refused a request: a stable machine-readable code, returned as the JSON-RPC error
 * `{ code: SPONSOR_REJECTED_RPC_CODE, message, data: { reason, detail } }`.
 */
export const SponsorRejectCode = {
  /** The params are malformed or the calldata is not `execute(SignedBatchedCall, bytes)`. */
  INVALID_PARAMS: "INVALID_PARAMS",
  /** The request (or its authorization) names another chain. */
  WRONG_CHAIN: "WRONG_CHAIN",
  /** The request names another sponsor or another CaliburEntry. */
  WRONG_DOMAIN: "WRONG_DOMAIN",
  /** Now is outside `[validAfter, validUntil]`, or the window is longer than the sponsor allows. */
  REQUEST_EXPIRED: "REQUEST_EXPIRED",
  /** The request signature does not recover to the sender (root) or to the session key. */
  BAD_REQUEST_SIGNATURE: "BAD_REQUEST_SIGNATURE",
  /** The account is not on the sponsor's allowlist. */
  NOT_ALLOWLISTED: "NOT_ALLOWLISTED",
  /** A session request on the root lane 0. */
  ROOT_LANE_MISUSE: "ROOT_LANE_MISUSE",
  /** The batch nonce's lane is not the authenticated key's lane. */
  WRONG_LANE: "WRONG_LANE",
  /** The batch's executor is not the sponsor's relayer (executor 0, "anyone", included). */
  WRONG_EXECUTOR: "WRONG_EXECUTOR",
  /** The batch signature does not verify for the batch's key. */
  BAD_BATCH_SIGNATURE: "BAD_BATCH_SIGNATURE",
  /** The authorization is misplaced (session) or does not delegate the sender to CaliburEntry now. */
  AUTHORIZATION_INVALID: "AUTHORIZATION_INVALID",
  /** The account is neither delegated to CaliburEntry nor delegating with this request. */
  ACCOUNT_NOT_DELEGATED: "ACCOUNT_NOT_DELEGATED",
  /** A session request for an account whose safe initialisation is incomplete. */
  ACCOUNT_NOT_INITIALIZED: "ACCOUNT_NOT_INITIALIZED",
  /** The session key is not registered on the account. */
  KEY_NOT_REGISTERED: "KEY_NOT_REGISTERED",
  /** The session key's Calibur expiry has passed. */
  KEY_EXPIRED: "KEY_EXPIRED",
  /** The key is not an active hooked session (`summary.active` false, revoked, admin, other hook). */
  KEY_INACTIVE: "KEY_INACTIVE",
  /** The sponsor's own simulation of the transaction reverted. */
  SIMULATION_FAILED: "SIMULATION_FAILED",
  /** No upper bound on the transaction fee could be established. */
  FEE_UNBOUNDED: "FEE_UNBOUNDED",
  /** The worst-case fee exceeds the per-request cap. */
  REQUEST_FEE_CAP: "REQUEST_FEE_CAP",
  /** The account's daily gas cap would be exceeded. */
  ACCOUNT_GAS_CAP: "ACCOUNT_GAS_CAP",
  /** A business request would exceed the global daily budget minus the unused management reserve. */
  DAILY_BUDGET: "DAILY_BUDGET",
  /** A management request would exceed the global daily budget. */
  MANAGEMENT_BUDGET: "MANAGEMENT_BUDGET",
  /**
   * The request passed every check but this sponsor could not submit it: it has no relayer, the
   * node refused the transaction, or its relayer nonce was consumed by another transaction.
   */
  SUBMISSION_UNAVAILABLE: "SUBMISSION_UNAVAILABLE",
  /** The account already has a request in flight (at most one per account); retry once it settles. */
  SPONSOR_BUSY: "SPONSOR_BUSY",
} as const;
export type SponsorRejectCode = (typeof SponsorRejectCode)[keyof typeof SponsorRejectCode];

/**
 * The `sponsor_relay` result. Retrying the same request (same request digest), or another request
 * for the same SignedBatchedCall, returns this result again and never pays twice.
 */
export interface RelayResult {
  /**
   * `pending`: submitted but not settled within the sponsor's wait; retry the same request to wait
   * again. `success` / `reverted`: the relayer transaction was mined with the batch. `cancelled`:
   * the relayer replaced it with a cancel; the batch did not run.
   */
  status: "pending" | "success" | "reverted" | "cancelled";
  /** The relayer transaction: the one mined once settled, else the latest broadcast (if any yet). */
  hash?: Hex;
  /** The SignedBatchedCall's EIP-712 digest under the account's Calibur domain. */
  batchDigest: Hex;
  /** Wei charged for the request (decimal string), once settled. Failed transactions are charged. */
  fee?: string;
}

/** JSON-RPC error code of a sponsor rejection; `data` is `{ reason: SponsorRejectCode, detail }`. */
export const SPONSOR_REJECTED_RPC_CODE = -32010;

const requestTypes = {
  SponsorRequest: [
    { name: "method", type: "string" },
    { name: "sender", type: "address" },
    { name: "keyHash", type: "bytes32" },
    { name: "entry", type: "address" },
    { name: "payloadHash", type: "bytes32" },
    { name: "validAfter", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

const authorizationTuple = {
  type: "tuple[]",
  components: [
    { name: "address", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "yParity", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
} as const;

/** The SignedBatchedCall and wrapped signature of `execute` calldata; throws on anything else. */
export function decodeExecute(data: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: caliburAbi, data });
  if (functionName !== "execute" || args.length !== 2 || typeof args[0] !== "object") {
    throw new Error("Calldata is not execute(SignedBatchedCall, bytes)");
  }
  const [signedBatchedCall, wrappedSignature] = args;
  return { signedBatchedCall, wrappedSignature };
}

/** The request digest every `sponsor_relay` request is signed over (see the module comment). */
export function relayRequestDigest(request: UnsignedRelayRequest): Hex {
  const { auth, authorization: a } = request;
  const payloadHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes" }, authorizationTuple],
      [
        request.data,
        a
          ? [
              {
                address: a.address,
                chainId: BigInt(a.chainId),
                nonce: BigInt(a.nonce),
                yParity: a.yParity ?? 0,
                r: a.r,
                s: a.s,
              },
            ]
          : [],
      ],
    ),
  );
  return hashTypedData({
    domain: {
      name: SPONSOR_DOMAIN_NAME,
      version: SPONSOR_DOMAIN_VERSION,
      chainId: auth.chainId,
      verifyingContract: auth.sponsor,
    },
    types: requestTypes,
    primaryType: "SponsorRequest",
    message: {
      method: SPONSOR_RELAY_METHOD,
      sender: request.sender,
      keyHash: decodeExecute(request.data).signedBatchedCall.keyHash,
      entry: auth.entry,
      payloadHash,
      validAfter: BigInt(auth.validAfter),
      validUntil: BigInt(auth.validUntil),
    },
  });
}

/** Signs a request with the root (keyHash 0) or the session key the batch is signed by. */
export async function signRelayRequest(
  signer: Signer,
  request: UnsignedRelayRequest,
): Promise<RelayRequest> {
  const signature = await signer.signMessage({ message: { raw: relayRequestDigest(request) } });
  return { ...request, auth: { ...request.auth, signature } };
}

/** The address that signed the request digest. Throws on a malformed signature. */
export function recoverRelayRequestSigner(request: RelayRequest, digest?: Hex): Promise<Address> {
  return recoverMessageAddress({
    message: { raw: digest ?? relayRequestDigest(request) },
    signature: request.auth.signature,
  });
}

/** Validates untrusted `sponsor_relay` params; throws an Error naming the first bad field. */
export function parseRelayRequest(params: unknown): RelayRequest {
  const p = object(params, "params");
  const auth = object(p.auth, "auth");
  const request: RelayRequest = {
    sender: address(p.sender, "sender"),
    data: hex(p.data, "data"),
    auth: {
      chainId: uint(auth.chainId, "auth.chainId"),
      sponsor: address(auth.sponsor, "auth.sponsor"),
      entry: address(auth.entry, "auth.entry"),
      validAfter: uint(auth.validAfter, "auth.validAfter"),
      validUntil: uint(auth.validUntil, "auth.validUntil"),
      signature: hex(auth.signature, "auth.signature", 65),
    },
  };
  if (p.authorization !== undefined) {
    const a = object(p.authorization, "authorization");
    if (a.yParity !== 0 && a.yParity !== 1) throw new Error("authorization.yParity must be 0 or 1");
    request.authorization = {
      address: address(a.address, "authorization.address"),
      chainId: uint(a.chainId, "authorization.chainId"),
      nonce: uint(a.nonce, "authorization.nonce"),
      yParity: a.yParity,
      r: hex(a.r, "authorization.r", 32),
      s: hex(a.s, "authorization.s", 32),
    };
  }
  return request;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${field} must be an address`);
  }
  return getAddress(value);
}

function hex(value: unknown, field: string, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length % 2 !== 0) {
    throw new Error(`${field} must be 0x-prefixed hex bytes`);
  }
  if (bytes !== undefined && size(value) !== bytes)
    throw new Error(`${field} must be ${bytes} bytes`);
  return value.toLowerCase() as Hex;
}

function uint(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}
