import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/index.js";

export const PASSWORD = "cli-test-password";
/** Cheap keystores: tests never pay geth's scrypt cost. */
const SCRYPT = { n: 1024, r: 8, p: 1 };

export const tempHome = (prefix = "mantle-aa-cli-") => mkdtempSync(join(tmpdir(), prefix));

/** The environment of one test home: never the real `~/.mantle-aa`, never `process.env`. */
export const testEnv = (home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  HOME: home,
  MANTLE_AA_HOME: join(home, ".mantle-aa"),
  MANTLE_AA_KEYSTORE_PASSWORD: PASSWORD,
  ...extra,
});

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  // biome-ignore lint/suspicious/noExplicitAny: the parsed --json output is checked by the tests.
  json: any;
}

/** Runs `mantle-aa <args> --json` in process, through the CLI's entry point. */
export async function cli(
  args: string[],
  env: NodeJS.ProcessEnv,
  /** `defaultScrypt`: keystores this run writes pay geth's cost, as outside the tests. */
  options: { stdin?: string; signal?: AbortSignal; json?: boolean; defaultScrypt?: boolean } = {},
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await run(options.json === false ? args : [...args, "--json"], {
    env,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    stdin: Readable.from([options.stdin ?? ""]),
    ...(!options.defaultScrypt && { scrypt: SCRYPT }),
    ...(options.signal && { signal: options.signal }),
  });
  const line = stdout.trim().split("\n")[0];
  return { code, stdout, stderr, json: line?.startsWith("{") ? JSON.parse(line) : undefined };
}

/** Values that vary between runs (addresses, hashes, paths, ports, times, fees) as placeholders. */
export function normalize(value: unknown, home?: string): unknown {
  const VOLATILE = new Set([
    "expiry",
    "anchor",
    "authorizationNonce",
    "caliburNonce",
    "latest",
    "pending",
    "nextNonce",
    "nonce",
    "day",
    "fee",
    "gas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
  ]);
  const text = (s: string) =>
    (home ? s.split(home).join("<home>") : s)
      .replace(/http:\/\/127\.0\.0\.1:\d+/g, "<local-url>")
      .replace(/0x(?!0{64}\b)[0-9a-fA-F]{64}\b/g, "<bytes32>")
      .replace(/0x(?!0{40}\b)[0-9a-fA-F]{40}\b/g, "<address>")
      .replace(/0x[0-9a-fA-F]{66,}/g, "<hex>");
  const walk = (v: unknown, key?: string): unknown => {
    if (key && VOLATILE.has(key) && v !== null && typeof v !== "object") return `<${key}>`;
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return walk(value);
}
