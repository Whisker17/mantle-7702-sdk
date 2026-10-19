import { getAddress, type Hex, recoverAddress, type SignedAuthorization, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeUserOpCallData,
  EXECUTE_USER_OP_SELECTOR,
  encodeUserOpCallData,
  type PaymasterRequest,
  PM_GET_PAYMASTER_DATA_METHOD,
  PM_GET_PAYMASTER_STUB_DATA_METHOD,
  PrivateKeySigner,
  parsePaymasterRequest,
  paymasterRequestDigest,
  paymasterRequestParams,
  recoverPaymasterRequestSigner,
  signPaymasterRequest,
  type UnsignedPaymasterRequest,
} from "../../src/index.js";

const KEY_HASH: Hex = `0x${"ab".repeat(32)}`;
const signer = new PrivateKeySigner(`0x${"11".repeat(32)}`);
const calls = [
  {
    to: getAddress("0x000000000000000000000000000000000000c0de"),
    value: 0n,
    data: "0x1234" as Hex,
  },
];

const authorization: SignedAuthorization = {
  address: "0x000000005c84F8Fd50b21CAC312528A64437030e",
  chainId: 5003,
  nonce: 7,
  yParity: 1,
  r: `0x${"33".repeat(32)}`,
  s: `0x${"44".repeat(32)}`,
};

/** A root init UserOp: nonce 0, the 2-byte 0x7702 initCode and its authorization. */
const base: UnsignedPaymasterRequest = {
  userOp: {
    sender: getAddress("0x00000000000000000000000000000000000000aa"),
    nonce: 0n,
    factory: "0x7702",
    callData: encodeUserOpCallData(calls),
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    authorization,
  },
  entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  chainId: 5003,
  auth: {
    sponsor: getAddress("0x00000000000000000000000000000000000000e1"),
    keyHash: zeroHash,
    validAfter: 1_800_000_000,
    validUntil: 1_800_000_300,
  },
};
const op = (over: Partial<UnsignedPaymasterRequest["userOp"]>): UnsignedPaymasterRequest => ({
  ...base,
  userOp: { ...base.userOp, ...over },
});
const auth = (over: Partial<UnsignedPaymasterRequest["auth"]>): UnsignedPaymasterRequest => ({
  ...base,
  auth: { ...base.auth, ...over },
});

