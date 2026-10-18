import {
  caliburAbi,
  caliburDomain,
  ERC20ETH,
  laneOf,
  PrivateKeySigner,
  type RelayRequest,
  SponsorRejectCode,
  secp256k1KeyHash,
  signedBatchedCallTypes,
  signRelayRequest,
} from "@mantle-aa/sdk";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  hashTypedData,
  parseAbi,
  zeroAddress,
  zeroHash,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { decodeRelay, SponsorRejection, verifyOnChain } from "../src/auth.js";
import {
  book,
  nowSeconds,
  type RequestOptions,
  relayRequest,
  testConfig,
  undelegatedClient,
} from "./fixtures.js";

const config = testConfig();
const root = new PrivateKeySigner(generatePrivateKey());
const session = new PrivateKeySigner(generatePrivateKey());
const SESSION_KEY = secp256k1KeyHash(session.address);
const other = new PrivateKeySigner(generatePrivateKey());
const ROOT = { account: root.address, signer: root, keyHash: zeroHash };
const SESSION = { account: root.address, signer: session, keyHash: SESSION_KEY };

const client = undelegatedClient();
const make = (o: Omit<RequestOptions, "client">) => relayRequest({ client, ...o });
const authorization = (signer = root, over: Partial<{ address: Address; chainId: number }> = {}) =>
  signer.signAuthorization({
    address: over.address ?? book.caliburEntry,
    chainId: over.chainId ?? 5003,
    nonce: 0,
  });

async function rejection(promise: Promise<unknown>): Promise<SponsorRejection> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SponsorRejection);
  return error as SponsorRejection;
}

const decode = (request: RelayRequest, now = nowSeconds()) => decodeRelay(request, config, now);

describe("decodeRelay", () => {
  it("accepts a root and a session request and reports the authenticated key and lane", async () => {
    const r = await decode(await make(ROOT));
    expect([r.keyHash, r.lane, r.sender]).toEqual([ROOT.keyHash, 0n, root.address]);
    const s = await decode(await make(SESSION));
    expect([s.keyHash, s.lane]).toEqual([SESSION_KEY, laneOf(SESSION_KEY)]);
  });

  it.each<[string, () => Promise<RelayRequest>, SponsorRejectCode]>([
    [
      "a request for another chain",
      () => make({ ...ROOT, auth: { chainId: 5000 } }),
      SponsorRejectCode.WRONG_CHAIN,
    ],
    [
      "an authorization for another chain",
      async () => make({ ...ROOT, authorization: await authorization(root, { chainId: 5000 }) }),
      SponsorRejectCode.WRONG_CHAIN,
    ],
    [
      "another sponsor's domain",
      () => make({ ...ROOT, auth: { sponsor: other.address } }),
      SponsorRejectCode.WRONG_DOMAIN,
    ],
    [
      "another entry",
      () => make({ ...ROOT, auth: { entry: other.address } }),
      SponsorRejectCode.WRONG_DOMAIN,
    ],
    [
      "an expired request",
      () => make({ ...ROOT, auth: { validAfter: 1, validUntil: nowSeconds() - 1 } }),
      SponsorRejectCode.REQUEST_EXPIRED,
    ],
    [
      "a request not valid yet",
      () => make({ ...ROOT, auth: { validAfter: nowSeconds() + 30 } }),
      SponsorRejectCode.REQUEST_EXPIRED,
    ],
    [
      "a validity window longer than the sponsor allows",
      () => make({ ...ROOT, auth: { validUntil: nowSeconds() + 3600 } }),
      SponsorRejectCode.REQUEST_EXPIRED,
    ],
    [
      "a root request signed by someone else",
      () => make({ ...ROOT, requestSigner: other }),
      SponsorRejectCode.BAD_REQUEST_SIGNATURE,
    ],
    [
      "a session request signed by another key",
      () => make({ ...SESSION, requestSigner: other }),
      SponsorRejectCode.BAD_REQUEST_SIGNATURE,
    ],
    [
      "a session request signed by the root",
      () => make({ ...SESSION, requestSigner: root }),
      SponsorRejectCode.BAD_REQUEST_SIGNATURE,
    ],
    [
      "a request changed after signing",
      async () => {
        const r = await make(ROOT);
        return { ...r, auth: { ...r.auth, validUntil: r.auth.validUntil - 1 } };
      },
      SponsorRejectCode.BAD_REQUEST_SIGNATURE,
    ],
    [
      "a malformed request signature",
      async () => {
        const r = await make(ROOT);
        return { ...r, auth: { ...r.auth, signature: `0x${"00".repeat(65)}` as Hex } };
      },
      SponsorRejectCode.BAD_REQUEST_SIGNATURE,
    ],
    [
      "a session request on the root lane",
      () => make({ ...SESSION, nonce: 0n }),
      SponsorRejectCode.ROOT_LANE_MISUSE,
    ],
    [
      "a session request on another key's lane",
      () => make({ ...SESSION, nonce: laneOf(secp256k1KeyHash(other.address)) << 64n }),
      SponsorRejectCode.WRONG_LANE,
    ],
    [
      "a root request on a session lane",
      () => make({ ...ROOT, nonce: laneOf(SESSION_KEY) << 64n }),
      SponsorRejectCode.WRONG_LANE,
    ],
    [
      "a batch for another executor",
      () => make({ ...SESSION, executor: other.address }),
      SponsorRejectCode.WRONG_EXECUTOR,
    ],
    [
      "an authorization on a session request",
      async () => make({ ...SESSION, authorization: await authorization() }),
      SponsorRejectCode.AUTHORIZATION_INVALID,
    ],
    [
      "an authorization to another delegate",
      async () =>
        make({ ...ROOT, authorization: await authorization(root, { address: ERC20ETH }) }),
      SponsorRejectCode.AUTHORIZATION_INVALID,
    ],
    [
      "an authorization signed by someone else",
      async () => make({ ...ROOT, authorization: await authorization(other) }),
      SponsorRejectCode.AUTHORIZATION_INVALID,
    ],
  ])("rejects %s", async (_, build, reason) => {
    expect((await rejection(decode(await build()))).reason).toBe(reason);
  });

  it("rejects a batch any executor may relay (executor 0), root or session", async () => {
    const session = await rejection(decode(await make({ ...SESSION, executor: zeroAddress })));
    expect(session.reason).toBe(SponsorRejectCode.WRONG_EXECUTOR);
    // The SDK refuses to sign a root batch without an executor; another client might not.
    const message = {
      batchedCall: {
        calls: [{ to: root.address, value: 0n, data: "0x" as Hex }],
        revertOnFailure: true,
      },
      nonce: 0n,
      keyHash: zeroHash,
      executor: zeroAddress,
      deadline: BigInt(nowSeconds() + 120),
    };
    const signature = await root.signTypedData({
      domain: caliburDomain({
        chainId: 5003,
        account: root.address,
        implementation: book.caliburEntry,
      }),
      types: signedBatchedCallTypes,
      primaryType: "SignedBatchedCall",
      message,
    });
    const data = encodeFunctionData({
      abi: caliburAbi,
      functionName: "execute",
      args: [
        message,
        encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [signature, "0x"]),
      ],
    });
    const valid = await make(ROOT);
    const request = await signRelayRequest(root, { sender: root.address, data, auth: valid.auth });
    expect((await rejection(decode(request))).reason).toBe(SponsorRejectCode.WRONG_EXECUTOR);
  });

  it("authenticates without a validity window, so a retry can find its issued result", async () => {
    const expired = await make({ ...ROOT, auth: { validAfter: 1, validUntil: nowSeconds() - 1 } });
    await expect(decodeRelay(expired, config)).resolves.toMatchObject({ sender: root.address });
    const forged = {
      ...expired,
      auth: { ...expired.auth, signature: (await make(SESSION)).auth.signature },
    };
    expect((await rejection(decodeRelay(forged, config))).reason).toBe(
      SponsorRejectCode.BAD_REQUEST_SIGNATURE,
    );
  });

  it("rejects calldata that is not a canonical execute(SignedBatchedCall, bytes)", async () => {
    const r = await make(ROOT);
    const notExecute = encodeFunctionData({
      abi: parseAbi(["function revoke(bytes32)"]),
      args: [SESSION_KEY],
    });
    for (const data of [notExecute, `${r.data}00` as Hex]) {
      const e = await rejection(decode({ ...r, data }));
      expect(e.reason).toBe(SponsorRejectCode.INVALID_PARAMS);
    }
  });
});

