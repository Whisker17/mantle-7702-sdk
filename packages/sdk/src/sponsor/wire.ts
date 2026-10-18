import {
  type Address,
  getAddress,
  type Hex,
  hashTypedData,
  isAddress,
  isHex,
  type SignedAuthorization,
  size,
} from "viem";

// Shared by the sponsor's wire methods; not exported from the package.

export const SPONSOR_DOMAIN_NAME = "MantleAA Sponsor";
export const SPONSOR_DOMAIN_VERSION = "1";

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

/** The EIP-712 `SponsorRequest` digest every sponsor method's request is signed over. */
export function sponsorRequestDigest(r: {
  chainId: number;
  sponsor: Address;
  method: string;
  sender: Address;
  keyHash: Hex;
  entry: Address;
  payloadHash: Hex;
  validAfter: number;
  validUntil: number;
}): Hex {
  return hashTypedData({
    domain: {
      name: SPONSOR_DOMAIN_NAME,
      version: SPONSOR_DOMAIN_VERSION,
      chainId: r.chainId,
      verifyingContract: r.sponsor,
    },
    types: requestTypes,
    primaryType: "SponsorRequest",
    message: {
      method: r.method,
      sender: r.sender,
      keyHash: r.keyHash,
      entry: r.entry,
      payloadHash: r.payloadHash,
      validAfter: BigInt(r.validAfter),
      validUntil: BigInt(r.validUntil),
    },
  });
}

/** `(address, chainId, nonce, yParity, r, s)[]`: the zero or one EIP-7702 authorization a payload binds. */
export const authorizationTuple = {
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

export const authorizationList = (a: SignedAuthorization | undefined) =>
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
    : [];

// Validators for untrusted wire params; each throws an Error naming the bad field.

export function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${field} must be an address`);
  }
  return getAddress(value);
}

export function hex(value: unknown, field: string, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length % 2 !== 0) {
    throw new Error(`${field} must be 0x-prefixed hex bytes`);
  }
  if (bytes !== undefined && size(value) !== bytes)
    throw new Error(`${field} must be ${bytes} bytes`);
  return value.toLowerCase() as Hex;
}

export function uint(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}
