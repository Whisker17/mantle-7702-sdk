import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Address,
  createClient,
  custom,
  getAddress,
  type Hex,
  type SignedAuthorization,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeExecute,
  type ExecRequest,
  loadDeployments,
  mantleSepolia,
  PrivateKeySigner,
  parseRelayRequest,
  RelayerExecutor,
  type RelayRequest,
  type RelayResult,
  ROOT_KEY_HASH,
  recoverRelayRequestSigner,
  SPONSOR_REJECTED_RPC_CODE,
  SponsorBusyError,
  SponsorRejectCode,
  SponsorRejectedError,
} from "../../src/index.js";

const book = loadDeployments();
const RELAYER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const root = new PrivateKeySigner(`0x${"11".repeat(32)}`);
const HASH: Hex = `0x${"aa".repeat(32)}`;
const DIGEST: Hex = `0x${"bb".repeat(32)}`;

// An undelegated account: the Calibur domain is computed offline and the nonce is `lane << 64`.
const client = createClient({
  chain: mantleSepolia,
  transport: custom({
    async request({ method }) {
      if (method === "eth_getCode") return "0x";
      throw new Error(`unexpected RPC ${method}`);
    },
  }),
});

const execRequest = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  account: root.address,
  keyHash: ROOT_KEY_HASH,
  calls: [{ to: root.address, value: 0n, data: "0x" }],
  lane: 0n,
  signer: root,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  ...over,
});

type Reply = { result: RelayResult } | { error: object } | { status: number } | "hang";

/**
 * A stub sponsor: answers each `sponsor_relay` with the next scripted reply (the last repeats),
 * calling `onRelay` as each one arrives.
 */
async function stubSponsor(
  replies: Reply[],
  health: object = { chainId: 5003, sponsor: RELAYER },
  onRelay = () => {},
) {
  const bodies: string[] = [];
  let healthCalls = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: object) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && req.url === "/health") {
      healthCalls++;
      return send(200, health);
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    onRelay();
    const reply = replies[Math.min(bodies.length, replies.length) - 1] as Reply;
    if (reply === "hang") return;
    if ("status" in reply) return send(reply.status, {});
    send(200, { jsonrpc: "2.0", id: JSON.parse(body).id, ...reply });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return {
    url,
    bodies,
    healthCalls: () => healthCalls,
    requests: () => bodies.map((b) => JSON.parse(b).params[0] as RelayRequest),
  };
}
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.close();
    s.closeAllConnections();
  }
});

const executor = (url: string, over: { timeoutMs?: number; relayer?: Address } = {}) =>
  new RelayerExecutor({ client, url, relayer: RELAYER, pollIntervalMs: 10, ...over });
const rejection = (reason: string, detail = "why") => ({
  error: { code: SPONSOR_REJECTED_RPC_CODE, message: "rejected", data: { reason, detail } },
});
const settled = (status: RelayResult["status"], hash: Hex | null = HASH): Reply => ({
  result: { status, batchDigest: DIGEST, ...(hash && { hash }), fee: "1" },
});

