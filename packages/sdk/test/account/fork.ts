import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  type HttpTransport,
  http,
  type PublicClient,
  parseAbi,
  type WalletClient,
} from "viem";
import { type LocalAccount, mnemonicToAccount } from "viem/accounts";
import {
  type AddressBook,
  type ExecRequest,
  type ExecResult,
  type Executor,
  mantleSepolia,
  readCaliburNonce,
  signBatchedCall,
} from "../../src/index.js";

// anvil's funded development accounts; they only pay for gas.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const RELAYER = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
export const THIRD_PARTY = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 });

const FORK_ATTEMPTS = 3;

/**
 * Starts anvil forking Mantle Sepolia (Prague, so EIP-7702 applies) and returns its URL. anvil
 * binds a port the OS picks (`--port 0`) and reports it; a start that fails or does not listen
 * within `timeoutMs` rejects with the tail of anvil's output, URLs redacted. anvil exits when the
 * upstream RPC fails while it builds the fork (e.g. HTTP 429 under parallel suites), so an exited
 * start is retried, up to FORK_ATTEMPTS in all; a failure that persists still rejects.
 */
export async function startFork(
  rpcUrl: string,
  timeoutMs = 30_000,
): Promise<{ url: string; stop: () => void }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startAnvil(rpcUrl, timeoutMs);
    } catch (e) {
      const message = (e as Error).message;
      if (!message.startsWith("anvil exited")) throw e;
      if (attempt === FORK_ATTEMPTS) throw new Error(`${message}\n(${attempt} attempts)`);
      await sleep(1_000 * attempt);
    }
  }
}

async function startAnvil(
  rpcUrl: string,
  timeoutMs: number,
): Promise<{ url: string; stop: () => void }> {
  const anvil = spawn("anvil", ["--fork-url", rpcUrl, "--port", "0", "--hardfork", "prague"]);
  let output = "";
  let listening = false;
  const port = await new Promise<string>((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer);
      anvil.kill();
      const tail = output
        .replace(/\w+:\/\/[^\s)]+/g, "<url>")
        .slice(-1_000)
        .trim();
      reject(new Error(`anvil ${why}: ${tail || "(no output)"}`));
    };
    const timer = setTimeout(() => fail(`did not listen within ${timeoutMs} ms`), timeoutMs);
    anvil.once("error", (e) => fail(e.message));
    // "close", not "exit": it fires after the pipes are drained, so the error text is in `output`.
    anvil.once("close", (code, signal) => fail(`exited with ${code ?? signal}`));
    // Keeps draining both pipes after the start so anvil never blocks on a full one.
    const keep = (data: Buffer) => {
      if (listening) return;
      output += data;
      const port = /Listening on [\d.]+:(\d+)/.exec(output)?.[1];
      if (port) {
        listening = true;
        clearTimeout(timer);
        anvil.removeAllListeners("close");
        resolve(port);
      }
    };
    anvil.stdout.on("data", keep);
    anvil.stderr.on("data", keep);
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => anvil.kill() };
}

export const clientFor = (url: string): PublicClient =>
  createPublicClient({ chain: mantleSepolia, transport: http(url) });

export const walletFor = (
  url: string,
  account: LocalAccount,
): WalletClient<HttpTransport, Chain, LocalAccount> =>
  createWalletClient({
    account,
    chain: mantleSepolia,
    transport: http(url),
  });

/**
 * A stand-in for the sponsor's relayer: signs the request's SignedBatchedCall bound to its own
 * address as executor, sends it (as a type-4 transaction when the request carries an
 * authorization) with a fixed gas limit so a reverting batch still lands, and records every request.
 */
export class TestRelayer implements Executor {
  readonly kind = "relayer" as const;
  readonly requests: ExecRequest[] = [];
  readonly #client;
  readonly #wallet;

  constructor(
    url: string,
    readonly book: AddressBook,
    account: LocalAccount = RELAYER,
  ) {
    this.#client = clientFor(url);
    this.#wallet = walletFor(url, account);
  }

  async submit(request: ExecRequest): Promise<ExecResult> {
    this.requests.push(request);
    const data = await signBatchedCall(this.#client, {
      account: request.account,
      implementation: this.book.caliburEntry,
      chainId: this.book.chainId,
      signer: request.signer,
      keyHash: request.keyHash,
      calls: request.calls,
      nonce: await readCaliburNonce(this.#client, request.account, request.lane),
      executor: this.#wallet.account.address,
      deadline: request.deadline,
    });
    const hash = await this.#wallet.sendTransaction({
      to: request.account,
      data,
      gas: 5_000_000n,
      ...(request.authorization ? { authorizationList: [request.authorization] } : {}),
    });
    const receipt = await this.#client.waitForTransactionReceipt({ hash });
    return { hash, success: receipt.status === "success" };
  }
}

export const mockUsdAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
