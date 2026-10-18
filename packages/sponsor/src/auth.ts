import {
  agentPolicyHookAbi,
  caliburAbi,
  caliburDomain,
  decodeExecute,
  delegationDesignator,
  ERC20ETH,
  laneOf,
  type RelayRequest,
  readCaliburDomain,
  recoverRelayRequestSigner,
  relayRequestDigest,
  SponsorRejectCode,
  secp256k1KeyHash,
  signedBatchedCallTypes,
} from "@mantle-aa/sdk";
import {
  type Address,
  type Client,
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  hashTypedData,
  recoverAddress,
  size,
  zeroAddress,
} from "viem";
import { getBlock, getCode, getTransactionCount, readContract } from "viem/actions";
import { recoverAuthorizationAddress } from "viem/utils";
import type { SponsorConfig } from "./config.js";

/** A refused request: a stable `reason` code (`SponsorRejectCode`) and a human-readable detail. */
export class SponsorRejection extends Error {
  override readonly name = "SponsorRejection";

  constructor(
    readonly reason: SponsorRejectCode,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

export const reject = (reason: SponsorRejectCode, detail: string): never => {
  throw new SponsorRejection(reason, detail);
};

export type SignedBatchedCall = ReturnType<typeof decodeExecute>["signedBatchedCall"];

/** A request whose envelope, lanes and request signature have been checked (no chain reads yet). */
export interface DecodedRelay {
  request: RelayRequest;
  /** The authenticated request digest: the stable identity of this request. */
  digest: Hex;
  sender: Address;
  /** The authenticated key: 0 for the root. */
  keyHash: Hex;
  lane: bigint;
  signedBatchedCall: SignedBatchedCall;
  /** Canonical `execute` calldata, byte-identical to what the request signed. */
  data: Hex;
}

const isRoot = (keyHash: Hex) => BigInt(keyHash) === 0n;

/** Whether `signer` is the key `keyHash` names on `account` (secp256k1 keys only). */
const isKeySigner = (signer: Address, account: Address, keyHash: Hex) =>
  isRoot(keyHash) ? signer === account : secp256k1KeyHash(signer) === keyHash.toLowerCase();

/** The request is valid at `now`, and not for longer than the sponsor allows. */
export function checkValidity(
  auth: RelayRequest["auth"],
  config: SponsorConfig,
  now: number,
): void {
  if (now < auth.validAfter || now > auth.validUntil) {
    reject(
      SponsorRejectCode.REQUEST_EXPIRED,
      `now ${now} is outside [${auth.validAfter}, ${auth.validUntil}]`,
    );
  }
  if (auth.validUntil - now > config.maxRequestValiditySeconds) {
    reject(
      SponsorRejectCode.REQUEST_EXPIRED,
      `validity ends more than ${config.maxRequestValiditySeconds}s from now`,
    );
  }
}

/**
 * Checks everything that needs no chain state: the request's chain and sponsor domain, its validity
 * window at `now` (skipped without one: a retry finds an issued result whatever its validity), the
 * decode of the SignedBatchedCall, `(sender, keyHash, nonce lane)` agreement, the executor, the
 * request signature and the authorization's shape and signer.
 *
 * The executor must be this sponsor's relayer, for root and session batches alike: a batch any
 * executor may relay (executor 0) can be landed first by anyone who sees it, making the relayer's
 * own transaction revert at the sponsor's cost, and a root one can run inside another call
 * (docs/reviews/0.1.0.md, O1).
 */
export async function decodeRelay(
  request: RelayRequest,
  config: SponsorConfig,
  now?: number,
): Promise<DecodedRelay> {
  const { auth, sender } = request;
  if (auth.chainId !== config.chainId) {
    reject(SponsorRejectCode.WRONG_CHAIN, `request chain ${auth.chainId} is not ${config.chainId}`);
  }
  if (auth.sponsor !== config.relayer) {
    reject(SponsorRejectCode.WRONG_DOMAIN, `request names sponsor ${auth.sponsor}`);
  }
  if (auth.entry !== config.addresses.caliburEntry) {
    reject(SponsorRejectCode.WRONG_DOMAIN, `request names entry ${auth.entry}`);
  }
  if (now !== undefined) checkValidity(auth, config, now);

  let decoded: ReturnType<typeof decodeExecute>;
  try {
    decoded = decodeExecute(request.data);
  } catch {
    return reject(
      SponsorRejectCode.INVALID_PARAMS,
      "data is not execute(SignedBatchedCall, bytes)",
    );
  }
  const { signedBatchedCall: batch, wrappedSignature } = decoded;
  const data = encodeFunctionData({
    abi: caliburAbi,
    functionName: "execute",
    args: [batch, wrappedSignature],
  });
  if (data !== request.data.toLowerCase()) {
    reject(SponsorRejectCode.INVALID_PARAMS, "data is not canonically ABI-encoded");
  }

  const keyHash = batch.keyHash;
  const lane = batch.nonce >> 64n;
  if (isRoot(keyHash)) {
    if (lane !== 0n) reject(SponsorRejectCode.WRONG_LANE, `root request on lane ${lane}`);
  } else if (lane === 0n) {
    reject(SponsorRejectCode.ROOT_LANE_MISUSE, `session ${keyHash} on the root lane 0`);
  } else if (lane !== laneOf(keyHash)) {
    reject(
      SponsorRejectCode.WRONG_LANE,
      `lane ${lane} is not ${keyHash}'s lane ${laneOf(keyHash)}`,
    );
  }
  if (getAddress(batch.executor) !== config.relayer) {
    reject(SponsorRejectCode.WRONG_EXECUTOR, `batch executor ${batch.executor}`);
  }

  const digest = relayRequestDigest(request);
  const signer = await recoverRelayRequestSigner(request, digest).catch(() => zeroAddress);
  if (signer === zeroAddress || !isKeySigner(signer, sender, keyHash)) {
    reject(
      SponsorRejectCode.BAD_REQUEST_SIGNATURE,
      isRoot(keyHash) ? "not signed by the sender" : `not signed by session ${keyHash}`,
    );
  }

  const a = request.authorization;
  if (a) {
    if (!isRoot(keyHash)) {
      reject(SponsorRejectCode.AUTHORIZATION_INVALID, "only a root request may carry one");
    }
    if (a.chainId !== config.chainId) {
      reject(SponsorRejectCode.WRONG_CHAIN, `authorization chain ${a.chainId}`);
    }
    if (getAddress(a.address) !== config.addresses.caliburEntry) {
      reject(SponsorRejectCode.AUTHORIZATION_INVALID, `delegates to ${a.address}`);
    }
    const authority = await recoverAuthorizationAddress({ authorization: a }).catch(
      () => zeroAddress,
    );
    if (authority !== sender) {
      reject(SponsorRejectCode.AUTHORIZATION_INVALID, "not signed by the sender");
    }
  }
  return { request, digest, sender, keyHash, lane, signedBatchedCall: batch, data };
}

/**
 * Checks the chain: the account's delegation (and, for a session, its safe initialisation), the
 * session key (registered, a hooked non-admin key, unexpired per its Calibur settings,
 * `summary.active`), the authorization nonce, and the batch signature itself under the account's
 * EIP-712 domain. Nothing the client checked is trusted. Resolves to the batch's EIP-712 digest,
 * which identifies the relayer result (DESIGN §5.2).
 */
export async function verifyOnChain(
  client: Client,
  config: SponsorConfig,
  relay: DecodedRelay,
): Promise<Hex> {
  const { sender, keyHash } = relay;
  const { caliburEntry, agentPolicyHook } = config.addresses;
  const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[]) =>
    readContract(client, { address, abi, functionName, args } as never) as Promise<T>;

  const code = (await getCode(client, { address: sender }))?.toLowerCase() ?? "0x";
  const delegated = code === delegationDesignator(caliburEntry);
  const authorization = relay.request.authorization;

  if (isRoot(keyHash)) {
    if (!delegated && !authorization) {
      reject(SponsorRejectCode.ACCOUNT_NOT_DELEGATED, `${sender} is not delegated to CaliburEntry`);
    }
    if (authorization) {
      const nonce = await getTransactionCount(client, { address: sender, blockTag: "pending" });
      if (authorization.nonce !== nonce) {
        reject(
          SponsorRejectCode.AUTHORIZATION_INVALID,
          `authorization nonce ${authorization.nonce} is not the account's ${nonce}`,
        );
      }
    }
  } else {
    if (!delegated) {
      reject(SponsorRejectCode.ACCOUNT_NOT_INITIALIZED, `${sender} is not delegated`);
    }
    if ((await read<bigint>(sender, caliburAbi, "nativeAllowance", [ERC20ETH])) !== 0n) {
      reject(SponsorRejectCode.ACCOUNT_NOT_INITIALIZED, `${sender} safe initialisation incomplete`);
    }
    if (!(await read<boolean>(sender, caliburAbi, "isRegistered", [keyHash]))) {
      reject(SponsorRejectCode.KEY_NOT_REGISTERED, `${keyHash} is not registered on ${sender}`);
    }
    const settings = await read<bigint>(sender, caliburAbi, "getKeySettings", [keyHash]);
    const hook = getAddress(`0x${(settings & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`);
    if ((settings >> 200n) & 1n || hook !== agentPolicyHook) {
      reject(SponsorRejectCode.KEY_INACTIVE, `${keyHash} is not a hooked non-admin session key`);
    }
    const expiry = (settings >> 160n) & 0xffffffffffn;
    const { timestamp } = await getBlock(client);
    if (expiry !== 0n && expiry < timestamp) {
      reject(SponsorRejectCode.KEY_EXPIRED, `${keyHash} expired at ${expiry}`);
    }
    const summary = await read<{ active: boolean; revoked: boolean }>(
      agentPolicyHook,
      agentPolicyHookAbi,
      "getSummary",
      [keyHash, sender],
    );
    if (!summary.active || summary.revoked) {
      reject(SponsorRejectCode.KEY_INACTIVE, `${keyHash} is not active on the hook`);
    }
  }

  const domain = delegated
    ? await readCaliburDomain(client, sender)
    : caliburDomain({ chainId: config.chainId, account: sender, implementation: caliburEntry });
  const batchDigest = hashTypedData({
    domain,
    types: signedBatchedCallTypes,
    primaryType: "SignedBatchedCall",
    message: relay.signedBatchedCall,
  });
  if (!isKeySigner(await batchSigner(batchDigest, relay), sender, keyHash)) {
    reject(SponsorRejectCode.BAD_BATCH_SIGNATURE, `batch is not signed by ${keyHash}`);
  }
  return batchDigest;
}

/** The signer of the batch as Calibur computes it (`hashTypedData(signedBatchedCall.hash())`). */
async function batchSigner(hash: Hex, relay: DecodedRelay): Promise<Address> {
  const { wrappedSignature } = decodeExecute(relay.data);
  try {
    const [signature] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }],
      wrappedSignature,
    );
    if (size(signature) !== 65) return zeroAddress;
    return await recoverAddress({ hash, signature });
  } catch {
    return zeroAddress;
  }
}
