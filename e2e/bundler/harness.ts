// Strict-mode bundler stack for the fork suites: an anvil fork of Mantle Sepolia and a pinned,
// patched Alto in safe mode (ERC-7562 tracing) against EntryPoint v0.8, started and stopped by the
// suite itself. On a fork, anvil serves Alto's `debug_traceCall` with JS tracers directly, so no
// trace proxy is needed (that is only for the real chain, see e2e/bundler/sepolia.sh).
//
// Needs Node, npm, `patch` and anvil; no secrets. Alto is installed once per lockfile+patch hash
// with `npm ci` from e2e/bundler/alto/ into the OS temp directory (outside the pnpm workspace).
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type Address,
  createTestClient,
  type Hex,
  http,
  type PublicActions,
  parseAbi,
  parseEther,
  publicActions,
  type TestClient,
  toHex,
  zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { ENTRY_POINT_V08 } from "./userop.js";

export { ENTRY_POINT_V08 };
export const ALTO_VERSION = "0.0.21";

const ALTO_DIR = fileURLToPath(new URL("./alto/", import.meta.url));
const PATCH = join(ALTO_DIR, "safe-validator.patch");
const run = promisify(execFile);

/**
 * Alto's simulation contracts on Mantle Sepolia (CREATE2 with the salt of the 0.1.0 utility key,
 * docs/infra.md §3.1). Passing them avoids deploying a fresh set on every fork at startup, which
 * needs many lazy fork fetches from the upstream RPC.
 */
const SIMULATION_CONTRACTS = [
  "--pimlico-simulation-contract",
  "0xf050608D8c131296BccA23A992E4F3f1135790a7",
  "--entrypoint-simulation-contract-v7",
  "0xcD13a28aF05Dc14Fba6e5ea95bBbC425248C2DC7",
  "--entrypoint-simulation-contract-v8",
  "0xcfFF0eb14cbA7ce1437190d4c856a47a9374e354",
  "--entrypoint-simulation-contract-v9",
  "0xC53c61c137986366E676B6F2A854947E8fF9e472",
];

/** Attempts at starting anvil when it exits during the start. */
const FORK_ATTEMPTS = 3;

/** A started process the harness owns; `stop` is idempotent. */
interface Owned {
  stop: () => Promise<void>;
}

