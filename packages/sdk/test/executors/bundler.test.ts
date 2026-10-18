import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Address,
  createClient,
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  type Hex,
  recoverAddress,
  type SignedAuthorization,
  toHex,
} from "viem";
import {
  entryPoint08Abi,
  formatUserOperation,
  getUserOperationHash,
  type RpcUserOperation,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { afterEach, describe, expect, it } from "vitest";
import {
  BundlerExecutor,
  decodeUserOpCallData,
  type ExecRequest,
  ExecutionRevertedError,
  laneOf,
  loadDeployments,
  mantleSepolia,
  type PaymasterRequest,
  PrivateKeySigner,
  parsePaymasterRequest,
  ROOT_KEY_HASH,
  recoverPaymasterRequestSigner,
  SPONSOR_REJECTED_RPC_CODE,
  SponsorBusyError,
  SponsorRejectCode,
  SponsorRejectedError,
  secp256k1KeyHash,
} from "../../src/index.js";

const book = loadDeployments();
const SPONSOR: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const root = new PrivateKeySigner(`0x${"11".repeat(32)}`);
const session = new PrivateKeySigner(`0x${"22".repeat(32)}`);
const SESSION_KEY_HASH = secp256k1KeyHash(session.address);
const USER_OP_HASH: Hex = `0x${"aa".repeat(32)}`;
const TX_HASH: Hex = `0x${"bb".repeat(32)}`;
const NONCE = 7n;
const now = () => Math.floor(Date.now() / 1000);

// The EntryPoint answers getNonce(sender, key) with `key << 64 | NONCE`; every key asked is kept.
const nonceKeys: bigint[] = [];
const client = createClient({
  chain: mantleSepolia,
  transport: custom({
    async request({ method, params }) {
      if (method !== "eth_call") throw new Error(`unexpected RPC ${method}`);
      const [{ to, data }] = params as [{ to: Address; data: Hex }];
      expect(to.toLowerCase()).toBe(book.entryPoint.toLowerCase());
      const { args } = decodeFunctionData({ abi: entryPoint08Abi, data });
      const key = args?.[1] as bigint;
      nonceKeys.push(key);
      return encodeAbiParameters([{ type: "uint256" }], [(key << 64n) | NONCE]);
    },
  }),
});

const execRequest = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  account: root.address,
  keyHash: ROOT_KEY_HASH,
  calls: [{ to: book.mockUsd, value: 0n, data: "0x1234" }],
  lane: 0n,
  signer: root,
  deadline: BigInt(now() + 600),
  ...over,
});
const sessionRequest = (over: Partial<ExecRequest> = {}) =>
  execRequest({
    keyHash: SESSION_KEY_HASH,
    lane: laneOf(SESSION_KEY_HASH),
    signer: session,
    ...over,
  });

type Handler = (params: unknown[]) => unknown;
type Reply = { result: unknown } | { error: object } | "hang";

/** A JSON-RPC stub: each method answers with its handler's reply; every call is recorded. */
async function stubRpc(handlers: Record<string, Handler>) {
  const calls: { method: string; params: unknown[] }[] = [];
  let healthCalls = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (body: object) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && req.url === "/health") {
      healthCalls++;
      return send({ status: "ok", chainId: 5003, sponsor: SPONSOR });
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    calls.push({ method, params });
    const handler = handlers[method];
    const reply = (
      handler ? handler(params) : { error: { code: -32601, message: "Method not found" } }
    ) as Reply;
    if (reply === "hang") return;
    send({ jsonrpc: "2.0", id, ...reply });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    healthCalls: () => healthCalls,
    of: (method: string) => calls.filter((c) => c.method === method).map((c) => c.params),
  };
}
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  nonceKeys.length = 0;
  for (const s of servers.splice(0)) {
    s.close();
    s.closeAllConnections();
  }
});

const STUB_DATA: Hex = `0x${"01".repeat(97)}`;
const DATA: Hex = `0x${"02".repeat(97)}`;
const pmResult = (paymasterData: Hex) => ({
  result: {
    paymaster: book.verifyingPaymaster,
    paymasterData,
    paymasterVerificationGasLimit: "0xea60",
    paymasterPostOpGasLimit: "0x0",
  },
});
const rejection = (reason: string, detail = "the detail") => ({
  error: { code: SPONSOR_REJECTED_RPC_CODE, message: "rejected", data: { reason, detail } },
});

/** A sponsor that sponsors everything, unless a method's reply is overridden. */
const stubSponsor = (over: Record<string, Handler> = {}) =>
  stubRpc({
    pm_getPaymasterStubData: () => ({ result: { ...pmResult(STUB_DATA).result, isFinal: false } }),
    pm_getPaymasterData: () => pmResult(DATA),
    ...over,
  });