describe("verifyOnChain on an undelegated account", () => {
  it("accepts the root's init: authorization to CaliburEntry and a batch signed by the SDK", async () => {
    const relay = await decode(await make({ ...ROOT, authorization: await authorization() }));
    // It resolves to the batch digest Calibur checks the signature against.
    const domain = caliburDomain({
      chainId: 5003,
      account: root.address,
      implementation: book.caliburEntry,
    });
    await expect(verifyOnChain(client, config, relay)).resolves.toBe(
      hashTypedData({
        domain,
        types: signedBatchedCallTypes,
        primaryType: "SignedBatchedCall",
        message: relay.signedBatchedCall,
      }),
    );
  });

  it("rejects a root request without an authorization", async () => {
    const relay = await decode(await make(ROOT));
    const e = await rejection(verifyOnChain(client, config, relay));
    expect(e.reason).toBe(SponsorRejectCode.ACCOUNT_NOT_DELEGATED);
  });

  it("rejects an authorization whose nonce is not the account's", async () => {
    const stale = await root.signAuthorization({
      address: book.caliburEntry,
      chainId: 5003,
      nonce: 3,
    });
    const relay = await decode(await make({ ...ROOT, authorization: stale }));
    const e = await rejection(verifyOnChain(client, config, relay));
    expect(e.reason).toBe(SponsorRejectCode.AUTHORIZATION_INVALID);
  });

  it("rejects a batch the root did not sign, even when the request is", async () => {
    const relay = await decode(
      await make({
        ...ROOT,
        signer: other,
        requestSigner: root,
        authorization: await authorization(),
      }),
    );
    const e = await rejection(verifyOnChain(client, config, relay));
    expect(e.reason).toBe(SponsorRejectCode.BAD_BATCH_SIGNATURE);
  });

  it("rejects a session request for an account that is not delegated", async () => {
    const relay = await decode(await make(SESSION));
    const e = await rejection(verifyOnChain(client, config, relay));
    expect(e.reason).toBe(SponsorRejectCode.ACCOUNT_NOT_INITIALIZED);
  });
});
