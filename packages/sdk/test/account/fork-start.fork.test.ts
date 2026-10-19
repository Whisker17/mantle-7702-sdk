import { describe, expect, it } from "vitest";
import { clientFor, startFork } from "./fork.js";

// Needs anvil; skipped with the other fork suites when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;

describe.skipIf(!rpcUrl)("startFork", () => {
  it("starts two forks side by side on ports the OS picked", async () => {
    const [a, b] = await Promise.all([startFork(rpcUrl as string), startFork(rpcUrl as string)]);
    try {
      expect(a.url).not.toBe(b.url);
      expect(await clientFor(a.url).getChainId()).toBe(5003);
      expect(await clientFor(b.url).getChainId()).toBe(5003);
    } finally {
      a.stop();
      b.stop();
    }
  }, 60_000);

  it("retries, then reports anvil's own error with the fork URL redacted", async () => {
    // Nothing listens on port 1, so anvil cannot reach the fork RPC. The wording around the cause
    // differs between anvil versions ("failed to get fork block number", "… network chain ID").
    const start = startFork("http://user:secret@127.0.0.1:1/key");
    await expect(start).rejects.toThrow(
      /^anvil exited with 1: Error: .*Connection refused.*\n\(3 attempts\)$/s,
    );
    await expect(start).rejects.not.toThrow(/secret|key/);
  }, 60_000);
});
