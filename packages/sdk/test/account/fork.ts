import { type ChildProcess, spawn } from "node:child_process";
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

/** Starts anvil forking Mantle Sepolia (Prague, so EIP-7702 applies) and returns its URL. */
export async function startFork(rpcUrl: string): Promise<{ url: string; stop: () => void }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const anvil: ChildProcess = spawn("anvil", [
    "--fork-url",
    rpcUrl,
    "--port",
    String(port),
    "--hardfork",
    "prague",
  ]);
  await new Promise<void>((resolve, reject) => {
    anvil.once("error", reject);
    anvil.once("exit", (code) => reject(new Error(`anvil exited with ${code}`)));
    anvil.stdout?.on("data", (data) => String(data).includes("Listening on") && resolve());
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
