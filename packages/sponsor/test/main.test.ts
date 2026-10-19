import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";

// A synthetic credential marker: never a real key. Nothing listens on port 1, so the paymaster's
// signer check at startup fails on the RPC call.
const MARKER = "S3CRET-MARKER-7f3a";
const URLS = [
  ["userinfo", `http://user:${MARKER}@127.0.0.1:1`],
  ["a path token", `http://127.0.0.1:1/v2/${MARKER}`],
  ["a query token", `http://127.0.0.1:1/rpc?apikey=${MARKER}`],
] as const;
const ENTRY = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** A sponsor config whose startup reads the chain: the paymaster signer is checked first. */
function config(rpcUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "sponsor-main-"));
  const path = join(dir, "sponsor.yaml");
  writeFileSync(
    path,
    `chainId: 5003
rpcUrl: \${SPONSOR_MAIN_TEST_RPC}
listen: { host: 127.0.0.1, port: 0 }
database: ./sponsor.sqlite
relayer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
paymasterSignerKey: \${SPONSOR_MAIN_TEST_SIGNER}
policy:
  allowlist: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]
  accountDailyGas: 5000000
  maxFeePerRequestMnt: "0.05"
  dailyBudgetMnt: "5"
  managementReserveMnt: "1"
`,
  );
  return {
    path,
    env: { SPONSOR_MAIN_TEST_RPC: rpcUrl, SPONSOR_MAIN_TEST_SIGNER: generatePrivateKey() },
  };
}

/** Every form an error is read or logged in: message, String(), the cause chain, inspect(). */
function forms(error: unknown): string[] {
  const out = [inspect(error, { depth: 20 })];
  for (let e: unknown = error; e !== undefined && e !== null; e = (e as Error).cause) {
    out.push(String(e), String((e as Error).message), String((e as Error).stack));
  }
  return out;
}

describe("sponsor startup errors", () => {
  it.each(URLS)(
    "never carry an RPC URL with %s",
    async (_, url) => {
      const { path, env } = config(url);
      Object.assign(process.env, env);
      try {
        const error = await main(["--config", path]).then(
          (s) => s.close().then(() => undefined),
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        for (const text of forms(error)) expect(text).not.toContain(MARKER);
        expect((error as Error).message).toContain("<redacted-url>");
      } finally {
        for (const key of Object.keys(env)) delete process.env[key];
      }
    },
    60_000,
  );

  // The standalone entry (`node dist/main.js`, built by `pnpm build`): its stderr and exit code.
  it.each(URLS)(
    "the standalone sponsor's stderr never carries an RPC URL with %s",
    async (_, url) => {
      expect(existsSync(ENTRY), `${ENTRY} is missing: run pnpm build first`).toBe(true);
      const { path, env } = config(url);
      const child = spawn(process.execPath, [ENTRY, "--config", path], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d));
      child.stderr.on("data", (d: Buffer) => (output += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      clearTimeout(timer);
      expect(output).not.toContain(MARKER);
      expect(output).toContain("<redacted-url>");
      expect(code).toBe(1);
    },
    60_000,
  );
});