describe("RelayerExecutor", () => {
  it("sends one signed sponsor_relay whose batch names the relayer and whose request the sponsor accepts", async () => {
    const sponsor = await stubSponsor([settled("success")]);
    const authorization: SignedAuthorization = await root.signAuthorization({
      address: book.caliburEntry,
      chainId: 5003,
      nonce: 0,
    });
    expect(typeof authorization.v).toBe("bigint");
    const result = await executor(sponsor.url).submit(execRequest({ authorization }));
    expect(result).toEqual({ hash: HASH, success: true });

    const [body] = sponsor.bodies;
    expect(JSON.parse(body as string)).toMatchObject({ jsonrpc: "2.0", method: "sponsor_relay" });
    const [wire] = sponsor.requests();
    // The sponsor's own parser accepts it, and the digest is signed by the batch's key.
    const parsed = parseRelayRequest(wire);
    expect(await recoverRelayRequestSigner(parsed)).toBe(root.address);
    const { signedBatchedCall } = decodeExecute(parsed.data);
    expect(signedBatchedCall.executor).toBe(RELAYER);
    expect(signedBatchedCall.nonce).toBe(0n);
    expect(parsed.auth).toMatchObject({
      chainId: 5003,
      sponsor: RELAYER,
      entry: book.caliburEntry,
    });
    const now = Math.floor(Date.now() / 1000);
    expect(parsed.auth.validAfter).toBeLessThanOrEqual(now);
    expect(parsed.auth.validUntil).toBeGreaterThan(now);
    expect(parsed.authorization).toMatchObject({
      address: getAddress(book.caliburEntry),
      chainId: 5003,
      nonce: 0,
      yParity: authorization.yParity,
    });
  });

  it("reads the relayer from the sponsor's health once, and refuses a sponsor on another chain", async () => {
    const sponsor = await stubSponsor([settled("success")]);
    const ex = new RelayerExecutor({ client, url: `${sponsor.url}/`, pollIntervalMs: 10 });
    await ex.submit(execRequest());
    await ex.submit(execRequest());
    expect(sponsor.healthCalls()).toBe(1);
    expect(decodeExecute(sponsor.requests()[0]?.data as Hex).signedBatchedCall.executor).toBe(
      RELAYER,
    );

    const other = await stubSponsor([settled("success")], { chainId: 5000, sponsor: RELAYER });
    await expect(
      new RelayerExecutor({ client, url: other.url }).submit(execRequest()),
    ).rejects.toThrow(/chain 5000/);
    expect(other.bodies).toHaveLength(0);
  });

  it("re-posts the same request while it is pending, until it settles", async () => {
    const sponsor = await stubSponsor([
      settled("pending", null),
      settled("pending"),
      settled("success"),
    ]);
    expect(await executor(sponsor.url).submit(execRequest())).toEqual({
      hash: HASH,
      success: true,
    });
    expect(sponsor.bodies).toHaveLength(3);
    expect(new Set(sponsor.bodies).size).toBe(1);
  });

  it("returns a mined revert as success false, for the caller's revert handling", async () => {
    const sponsor = await stubSponsor([settled("reverted")]);
    expect(await executor(sponsor.url).submit(execRequest())).toEqual({
      hash: HASH,
      success: false,
    });
  });

  it("maps a cancelled relay to SponsorRejectedError CANCELLED", async () => {
    const sponsor = await stubSponsor([settled("cancelled")]);
    const error = await executor(sponsor.url)
      .submit(execRequest())
      .catch((e) => e);
    expect(error).toBeInstanceOf(SponsorRejectedError);
    expect(error.reason).toBe("CANCELLED");
  });

  it("maps SPONSOR_BUSY to SponsorBusyError without retrying", async () => {
    const sponsor = await stubSponsor([rejection(SponsorRejectCode.SPONSOR_BUSY)]);
    await expect(executor(sponsor.url).submit(execRequest())).rejects.toBeInstanceOf(
      SponsorBusyError,
    );
    expect(sponsor.bodies).toHaveLength(1);
  });

  it.each([
    SponsorRejectCode.SIMULATION_FAILED,
    SponsorRejectCode.WRONG_EXECUTOR,
    SponsorRejectCode.NOT_ALLOWLISTED,
  ])("maps the rejection %s to SponsorRejectedError with its reason and detail", async (reason) => {
    const sponsor = await stubSponsor([rejection(reason, "the detail")]);
    const error = await executor(sponsor.url)
      .submit(execRequest())
      .catch((e) => e);
    expect(error).toBeInstanceOf(SponsorRejectedError);
    expect(error.reason).toBe(reason);
    expect(error.message).toContain("the detail");
  });

  it("reports other JSON-RPC errors, HTTP errors and malformed results as plain errors", async () => {
    const internal = await stubSponsor([{ error: { code: -32603, message: "Internal error" } }]);
    const e1 = await executor(internal.url)
      .submit(execRequest())
      .catch((e) => e);
    expect(e1).not.toBeInstanceOf(SponsorRejectedError);
    expect(e1.message).toMatch(/-32603/);

    const http = await stubSponsor([{ status: 502 }]);
    await expect(executor(http.url).submit(execRequest())).rejects.toThrow(/HTTP 502/);

    const bad = await stubSponsor([{ result: { status: "done", batchDigest: DIGEST } as never }]);
    await expect(executor(bad.url).submit(execRequest())).rejects.toThrow(/malformed/);

    const noHash = await stubSponsor([settled("success", null)]);
    await expect(executor(noHash.url).submit(execRequest())).rejects.toThrow(/without a hash/);
  });

  // Both bounds run on a virtual clock (`Date.now`), so set-up time and machine load cannot move
  // the deadline: only the stub sponsor advances it, and only on a relay.
  it("bounds a request that stays pending, and a sponsor that never answers", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);

    // Each pending answer costs 25 s of a 60 s budget, so the third passes the deadline and the
    // executor stops re-posting there. No post gets under 10 s of real abort time, so none aborts.
    const pending = await stubSponsor([settled("pending")], undefined, () => {
      now += 25_000;
    });
    await expect(
      executor(pending.url, { timeoutMs: 60_000 }).submit(execRequest()),
    ).rejects.toThrow(/still pending after 60000 ms \(transaction 0x/);
    expect(pending.bodies).toHaveLength(3);
    expect(new Set(pending.bodies).size).toBe(1);

    // The clock stands still, so only the executor's 200 ms abort can end a request that hangs.
    const hang = await stubSponsor(["hang"]);
    const started = performance.now();
    await expect(executor(hang.url, { timeoutMs: 200 }).submit(execRequest())).rejects.toThrow(
      /did not answer within 200 ms/,
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(hang.bodies).toHaveLength(1);
  });
});
