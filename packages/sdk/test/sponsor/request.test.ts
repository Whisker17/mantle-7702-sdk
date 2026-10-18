import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  recoverAddress,
  type SignedAuthorization,
  zeroHash,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  caliburAbi,
  decodeExecute,
  laneOf,
  PrivateKeySigner,
  parseRelayRequest,
  recoverRelayRequestSigner,
  relayRequestDigest,
  SponsorRejectCode,
  signRelayRequest,
  type UnsignedRelayRequest,
} from "../../src/index.js";

const KEY_HASH: Hex = `0x${"ab".repeat(32)}`;
const signer = new PrivateKeySigner(`0x${"11".repeat(32)}`);

const executeData = (over: { keyHash?: Hex; nonce?: bigint; deadline?: bigint } = {}): Hex => {
  const keyHash = over.keyHash ?? KEY_HASH;
  return encodeFunctionData({
    abi: caliburAbi,
    functionName: "execute",
    args: [
      {
        batchedCall: {
          calls: [{ to: "0x000000000000000000000000000000000000c0de", value: 0n, data: "0x1234" }],
          revertOnFailure: true,
        },
        nonce: over.nonce ?? laneOf(keyHash) << 64n,
        keyHash,
        executor: "0x00000000000000000000000000000000000000e1",
        deadline: over.deadline ?? 1_900_000_000n,
      },
      encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [`0x${"22".repeat(65)}`, "0x"]),
    ],
  });
};

const authorization: SignedAuthorization = {
  address: "0x000000005c84F8Fd50b21CAC312528A64437030e",
  chainId: 5003,
  nonce: 7,
  yParity: 1,
  r: `0x${"33".repeat(32)}`,
  s: `0x${"44".repeat(32)}`,
};

const base: UnsignedRelayRequest = {
  sender: "0x00000000000000000000000000000000000000aa",
  data: executeData(),
  authorization,
  auth: {
    chainId: 5003,
    sponsor: "0x00000000000000000000000000000000000000e1",
    entry: "0x000000005c84F8Fd50b21CAC312528A64437030e",
    validAfter: 1_800_000_000,
    validUntil: 1_800_000_300,
  },
};

describe("sponsor request digest", () => {
  // Recomputed independently with `cast keccak` / `cast abi-encode` from the encoding documented in
  // src/sponsor/request.ts (domain separator, struct hash, `0x1901` prefix).
  it("is pinned, so the client and the sponsor cannot drift apart silently", () => {
    expect(relayRequestDigest(base)).toBe(
      "0xccdad7e57bf268aa5eedc796d20a83e73d9fd4416eb0bb422077a64ff099c4ae",
    );
  });

  it("changes when any single bound field changes", () => {
    const variants: Record<string, UnsignedRelayRequest> = {
      sender: { ...base, sender: "0x00000000000000000000000000000000000000ab" },
      data: { ...base, data: executeData({ deadline: 1_900_000_001n }) },
      keyHash: { ...base, data: executeData({ keyHash: zeroHash, nonce: 0n }) },
      nonce: { ...base, data: executeData({ nonce: (laneOf(KEY_HASH) << 64n) | 1n }) },
      noAuthorization: { ...base, authorization: undefined as never },
      "authorization.address": {
        ...base,
        authorization: { ...authorization, address: "0x000000005c84f8fd50b21cac312528a64437030f" },
      },
      "authorization.chainId": { ...base, authorization: { ...authorization, chainId: 5000 } },
      "authorization.nonce": { ...base, authorization: { ...authorization, nonce: 8 } },
      "authorization.yParity": { ...base, authorization: { ...authorization, yParity: 0 } },
      "authorization.r": {
        ...base,
        authorization: { ...authorization, r: `0x${"35".repeat(32)}` },
      },
      "authorization.s": {
        ...base,
        authorization: { ...authorization, s: `0x${"45".repeat(32)}` },
      },
      chainId: { ...base, auth: { ...base.auth, chainId: 5000 } },
      sponsor: {
        ...base,
        auth: { ...base.auth, sponsor: "0x00000000000000000000000000000000000000e2" },
      },
      entry: {
        ...base,
        auth: { ...base.auth, entry: "0x000000005c84f8fd50b21cac312528a64437030f" },
      },
      validAfter: { ...base, auth: { ...base.auth, validAfter: 1_800_000_001 } },
      validUntil: { ...base, auth: { ...base.auth, validUntil: 1_800_000_301 } },
    };
    delete (variants.noAuthorization as { authorization?: unknown }).authorization;
    const digest = relayRequestDigest(base);
    const seen = new Set([digest]);
    for (const [field, variant] of Object.entries(variants)) {
      const changed = relayRequestDigest(variant);
      expect(changed, field).not.toBe(digest);
      seen.add(changed);
    }
    expect(seen.size).toBe(Object.keys(variants).length + 1);
  });

  it("binds the keyHash the calldata authenticates as", () => {
    expect(decodeExecute(base.data).signedBatchedCall.keyHash).toBe(KEY_HASH);
    expect(() => relayRequestDigest({ ...base, data: "0x12345678" })).toThrow();
  });

  it("is signed with EIP-191, never as a raw signature over the digest", async () => {
    const request = await signRelayRequest(signer, base);
    expect(await recoverRelayRequestSigner(request)).toBe(signer.address);
    const raw = await recoverAddress({
      hash: relayRequestDigest(base),
      signature: request.auth.signature,
    });
    expect(raw).not.toBe(signer.address);
  });
});

describe("parseRelayRequest", () => {
  it("round-trips a signed request through JSON", async () => {
    const request = await signRelayRequest(signer, base);
    const parsed = parseRelayRequest(JSON.parse(JSON.stringify(request)));
    expect(relayRequestDigest(parsed)).toBe(relayRequestDigest(base));
    expect(await recoverRelayRequestSigner(parsed)).toBe(signer.address);
  });

  const valid = { ...base, auth: { ...base.auth, signature: `0x${"55".repeat(65)}` } };
  it.each([
    ["not an object", null],
    ["a bad sender", { ...valid, sender: "0x1234" }],
    ["odd-length data", { ...valid, data: "0x123" }],
    ["no auth", { ...valid, auth: undefined }],
    ["a fractional chainId", { ...valid, auth: { ...valid.auth, chainId: 1.5 } }],
    ["a string validUntil", { ...valid, auth: { ...valid.auth, validUntil: "1800000300" } }],
    ["a short signature", { ...valid, auth: { ...valid.auth, signature: "0x1234" } }],
    ["a bad yParity", { ...valid, authorization: { ...authorization, yParity: 2 } }],
    ["a short r", { ...valid, authorization: { ...authorization, r: "0x33" } }],
  ])("rejects %s", (_, params) => {
    expect(() => parseRelayRequest(params)).toThrow();
  });

  it("accepts the valid request the cases above mutate", () => {
    expect(parseRelayRequest(valid).sender).toBe(getAddress(base.sender));
  });

  it("exposes stable rejection codes", () => {
    for (const [key, value] of Object.entries(SponsorRejectCode)) expect(value).toBe(key);
  });
});
