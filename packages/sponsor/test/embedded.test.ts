import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
    // The sponsor's own timers: those created in its async context. A count of every Timeout in the
    // worker would include the test runner's own. A timer that fired or was cleared is marked
    // `_destroyed` at once; the async_hooks `destroy` callback only follows on a later loop turn.
    const context = new AsyncLocalStorage<true>();
    type Timer = NodeJS.Timeout & { _destroyed: boolean };
    const timers: Timer[] = [];
    const hook = createHook({
      init(_id, type, _trigger, resource) {
        if (type === "Timeout" && context.getStore()) timers.push(resource as Timer);
      },
    }).enable();
    onTestFinished(() => void hook.disable());
    const sponsorTimers = () => timers.filter((t) => t.hasRef() && !t._destroyed).length;
    const sponsor = await context.run(true, () =>
      startEmbeddedSponsor({
        rpcUrl: DEAD_RPC,
        allowlist,
        database,
        pollIntervalMs: 50,
        env: { MANTLE_AA_EMBEDDED_RELAYER: "1", [EMBEDDED_RELAYER_KEY_ENV]: key },
      }),
    );
    expect(sponsor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sponsor.relayer).toBe(relayer);
    const health = await fetch(`${sponsor.url}/health`).then((r) => r.json());
    expect(health).toEqual({ status: "ok", chainId: 5003, sponsor: relayer });
    // The open database keeps its write-ahead log; the settlement loop sleeps on its one timer.
    expect(existsSync(`${database}-wal`)).toBe(true);
    expect(handles("TCPServerWrap")).toBe(servers + 1);
    // Past a few polls, so the timer is one the loop armed again after a reconciliation.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sponsorTimers()).toBe(1);

    await sponsor.close();

    // libuv frees a closed handle on a later loop turn.
    await vi.waitFor(() => expect(handles("TCPServerWrap")).toBe(servers), { timeout: 1000 });
    expect(sponsorTimers()).toBe(0);
    // SQLite removes the log when the last connection closes.
    expect(existsSync(`${database}-wal`)).toBe(false);
    await expect(fetch(`${sponsor.url}/health`)).rejects.toThrow();
  });
});