describe("paymaster request digest", () => {
  // Recomputed independently with `cast abi-encode` / `cast keccak` from the encoding documented in
  // src/sponsor/paymaster.ts (payloadHash over the packed UserOp, the SponsorRequest struct hash,
  // the domain separator, `0x1901`), with the calldata built by `cast abi-encode` as well.
  it("is pinned, so the client and the sponsor cannot drift apart silently", () => {
    expect(base.userOp.callData).toBe(
      "0x8dd7712f00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000c0de0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000",
    );
    expect(paymasterRequestDigest(PM_GET_PAYMASTER_DATA_METHOD, base)).toBe(
      "0x5ee981dc1b7b632eda604a8bab38591198fe818fdd5e5106a625dbc6d49cdd50",
    );
  });

  it("changes when any single bound field changes", () => {
    const variants: Record<string, UnsignedPaymasterRequest> = {
      sender: op({ sender: "0x00000000000000000000000000000000000000ab" }),
      nonce: op({ nonce: 1n }),
      factory: op({ factory: "0x7702000000000000000000000000000000000000" }),
      factoryData: op({ factoryData: "0x01" }),
      noInitCode: op({ factory: undefined }),
      callData: op({ callData: encodeUserOpCallData(calls, false) }),
      callGasLimit: op({ callGasLimit: 100_001n }),
      verificationGasLimit: op({ verificationGasLimit: 200_001n }),
      preVerificationGas: op({ preVerificationGas: 50_001n }),
      maxFeePerGas: op({ maxFeePerGas: 100_000_000_001n }),
      maxPriorityFeePerGas: op({ maxPriorityFeePerGas: 1_000_000_001n }),
      noAuthorization: op({ authorization: undefined }),
      "authorization.nonce": op({ authorization: { ...authorization, nonce: 8 } }),
      "authorization.address": op({
        authorization: { ...authorization, address: "0x000000005c84f8fd50b21cac312528a64437030f" },
      }),
      "authorization.s": op({ authorization: { ...authorization, s: `0x${"45".repeat(32)}` } }),
      entryPoint: { ...base, entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" },
      chainId: { ...base, chainId: 5000 },
      sponsor: auth({ sponsor: "0x00000000000000000000000000000000000000e2" }),
      keyHash: auth({ keyHash: KEY_HASH }),
      validAfter: auth({ validAfter: 1_800_000_001 }),
      validUntil: auth({ validUntil: 1_800_000_301 }),
    };
    const digest = paymasterRequestDigest(PM_GET_PAYMASTER_DATA_METHOD, base);
    const seen = new Set([digest, paymasterRequestDigest(PM_GET_PAYMASTER_STUB_DATA_METHOD, base)]);
    for (const [field, variant] of Object.entries(variants)) {
      const changed = paymasterRequestDigest(PM_GET_PAYMASTER_DATA_METHOD, variant);
      expect(changed, field).not.toBe(digest);
      seen.add(changed);
    }
    expect(seen.size).toBe(Object.keys(variants).length + 2);
  });

  it("is signed with EIP-191, never as a raw signature over the digest", async () => {
    const request = await signPaymasterRequest(signer, PM_GET_PAYMASTER_DATA_METHOD, base);
    expect(await recoverPaymasterRequestSigner(PM_GET_PAYMASTER_DATA_METHOD, request)).toBe(
      signer.address,
    );
    const raw = await recoverAddress({
      hash: paymasterRequestDigest(PM_GET_PAYMASTER_DATA_METHOD, base),
      signature: request.auth.signature,
    });
    expect(raw).not.toBe(signer.address);
  });
});

describe("parsePaymasterRequest", () => {
  it("round-trips a signed request through the JSON-RPC params", async () => {
    const request = await signPaymasterRequest(signer, PM_GET_PAYMASTER_DATA_METHOD, base);
    const params = JSON.parse(JSON.stringify(paymasterRequestParams(request)));
    expect(params[2]).toBe("0x138b");
    expect(params[0]).toMatchObject({
      factory: "0x7702",
      nonce: "0x0",
      eip7702Auth: { yParity: "0x01" },
    });
    const parsed = parsePaymasterRequest(params);
    expect(parsed).toEqual(request);
    expect(await recoverPaymasterRequestSigner(PM_GET_PAYMASTER_DATA_METHOD, parsed)).toBe(
      signer.address,
    );
  });

  it("ignores the paymaster fields and the account signature a wallet may already have set", async () => {
    const request = await signPaymasterRequest(signer, PM_GET_PAYMASTER_DATA_METHOD, base);
    const [userOp, ...rest] = paymasterRequestParams(request) as [Record<string, unknown>];
    const parsed = parsePaymasterRequest([
      {
        ...userOp,
        paymaster: "0x301813D34cBebdf90FEBf32929CfB323c9eF3B4C",
        paymasterData: "0x1234",
        paymasterVerificationGasLimit: "0x1",
        paymasterPostOpGasLimit: "0x1",
        signature: `0x${"aa".repeat(65)}`,
      },
      ...rest,
    ]);
    expect(parsed).toEqual(request);
  });

  const valid = paymasterRequestParams({
    ...base,
    auth: { ...base.auth, signature: `0x${"55".repeat(65)}` },
  } as PaymasterRequest) as [Record<string, unknown>, unknown, unknown, Record<string, unknown>];
  const [validOp, , , validAuth] = valid;
  const withOp = (over: Record<string, unknown>) => [
    { ...validOp, ...over },
    valid[1],
    valid[2],
    valid[3],
  ];
  it.each([
    ["not an array", { userOp: validOp }],
    ["no context", valid.slice(0, 3)],
    ["a decimal nonce", withOp({ nonce: 0 })],
    ["no maxFeePerGas", withOp({ maxFeePerGas: undefined })],
    ["odd-length callData", withOp({ callData: "0x123" })],
    [
      "a bad yParity",
      withOp({ eip7702Auth: { ...(validOp.eip7702Auth as object), yParity: "0x2" } }),
    ],
    ["a numeric chainId", [validOp, valid[1], 5003, validAuth]],
    ["a bad entryPoint", [validOp, "0x1234", valid[2], validAuth]],
    ["a short keyHash", [validOp, valid[1], valid[2], { ...validAuth, keyHash: "0x12" }]],
    ["a short signature", [validOp, valid[1], valid[2], { ...validAuth, signature: "0x12" }]],
  ])("rejects %s", (_, params) => {
    expect(() => parsePaymasterRequest(params)).toThrow();
  });

  it("accepts the valid params the cases above mutate", () => {
    expect(parsePaymasterRequest(valid).userOp.sender).toBe(getAddress(base.userOp.sender));
  });
});

describe("UserOp calldata", () => {
  it("is executeUserOp.selector ‖ abi.encode(BatchedCall), and decodes back", () => {
    expect(EXECUTE_USER_OP_SELECTOR).toBe("0x8dd7712f");
    expect(decodeUserOpCallData(base.userOp.callData)).toEqual({ calls, revertOnFailure: true });
  });

  it("rejects other calldata and a non-canonical encoding", () => {
    expect(() => decodeUserOpCallData("0x12345678")).toThrow();
    expect(() => decodeUserOpCallData(`${base.userOp.callData}00`)).toThrow(/canonical/);
  });
});
