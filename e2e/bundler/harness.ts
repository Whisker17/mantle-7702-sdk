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
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { ENTRY_POINT_V08 } from "./userop.js";

export { ENTRY_POINT_V08 };
export const ALTO_VERSION = "0.0.21";

const ALTO_DIR = fileURLToPath(new URL("./alto/", import.meta.url));
const PATCH = join(ALTO_DIR, "safe-validator.patch");
const run = promisify(execFile);

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

/** Spawns `cmd`, keeps its output for diagnostics, and kills it on stop and on process exit. */
function own(cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (data: Buffer) => {
    output = (output + data.toString()).slice(-2_000_000);
  };
  child.stdout?.on("data", keep);
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

/** Starts anvil forking `upstreamRpcUrl` at its head (Prague rules, so EIP-7702 applies). */
export async function startFork(upstreamRpcUrl: string, timeoutMs = 60_000): Promise<Fork> {
  const port = await freePort();
  const anvil = own("anvil", [
    "--fork-url",
    upstreamRpcUrl,
    "--port",
    String(port),
    "--hardfork",
    "prague",
    "--silent",
  ]);
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForRpc(url, anvil.child, timeoutMs, "anvil");
  } catch (e) {
    await anvil.stop();
    throw e;
  }
  return { url, stop: anvil.stop };
}

export interface Bundler extends Owned {
  /** The bundler's JSON-RPC URL (ERC-7769 `eth_*UserOperation*` and `pimlico_*`). */
  url: string;
  entryPoint: Address;
  /** The executor (bundle sender) address; its key never leaves the harness. */
  executor: Address;
  /** Alto's recent log output, for failure messages. */
  logs: () => string;
}

export interface AltoOptions {
  /** RPC Alto reads, traces (`debug_traceCall`) and submits through: an anvil fork in tests. */
  rpcUrl: string;
  /** Executor and utility key; passed to Alto through its environment, never argv. */
  executorKey: Hex;
  /** How long to wait for Alto to answer (ms); the install has its own 300 s bound. */
  timeoutMs?: number;
}

/** Starts the pinned, patched Alto in safe mode against EntryPoint v0.8 on `rpcUrl`. */
export async function startAlto({
  rpcUrl,
  executorKey,
  timeoutMs = 120_000,
}: AltoOptions): Promise<Bundler> {
  const cli = await installAlto();
  const port = await freePort();
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
      "true",
      "--log-level",
      "info",
      // Every RPC request at info level would drown the validation and bundling lines.
      "--public-client-log-level",
      "warn",
    ],
    { ALTO_EXECUTOR_PRIVATE_KEYS: executorKey, ALTO_UTILITY_PRIVATE_KEY: executorKey },
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForRpc(url, alto.child, timeoutMs, "alto");
  } catch (e) {
    await alto.stop();
    throw new Error(`${(e as Error).message}\n--- alto log ---\n${alto.output().slice(-4_000)}`);
  }
  return {
    url,
    entryPoint: ENTRY_POINT_V08,
    executor: privateKeyToAddress(executorKey),
    logs: alto.output,
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
 * Starts an anvil fork of `upstreamRpcUrl` and a strict Alto on it. The executor is a fresh random
 * key funded with 100 MNT on the fork only. `stop` kills Alto, then anvil.
 */
export async function startBundlerStack(upstreamRpcUrl: string): Promise<BundlerStack> {
  const fork = await startFork(upstreamRpcUrl);
  try {
    const client = forkClient(fork.url);
    const executorKey = generatePrivateKey();
    await client.setBalance({
      address: privateKeyToAddress(executorKey),
      value: parseEther("100"),
    });
    const bundler = await startAlto({ rpcUrl: fork.url, executorKey });
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