/** Returns the path of the pinned, patched Alto CLI, installing it on first use. */
export async function installAlto(timeoutMs = 300_000): Promise<string> {
  const hash = createHash("sha256");
  for (const f of ["package.json", "package-lock.json", "safe-validator.patch"]) {
    hash.update(readFileSync(join(ALTO_DIR, f)));
  }
  const dir = join(tmpdir(), `mantle-7702-alto-${ALTO_VERSION}-${hash.digest("hex").slice(0, 12)}`);
  const cli = join(dir, "node_modules/@pimlico/alto/esm/cli/alto.js");
  if (existsSync(cli)) return cli;

  // Install into a private directory and rename it into place, so concurrent suites never see a
  // half-installed tree; the loser of a rename race uses the winner's install.
  const staging = mkdtempSync(`${dir}.tmp-`);
  try {
    for (const f of ["package.json", "package-lock.json"]) {
      copyFileSync(join(ALTO_DIR, f), join(staging, f));
    }
    await run("npm", ["ci", "--silent", "--no-audit", "--no-fund", "--ignore-scripts"], {
      cwd: staging,
      timeout: timeoutMs,
    });
    await run(
      "patch",
      ["-s", "-p1", "-d", join(staging, "node_modules/@pimlico/alto"), "-i", PATCH],
      {
        timeout: 30_000,
      },
    );
    try {
      renameSync(staging, dir);
    } catch (e) {
      if (!existsSync(cli)) throw e;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return cli;
}

/** A free TCP port on 127.0.0.1 (released before returning; the caller binds it right away). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/** Resolves when `url` answers `eth_chainId`; rejects after `timeoutMs` or if `child` exits. */
async function waitForRpc(url: string, child: ChildProcess, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${what} exited (${child.exitCode ?? child.signalCode}) before it answered`);
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok && "result" in ((await res.json()) as object)) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`${what} did not answer on ${url} within ${timeoutMs} ms`);
}

/**
 * Spawns `cmd`, keeps the tail of its output for diagnostics (or hands each stdout line to
 * `onLine`), and kills it on stop and on process exit.
 */
function own(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (data: Buffer) => {
    output = (output + data.toString()).slice(-100_000);
  };
  let partial = "";
  child.stdout?.on(
    "data",
    onLine
      ? (data: Buffer) => {
          const lines = (partial + data.toString()).split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) onLine(line);
        }
      : keep,
  );
  child.stderr?.on("data", keep);
  child.on("error", (e) => keep(Buffer.from(`spawn error: ${e.message}\n`)));
  const kill = () => child.kill("SIGKILL");
  process.once("exit", kill);
  const stop = async () => {
    process.off("exit", kill);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    if ((await Promise.race([exited, sleep(10_000, "timeout")])) === "timeout") {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(5_000)]);
    }
  };
  return { child, stop, output: () => output };
}

export interface Fork extends Owned {
  /** JSON-RPC URL of the fork (chain id 5003). */
  url: string;
}

/**
 * Starts anvil forking `upstreamRpcUrl` at its head (Prague rules, so EIP-7702 applies). It mines a
 * block for every transaction and, like a live chain, one every second besides (mixed mining):
 * Alto, and viem's receipt waits, notice an inclusion only on a later block, which a purely
 * automining fork never mines once the suite stops sending (docs/infra.md §10.6). anvil exits when
 * the upstream RPC fails while it builds the fork (HTTP 429 under parallel suites), so an exited
 * start is retried, as `packages/sdk/test/account/fork.ts` does.
 */
export async function startFork(upstreamRpcUrl: string, timeoutMs = 60_000): Promise<Fork> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const anvil = own("anvil", [
      "--fork-url",
      upstreamRpcUrl,
      "--port",
      String(port),
      "--hardfork",
      "prague",
      "--block-time",
      "1",
      "--mixed-mining",
      "--silent",
    ]);
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForRpc(url, anvil.child, timeoutMs, "anvil");
      return { url, stop: anvil.stop };
    } catch (e) {
      await anvil.stop();
      const output = anvil
        .output()
        .replace(/\w+:\/\/[^\s)]+/g, "<url>")
        .slice(-1_000);
      const message = `${(e as Error).message}: ${output} (${attempt} attempts)`;
      if (attempt === FORK_ATTEMPTS || !message.startsWith("anvil exited"))
        throw new Error(message);
      await sleep(1_000 * attempt);
    }
  }
}

export interface Bundler extends Owned {
  /** The bundler's JSON-RPC URL (ERC-7769 `eth_*UserOperation*` and `pimlico_*`). */
  url: string;
  entryPoint: Address;
  /** The executor (bundle sender) addresses, lowercase; their keys never leave the harness. */
  executors: Address[];
  /**
   * Alto's log since `since` (ms since the epoch; default: all), one line per entry, without its
   * block polling; an entry that recurs is shown once, at its first time, with its count.
   */
  timeline: (since?: number) => string;
  /**
   * Resolves once Alto has logged the ERC-7562 tracer result of a safe-mode validation of a
   * UserOp of `sender` at or after `since` (ms since the epoch); rejects after `timeoutMs` with
   * the timeline. Alto logs it for every validation it traces, before it answers.
   */
  traced: (sender: Address, since: number, timeoutMs?: number) => Promise<void>;
}

export interface AltoOptions {
  /** RPC Alto reads, traces (`debug_traceCall`) and submits through: an anvil fork in tests. */
  rpcUrl: string;
  /** Executor keys (the first is also the utility key); passed through Alto's environment, never argv. */
  executorKeys: Hex[];
  /** How long to wait for Alto to answer (ms); the install has its own 300 s bound. */
  timeoutMs?: number;
}

/** `HH:MM:SS.mmm` in local time. */
const clock = (ms: number) =>
  `${new Date(ms).toTimeString().slice(0, 8)}.${String(ms % 1000).padStart(3, "0")}`;

/** `validateUserOp(PackedUserOperation,bytes32,uint256)`: the account's frame in a validation trace. */
const VALIDATE_USER_OP = "0x19822f7c";

/** One Alto log entry (`--json`), reduced to a line of text; `traced` lists validated senders. */
interface AltoEntry {
  time: number;
  text: string;
  traced?: string[];
}

/** Parses one line of Alto's JSON log; block polling and unparsable lines give `undefined`. */
function altoEntry(line: string): AltoEntry | undefined {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  const { time, level, msg, module, body, result, data, method, err, ...rest } = e as {
    time: number;
    level: string;
    msg: string;
    module?: string;
    body?: { method?: string };
    result?: unknown;
    data?: { error?: unknown };
    method?: string;
    err?: { message?: string };
  };
  if (typeof time !== "number" || typeof msg !== "string") return undefined;
  const rpc = body?.method ?? method;
  if (/^eth_(blockNumber|getBlockByNumber)$/.test(rpc ?? "") && msg === "received response") {
    return undefined;
  }
  if (msg.startsWith("tracerResult: ")) {
    let trace: {
      callsFromEntryPoint?: { topLevelMethodSig?: string; topLevelTargetAddress?: string }[];
    } = {};
    try {
      trace = JSON.parse(msg.slice("tracerResult: ".length));
    } catch {
      // an unparsable trace names no sender
    }
    const traced = (trace.callsFromEntryPoint ?? [])
      .filter((c) => c.topLevelMethodSig === VALIDATE_USER_OP)
      .map((c) => String(c.topLevelTargetAddress).toLowerCase());
    return {
      time,
      traced,
      text: `${clock(time)} tracerResult (validation of ${traced.join(", ")})`,
    };
  }
  const parts = [clock(time), level === "info" ? "" : level.toUpperCase(), msg, rpc ?? ""];
  const error = (data as { error?: unknown } | undefined)?.error;
  if (msg === "sent reply" && error) parts.push(JSON.stringify(error).slice(0, 600));
  if (err?.message) parts.push(err.message.slice(0, 600));
  if (Object.keys(rest).length) parts.push(JSON.stringify(rest).slice(0, 600));
  return { time, text: parts.filter(Boolean).join(" ") };
}

/** Starts the pinned, patched Alto in safe mode against EntryPoint v0.8 on `rpcUrl`. */
export async function startAlto({
  rpcUrl,
  executorKeys,
  timeoutMs = 240_000,
}: AltoOptions): Promise<Bundler> {
  const cli = await installAlto();
  const port = await freePort();
  const entries: AltoEntry[] = [];
  const alto = own(
    process.execPath,
    [
      cli,
      "--entrypoints",
      ENTRY_POINT_V08,
      "--rpc-url",
      rpcUrl,
      "--safe-mode",
      "true",
      "--chain-type",
      "mantle",
      "--port",
      String(port),
      "--block-time",
      "1000",
      "--refilling-wallets",
      "false",
      "--deploy-simulations-contract",
      "false",
      ...SIMULATION_CONTRACTS,
      // Info level includes every RPC request Alto makes, so a stall shows what it waited on. JSON
      // lines are written synchronously, before the reply they precede, and parse without guessing.
      "--log-level",
      "info",
      "--json",
    ],
    {
      ALTO_EXECUTOR_PRIVATE_KEYS: executorKeys.join(","),
      ALTO_UTILITY_PRIVATE_KEY: executorKeys[0],
    },
    (line) => {
      const entry = altoEntry(line);
      if (entry) entries.push(entry);
    },
  );
  const timeline = (since = 0) => {
    const seen = new Map<string, { text: string; count: number }>();
    for (const { time, text } of entries) {
      if (time < since) continue;
      const key = text.slice(13);
      const known = seen.get(key);
      if (known) known.count++;
      else seen.set(key, { text, count: 1 });
    }
    return [...seen.values()]
      .map(({ text, count }) => (count > 1 ? `${text} (×${count})` : text))
      .join("\n")
      .slice(-60_000);
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForRpc(url, alto.child, timeoutMs, "alto");
  } catch (e) {
    await alto.stop();
    throw new Error(
      `${(e as Error).message}\n--- alto log ---\n${timeline().slice(-4_000)}${alto.output().slice(-4_000)}`,
    );
  }
  return {
    url,
    entryPoint: ENTRY_POINT_V08,
    executors: executorKeys.map((key) => privateKeyToAddress(key).toLowerCase() as Address),
    timeline,
    traced: async (sender, since, ms = 10_000) => {
      const address = sender.toLowerCase();
      const deadline = Date.now() + ms;
      while (!entries.some((e) => e.time >= since && e.traced?.includes(address))) {
        if (Date.now() > deadline) {
          throw new Error(
            `Alto logged no validation trace of a UserOp of ${sender} within ${ms} ms\n${timeline(since)}`,
          );
        }
        await sleep(100);
      }
    },
    stop: alto.stop,
  };
}

/** Anvil test actions plus public reads on the fork. */
export type ForkClient = TestClient<"anvil"> & PublicActions;
export const forkClient = (url: string): ForkClient =>
  createTestClient({ mode: "anvil", transport: http(url) }).extend(publicActions);

export interface BundlerStack extends Owned {
  /** The anvil fork's JSON-RPC URL. */
  rpcUrl: string;
  bundler: Bundler;
  client: ForkClient;
}

/**
 * The ring buffers Prague's system calls write at the start of every block: EIP-4788's beacon roots
 * (slots `timestamp % 8191` and `+ 8191`) and EIP-2935's block hashes (slot `(number - 1) % 8191`).
 * On a fork, anvil first fetches each slot's old value from the upstream RPC, so every block it
 * mines waits for three sequential upstream round trips (measured with anvil 1.8.5).
 */
const SYSTEM_RINGS: [Address, number][] = [
  ["0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02", 2 * 8191],
  ["0x0000F90827F1C53a10cb7A02335B175320002935", 8191],
];

/**
 * Fork only: zeroes both rings locally, so mining a block needs nothing from upstream. Each block
 * overwrites its slots with real values; the zeros replace roots and hashes of blocks before the
 * fork, which nothing in the suites reads.
 */
async function localSystemRings(url: string) {
  const writes = SYSTEM_RINGS.flatMap(([address, slots]) =>
    Array.from({ length: slots }, (_, slot) => [address, toHex(slot), zeroHash]),
  );
  // In batches of 4096: anvil refuses a request body of several megabytes.
  for (let i = 0; i < writes.length; i += 4096) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        writes
          .slice(i, i + 4096)
          .map((params, id) => ({ jsonrpc: "2.0", id, method: "anvil_setStorageAt", params })),
      ),
      signal: AbortSignal.timeout(30_000),
    });
    const out = (await res.json()) as { error?: unknown }[] | { error?: unknown };
    const failed = Array.isArray(out) ? out.find((r) => r.error) : out;
    if (failed?.error)
      throw new Error(`anvil_setStorageAt failed: ${JSON.stringify(failed.error)}`);
  }
}

/**
 * Executor wallets Alto gets. Its safe validator takes a free executor wallet for every validation
 * (`getCodeHashes`) and frees a bundle's wallet only once a later block shows the bundle included,
 * so with a single wallet a send waits as long as the previous bundle is unconfirmed (docs/infra.md
 * §10.6). More wallets than bundles in flight keep validation from ever waiting for one.
 */
const EXECUTORS = 3;

/**
 * Starts an anvil fork of `upstreamRpcUrl` and a strict Alto on it. The executors are fresh random
 * keys funded with 100 MNT each on the fork only. `stop` kills Alto, then anvil.
 */
export async function startBundlerStack(upstreamRpcUrl: string): Promise<BundlerStack> {
  const fork = await startFork(upstreamRpcUrl);
  try {
    const client = forkClient(fork.url);
    await localSystemRings(fork.url);
    const executorKeys = Array.from({ length: EXECUTORS }, () => generatePrivateKey());
    for (const key of executorKeys) {
      await client.setBalance({ address: privateKeyToAddress(key), value: parseEther("100") });
    }
    const bundler = await startAlto({ rpcUrl: fork.url, executorKeys });
    return {
      rpcUrl: fork.url,
      bundler,
      client,
      stop: async () => {
        await bundler.stop();
        await fork.stop();
      },
    };
  } catch (e) {
    await fork.stop();
    throw e;
  }
}

/**
 * Fork only: replaces the deployed VerifyingPaymaster's `verifyingSigner` immutable with `signer`
 * in its runtime code (same address, same logic), so a test can sign paymaster data with a key it
 * holds. Asserts the result through `verifyingSigner()`.
 */
export async function setPaymasterSigner(client: ForkClient, paymaster: Address, signer: Address) {
  const abi = parseAbi(["function verifyingSigner() view returns (address)"]);
  const current = await client.readContract({
    address: paymaster,
    abi,
    functionName: "verifyingSigner",
  });
  const code = await client.getCode({ address: paymaster });
  const from = current.slice(2).toLowerCase();
  if (!code?.includes(from))
    throw new Error(`verifyingSigner ${current} not found in the paymaster code`);
  await client.setCode({
    address: paymaster,
    bytecode: code.replaceAll(from, signer.slice(2).toLowerCase()) as Hex,
  });
  const now = await client.readContract({
    address: paymaster,
    abi,
    functionName: "verifyingSigner",
  });
  if (now.toLowerCase() !== signer.toLowerCase()) throw new Error("paymaster signer not replaced");
}