/** A bundler that includes every op after one empty receipt poll, unless overridden. */
const stubBundler = (over: Record<string, Handler> = {}) => {
  let polls = 0;
  return stubRpc({
    pimlico_getUserOperationGasPrice: () => ({
      result: {
        slow: { maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1" },
        standard: { maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x5f5e100" },
        fast: { maxFeePerGas: "0xffffffff", maxPriorityFeePerGas: "0xffffffff" },
      },
    }),
    eth_estimateUserOperationGas: () => ({
      result: {
        callGasLimit: "0x30000",
        verificationGasLimit: "0x20000",
        preVerificationGas: "0x10000",
        paymasterVerificationGasLimit: "0x5555",
        paymasterPostOpGasLimit: "0x1",
      },
    }),
    eth_sendUserOperation: () => ({ result: USER_OP_HASH }),
    eth_getUserOperationReceipt: () =>
      polls++ === 0
        ? { result: null }
        : { result: { success: true, receipt: { transactionHash: TX_HASH } } },
    ...over,
  });
};

const executor = (sponsorUrl: string, bundlerUrl: string, over: { timeoutMs?: number } = {}) =>
  new BundlerExecutor({ client, bundlerUrl, sponsorUrl, pollIntervalMs: 10, ...over });

/** The sponsor's own parser of a paymaster request, and the address that signed it. */
const parsed = async (method: string, params: unknown) => {
  const request: PaymasterRequest = parsePaymasterRequest(params);
  return { request, signer: await recoverPaymasterRequestSigner(method as never, request) };
};

/** The op as the bundler received it, with the authorization (viem hashes `0x7702` through it). */
const sentOp = (rpc: RpcUserOperation<"0.8">, authorization?: SignedAuthorization) =>
  ({
    ...formatUserOperation(rpc),
    ...(authorization && { authorization }),
  }) as UserOperation<"0.8">;
const userOpHash = (op: UserOperation<"0.8">) =>
  getUserOperationHash({
    chainId: 5003,
    entryPointAddress: book.entryPoint,
    entryPointVersion: "0.8",
    userOperation: op,
  });

describe("BundlerExecutor", () => {
  it("sends the root's init UserOp: eip7702Auth with initCode 0x7702, sized by the bundler, sponsored, root-signed", async () => {
    const sponsor = await stubSponsor();
    const bundler = await stubBundler();
    const authorization = await root.signAuthorization({
      address: book.caliburEntry,
      chainId: 5003,
      nonce: 0,
    });
    const request = execRequest({ authorization });

    const result = await executor(sponsor.url, bundler.url).submit(request);

    expect(result).toEqual({ hash: TX_HASH, success: true });
    expect(sponsor.healthCalls()).toBe(1);
    expect(nonceKeys).toEqual([0n]);
    expect(sponsor.calls.map((c) => c.method)).toEqual([
      "pm_getPaymasterStubData",
      "pm_getPaymasterData",
    ]);
    expect(bundler.calls.map((c) => c.method)).toEqual([
      "pimlico_getUserOperationGasPrice",
      "eth_estimateUserOperationGas",
      "eth_sendUserOperation",
      "eth_getUserOperationReceipt",
      "eth_getUserOperationReceipt",
    ]);

    // Both paymaster requests pass the sponsor's parser, signed by the root for keyHash 0.
    const stub = await parsed("pm_getPaymasterStubData", sponsor.of("pm_getPaymasterStubData")[0]);
    const data = await parsed("pm_getPaymasterData", sponsor.of("pm_getPaymasterData")[0]);
    for (const { request: r, signer } of [stub, data]) {
      expect(signer).toBe(root.address);
      expect(r).toMatchObject({ entryPoint: book.entryPoint, chainId: 5003 });
      expect(r.auth).toMatchObject({ sponsor: SPONSOR, keyHash: ROOT_KEY_HASH });
      expect(r.auth.validAfter).toBeLessThanOrEqual(now());
      expect(r.auth.validUntil - now()).toBeGreaterThan(50);
      expect(r.auth.validUntil - now()).toBeLessThanOrEqual(60);
      expect(r.userOp).toMatchObject({
        sender: root.address,
        nonce: NONCE,
        factory: "0x7702",
        authorization: { address: book.caliburEntry, chainId: 5003, nonce: 0 },
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 100_000_000n,
      });
      expect(toPackedUserOperation({ ...r.userOp, signature: "0x" }).initCode).toBe("0x7702");
      expect(decodeUserOpCallData(r.userOp.callData)).toEqual({
        calls: request.calls,
        revertOnFailure: true,
      });
    }
    // The sponsorship is for the sized op: the bundler's call gas and PVG, 150 % verification gas.
    expect(data.request.userOp).toMatchObject({
      callGasLimit: 0x30000n,
      verificationGasLimit: (0x20000n * 150n) / 100n,
      preVerificationGas: 0x10000n,
    });

    // The bundler estimated the op with the stub, and received it with the sponsorship: the
    // sponsor's paymaster gas limits (its signature covers them), not the bundler's estimate.
    const [estimated] = bundler.of("eth_estimateUserOperationGas")[0] as [RpcUserOperation<"0.8">];
    expect(estimated).toMatchObject({ paymasterData: STUB_DATA, factory: "0x7702" });
    const [sent, entryPoint] = bundler.of("eth_sendUserOperation")[0] as [
      RpcUserOperation<"0.8">,
      Address,
    ];
    expect(entryPoint).toBe(book.entryPoint);
    expect(sent).toMatchObject({
      paymaster: book.verifyingPaymaster,
      paymasterData: DATA,
      paymasterVerificationGasLimit: "0xea60",
      paymasterPostOpGasLimit: "0x0",
      callGasLimit: toHex(0x30000n),
      verificationGasLimit: toHex(0x30000n),
      preVerificationGas: toHex(0x10000n),
      factory: "0x7702",
      eip7702Auth: { address: book.caliburEntry },
    });
    // The root's signature is raw over the userOpHash of exactly the op sent.
    const op = sentOp(sent, authorization);
    expect(await recoverAddress({ hash: userOpHash(op), signature: op.signature })).toBe(
      root.address,
    );
    expect(bundler.of("eth_getUserOperationReceipt")[0]).toEqual([USER_OP_HASH]);
  });

  it("sends a session UserOp on the key's own lane, without eip7702Auth or initCode, its signature wrapped with the keyHash", async () => {
    const sponsor = await stubSponsor();
    const bundler = await stubBundler();

    expect(await executor(sponsor.url, bundler.url).submit(sessionRequest())).toEqual({
      hash: TX_HASH,
      success: true,
    });

    const lane = laneOf(SESSION_KEY_HASH);
    expect(nonceKeys).toEqual([lane]);
    for (const method of ["pm_getPaymasterStubData", "pm_getPaymasterData"]) {
      const { request, signer } = await parsed(method, sponsor.of(method)[0]);
      expect(signer).toBe(session.address);
      expect(request.auth.keyHash).toBe(SESSION_KEY_HASH);
      expect(request.userOp.nonce).toBe((lane << 64n) | NONCE);
      expect(request.userOp.factory).toBeUndefined();
      expect(request.userOp.authorization).toBeUndefined();
    }
    const [sent] = bundler.of("eth_sendUserOperation")[0] as [RpcUserOperation<"0.8">];
    expect(sent.factory ?? null).toBeNull();
    expect(sent.eip7702Auth ?? null).toBeNull();
    const op = sentOp(sent);
    expect(toPackedUserOperation(op).initCode).toBe("0x");
    const [keyHash, signature, hookData] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
      op.signature,
    );
    expect([keyHash, hookData]).toEqual([SESSION_KEY_HASH, "0x"]);
    expect(await recoverAddress({ hash: userOpHash(op), signature })).toBe(session.address);
  });

  it("refuses to attach eip7702Auth to a session UserOp, before reading or sending anything", async () => {
    const sponsor = await stubSponsor();
    const bundler = await stubBundler();
    const authorization = await root.signAuthorization({
      address: book.caliburEntry,
      chainId: 5003,
      nonce: 0,
    });

    await expect(
      executor(sponsor.url, bundler.url).submit(sessionRequest({ authorization })),
    ).rejects.toThrow(/Refusing to attach eip7702Auth to a session UserOperation/);
    expect(sponsor.calls).toHaveLength(0);
    expect(sponsor.healthCalls()).toBe(0);
    expect(bundler.calls).toHaveLength(0);
    expect(nonceKeys).toHaveLength(0);
  });

  it.each(["pm_getPaymasterStubData", "pm_getPaymasterData"])(
    "maps SPONSOR_BUSY from %s to SponsorBusyError, and sends nothing to the bundler",
    async (method) => {
      const sponsor = await stubSponsor({
        [method]: () => rejection(SponsorRejectCode.SPONSOR_BUSY),
      });
      const bundler = await stubBundler();
      await expect(
        executor(sponsor.url, bundler.url).submit(sessionRequest()),
      ).rejects.toBeInstanceOf(SponsorBusyError);
      expect(sponsor.of(method)).toHaveLength(1);
      expect(bundler.of("eth_sendUserOperation")).toHaveLength(0);
    },
  );

  it.each([
    ["pm_getPaymasterStubData", SponsorRejectCode.WRONG_LANE],
    ["pm_getPaymasterStubData", SponsorRejectCode.ROOT_LANE_MISUSE],
    ["pm_getPaymasterStubData", SponsorRejectCode.INIT_CODE_INVALID],
    ["pm_getPaymasterData", SponsorRejectCode.NOT_ALLOWLISTED],
    ["pm_getPaymasterData", SponsorRejectCode.SIMULATION_FAILED],
  ])(
    "maps the rejection from %s with %s to SponsorRejectedError with its reason and detail",
    async (method, reason) => {
      const sponsor = await stubSponsor({ [method]: () => rejection(reason) });
      const bundler = await stubBundler();
      const error = await executor(sponsor.url, bundler.url)
        .submit(sessionRequest())
        .catch((e) => e);
      expect(error).toBeInstanceOf(SponsorRejectedError);
      expect(error.reason).toBe(reason);
      expect(error.message).toContain("the detail");
      expect(bundler.of("eth_sendUserOperation")).toHaveLength(0);
    },
  );

  it("refuses a sponsorship by another paymaster, and reports other sponsor errors as plain errors", async () => {
    const bundler = await stubBundler();
    const other = await stubSponsor({
      pm_getPaymasterData: () => ({
        result: { ...pmResult(DATA).result, paymaster: SPONSOR },
      }),
    });
    await expect(executor(other.url, bundler.url).submit(sessionRequest())).rejects.toThrow(
      /Sponsor answered with paymaster/,
    );
    const internal = await stubSponsor({
      pm_getPaymasterStubData: () => ({ error: { code: -32603, message: "Internal error" } }),
    });
    const error = await executor(internal.url, bundler.url)
      .submit(sessionRequest())
      .catch((e) => e);
    expect(error).not.toBeInstanceOf(SponsorRejectedError);
    expect(error.message).toMatch(/-32603/);
    expect(bundler.of("eth_sendUserOperation")).toHaveLength(0);
  });

  it("maps a bundler simulation revert to ExecutionRevertedError, other bundler errors to plain errors, and returns a reverted op as success false", async () => {
    const sponsor = await stubSponsor();
    const reverting = await stubBundler({
      eth_estimateUserOperationGas: () => ({
        error: { code: -32521, message: "UserOperation reverted", data: "0xdeadbeef" },
      }),
    });
    const reverted = await executor(sponsor.url, reverting.url)
      .submit(sessionRequest())
      .catch((e) => e);
    expect(reverted).toBeInstanceOf(ExecutionRevertedError);
    expect(reverted.data).toBe("0xdeadbeef");

    const refusing = await stubBundler({
      eth_sendUserOperation: () => ({ error: { code: -32507, message: "AA34 signature error" } }),
    });
    const refused = await executor(sponsor.url, refusing.url)
      .submit(sessionRequest())
      .catch((e) => e);
    expect(refused).not.toBeInstanceOf(ExecutionRevertedError);
    expect(refused.message).toMatch(/Bundler error -32507: AA34/);

    const failing = await stubBundler({
      eth_getUserOperationReceipt: () => ({
        result: { success: false, receipt: { transactionHash: TX_HASH } },
      }),
    });
    expect(await executor(sponsor.url, failing.url).submit(sessionRequest())).toEqual({
      hash: TX_HASH,
      success: false,
    });
  });

  it("bounds the sponsorship by the request's deadline, and refuses a deadline already past", async () => {
    const sponsor = await stubSponsor();
    const bundler = await stubBundler();
    const deadline = now() + 20;
    await executor(sponsor.url, bundler.url).submit(sessionRequest({ deadline: BigInt(deadline) }));
    const { request } = await parsed("pm_getPaymasterData", sponsor.of("pm_getPaymasterData")[0]);
    expect(request.auth.validUntil).toBe(deadline);

    await expect(
      executor(sponsor.url, bundler.url).submit(sessionRequest({ deadline: BigInt(now()) })),
    ).rejects.toThrow(/deadline .* has passed/);
    expect(sponsor.of("pm_getPaymasterStubData")).toHaveLength(1);
  });

  it("bounds the receipt wait and a bundler that never answers", async () => {
    const sponsor = await stubSponsor();
    const pending = await stubBundler({ eth_getUserOperationReceipt: () => ({ result: null }) });
    await expect(
      executor(sponsor.url, pending.url, { timeoutMs: 1_000 }).submit(sessionRequest()),
    ).rejects.toThrow(new RegExp(`UserOperation ${USER_OP_HASH} not included after 1000 ms`));

    const hang = await stubBundler({ eth_sendUserOperation: () => "hang" });
    const started = performance.now();
    await expect(
      executor(sponsor.url, hang.url, { timeoutMs: 1_000 }).submit(sessionRequest()),
    ).rejects.toThrow(/Bundler did not answer within 1000 ms/);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
