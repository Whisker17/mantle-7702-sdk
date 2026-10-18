import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrivateKeySigner,
  type RelayResult,
  ROOT_KEY_HASH,
  relayRequestDigest,
  SPONSOR_REJECTED_RPC_CODE,
  SponsorRejectCode,
} from "@mantle-aa/sdk";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SponsorRejection } from "../src/auth.js";
import { main } from "../src/main.js";
import { sponsorRelay } from "../src/server.js";
import { SponsorStore } from "../src/store.js";
import { nowSeconds, relayRequest, stubClient, testConfig, undelegatedClient } from "./fixtures.js";

// Nothing listens on port 1: a request that reaches the chain fails as an internal error.
const DEAD_RPC = "http://user:secret@127.0.0.1:1";

describe("sponsor service over HTTP", () => {
  let sponsor: Awaited<ReturnType<typeof main>>;
  const root = new PrivateKeySigner(generatePrivateKey());
  const relayerKey = generatePrivateKey();
  const relayer = privateKeyToAccount(relayerKey).address;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sponsor-server-"));
    process.env.SPONSOR_SERVER_TEST_RPC = DEAD_RPC;
    process.env.SPONSOR_SERVER_TEST_KEY = relayerKey;
    writeFileSync(
      join(dir, "sponsor.yaml"),
      `chainId: 5003
rpcUrl: \${SPONSOR_SERVER_TEST_RPC}
listen: { host: 127.0.0.1, port: 0 }
database: ./sponsor.sqlite
relayer: "${relayer}"
relayerKey: \${SPONSOR_SERVER_TEST_KEY}
policy:
  allowlist: ["${root.address}"]
  accountDailyGas: 5000000
  maxFeePerRequestMnt: "0.05"
  dailyBudgetMnt: "5"
  managementReserveMnt: "1"
`,
    );
    sponsor = await main(["--config", join(dir, "sponsor.yaml")]);
  });
  afterAll(async () => {
    await sponsor?.close();
    delete process.env.SPONSOR_SERVER_TEST_RPC;
    delete process.env.SPONSOR_SERVER_TEST_KEY;
  });

  const rpc = async (body: unknown) => {
    const res = await fetch(sponsor.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<{
      id: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: { reason: string; detail: string } };
    }>;
  };
  const relay = (params: unknown, id: unknown = 1) =>
    rpc({ jsonrpc: "2.0", id, method: "sponsor_relay", params });

  it("starts on an ephemeral port and passes a health check", async () => {
    expect(sponsor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sponsor.url).not.toMatch(/:8548$/);
    const res = await fetch(`${sponsor.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      chainId: 5003,
      sponsor: relayer,
    });
    // With a relayer key it runs a ledger, reconciled at start (nothing to reconcile here).
    expect(sponsor.ledger?.relayer).toBe(relayer);
    expect((await fetch(`${sponsor.url}/nope`)).status).toBe(404);
  });

  it("answers JSON-RPC protocol errors", async () => {
    expect((await rpc("{not json")).error?.code).toBe(-32700);
    expect((await rpc({ id: 1, method: "sponsor_relay" })).error?.code).toBe(-32600);
    const unknown = await rpc({ jsonrpc: "2.0", id: 7, method: "eth_sendTransaction" });
    expect([unknown.id, unknown.error?.code]).toEqual([7, -32601]);
  });

  it("returns a structured reason for a rejected request", async () => {
    const malformed = await relay({ sender: "0x12" }, "a");
    expect(malformed.id).toBe("a");
    expect(malformed.error?.code).toBe(SPONSOR_REJECTED_RPC_CODE);
    expect(malformed.error?.data?.reason).toBe(SponsorRejectCode.INVALID_PARAMS);
    expect(malformed.error?.data?.detail).toMatch(/params must be \[request\]/);

    const request = await relayRequest({
      client: undelegatedClient(),
      account: root.address,
      signer: root,
      keyHash: ROOT_KEY_HASH,
      auth: { chainId: 5000 },
    });
    const wrongChain = await relay([request]);
    expect(wrongChain.error).toMatchObject({
      code: SPONSOR_REJECTED_RPC_CODE,
      message: "Sponsor rejected the request: WRONG_CHAIN",
      data: { reason: SponsorRejectCode.WRONG_CHAIN },
    });

    const stranger = new PrivateKeySigner(generatePrivateKey());
    const notListed = await relay([
      await relayRequest({
        client: undelegatedClient(),
        account: stranger.address,
        signer: stranger,
        keyHash: ROOT_KEY_HASH,
        executor: relayer,
        auth: { sponsor: relayer },
      }),
    ]);
    expect(notListed.error?.data?.reason).toBe(SponsorRejectCode.NOT_ALLOWLISTED);
  });

  it("never echoes the RPC URL when the chain is unreachable", async () => {
    const request = await relayRequest({
      client: undelegatedClient(),
      account: root.address,
      signer: root,
      keyHash: ROOT_KEY_HASH,
      executor: relayer,
      auth: { sponsor: relayer },
    });
    const response = await relay([request]);
    expect(response.error).toEqual({ code: -32603, message: "Internal error" });
    expect(JSON.stringify(response)).not.toContain("secret");
  });
});

describe("sponsorRelay", () => {
  const root = new PrivateKeySigner(generatePrivateKey());
  const config = testConfig();
  const issued: RelayResult = {
    status: "success",
    hash: `0x${"ab".repeat(32)}`,
    batchDigest: `0x${"cd".repeat(32)}`,
    fee: "1",
  };
  const expired = (calls?: { to: Address; value: bigint; data: Hex }[]) =>
    relayRequest({
      client: undelegatedClient(),
      account: root.address,
      signer: root,
      keyHash: ROOT_KEY_HASH,
      ...(calls ? { calls } : {}),
      auth: { validAfter: 1, validUntil: nowSeconds() - 1 },
    });

  it("returns an issued result by the authenticated request digest, whatever its validity", async () => {
    const request = await expired();
    const ledger = {
      find: (digest: Hex) =>
        digest === relayRequestDigest(request) ? Promise.resolve(issued) : undefined,
      relay: () => Promise.reject(new Error("must not pay again")),
    };
    // No chain access, no allowlist: the lookup comes first.
    const ctx = { config, client: stubClient({}), store: new SponsorStore(":memory:"), ledger };
    expect(await sponsorRelay(ctx, request)).toEqual(issued);

    const reason = (params: unknown) =>
      sponsorRelay(ctx, params).then(
        () => undefined,
        (e: SponsorRejection) => e.reason,
      );
    // A new request must still be valid now.
    const other = await expired([{ to: root.address, value: 1n, data: "0x" }]);
    expect(await reason(other)).toBe(SponsorRejectCode.REQUEST_EXPIRED);
    // Someone who copied the request but cannot sign it learns nothing.
    const forged = { ...request, auth: { ...request.auth, signature: other.auth.signature } };
    expect(await reason(forged)).toBe(SponsorRejectCode.BAD_REQUEST_SIGNATURE);
  });
});
