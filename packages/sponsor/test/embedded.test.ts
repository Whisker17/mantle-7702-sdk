import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { EMBEDDED_RELAYER_KEY_ENV, startEmbeddedSponsor } from "../src/embedded.js";

// Never called: an empty ledger reconciles without the chain, and no request is sent here.
const DEAD_RPC = "http://127.0.0.1:1";
const key = generatePrivateKey();
const relayer = privateKeyToAccount(key).address;
const allowlist = [privateKeyToAccount(generatePrivateKey()).address];
const handles = (type: string) => process.getActiveResourcesInfo().filter((t) => t === type).length;

describe("startEmbeddedSponsor", () => {
  it.each([
    ["unset", {}],
    ["0", { MANTLE_AA_EMBEDDED_RELAYER: "0" }],
    ["true", { MANTLE_AA_EMBEDDED_RELAYER: "true" }],
  ])("refuses to start when MANTLE_AA_EMBEDDED_RELAYER is %s", async (_, env) => {
    const servers = handles("TCPServerWrap");
    await expect(
      startEmbeddedSponsor({
        rpcUrl: DEAD_RPC,
        allowlist,
        env: { ...env, [EMBEDDED_RELAYER_KEY_ENV]: key },
      }),
    ).rejects.toThrow(/MANTLE_AA_EMBEDDED_RELAYER=1/);
    expect(handles("TCPServerWrap")).toBe(servers);
  });

  it("refuses a missing or malformed relayer key without echoing it", async () => {
    const env = { MANTLE_AA_EMBEDDED_RELAYER: "1" };
    await expect(startEmbeddedSponsor({ rpcUrl: DEAD_RPC, allowlist, env })).rejects.toThrow(
      /MANTLE_AA_RELAYER_KEY must hold/,
    );
    const error = await startEmbeddedSponsor({
      rpcUrl: DEAD_RPC,
      allowlist,
      env: { ...env, [EMBEDDED_RELAYER_KEY_ENV]: key.slice(0, -2) },
    }).catch((e: Error) => e);
    expect(String(error)).not.toContain(key.slice(2, -2));
  });

  it("starts the sponsor on loopback with the local key, and close leaves nothing open", async () => {
    const database = join(mkdtempSync(join(tmpdir(), "embedded-sponsor-")), "sponsor.sqlite");
    const servers = handles("TCPServerWrap");
    const timers = handles("Timeout");
    const sponsor = await startEmbeddedSponsor({
      rpcUrl: DEAD_RPC,
      allowlist,
      database,
      pollIntervalMs: 50,
      env: { MANTLE_AA_EMBEDDED_RELAYER: "1", [EMBEDDED_RELAYER_KEY_ENV]: key },
    });
    expect(sponsor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sponsor.relayer).toBe(relayer);
    const health = await fetch(`${sponsor.url}/health`).then((r) => r.json());
    expect(health).toEqual({ status: "ok", chainId: 5003, sponsor: relayer });
    // The open database keeps its write-ahead log; the settlement loop sleeps on a timer.
    expect(existsSync(`${database}-wal`)).toBe(true);
    expect(handles("TCPServerWrap")).toBe(servers + 1);
    expect(handles("Timeout")).toBeGreaterThan(timers);

    await sponsor.close();

    // libuv frees a closed handle on a later loop turn.
    await vi.waitFor(() => expect(handles("TCPServerWrap")).toBe(servers), { timeout: 1000 });
    expect(handles("Timeout")).toBeLessThanOrEqual(timers);
    // SQLite removes the log when the last connection closes.
    expect(existsSync(`${database}-wal`)).toBe(false);
    await expect(fetch(`${sponsor.url}/health`)).rejects.toThrow();
  });
});
