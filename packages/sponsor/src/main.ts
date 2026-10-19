import { getChain, redactUrls } from "@0xwh1sker/mantle-aa-sdk";
import { createPublicClient, http } from "viem";
import { loadConfig, type SponsorConfig } from "./config.js";
import { Ledger } from "./ledger.js";
import { PaymasterLedger } from "./paymaster.js";
import { loadKeyAccount, loadRelayerAccount } from "./relayer.js";
import { createSponsorServer } from "./server.js";
import { SponsorStore } from "./store.js";

export interface StartSponsorOptions {
  /** Where the config's key variables are read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The ledgers' settlement poll interval; default 1000 ms. */
  pollIntervalMs?: number;
}

/**
 * Starts the sponsor for a config; resolves once it is listening. With a `relayerKey` it
 * reconciles its ledger with the chain first, then pays for accepted requests; with a
 * `paymasterSignerKey` it checks the key is the paymaster's signer and reconciles open
 * sponsorships, then signs accepted UserOps. `close` stops the server, the ledgers' settlement
 * loops and the database, in that order.
 */
export async function startSponsor(config: SponsorConfig, options: StartSponsorOptions = {}) {
  const account = config.relayerKeyEnv ? loadRelayerAccount(config, options.env) : undefined;
  const signer = config.paymasterSignerKeyEnv
    ? loadKeyAccount(config.paymasterSignerKeyEnv, "paymaster signer", options.env)
    : undefined;
  const store = new SponsorStore(config.database);
  const client = createPublicClient({
    chain: getChain(config.chainId),
    transport: http(config.rpcUrl, { timeout: 10_000 }),
  });
  const ledger = account
    ? new Ledger({
        config,
        client,
        store,
        account,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      })
    : undefined;
  const paymaster = signer
    ? new PaymasterLedger({
        config,
        client,
        store,
        signer,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      })
    : undefined;
  try {
    await ledger?.start();
    await paymaster?.start();
    const server = createSponsorServer({
      config,
      client,
      store,
      ...(ledger ? { ledger } : {}),
      ...(paymaster ? { paymaster } : {}),
    });
    const url = await server.listen();
    return {
      url,
      ledger,
      paymaster,
      async close() {
        await server.close();
        await ledger?.close();
        await paymaster?.close();
        store.close();
      },
    };
  } catch (error) {
    // Nothing is left open when the start fails (the ledgers' loops, the database).
    await ledger?.close();
    await paymaster?.close();
    store.close();
    // A viem error names the RPC URL, which may carry a credential, in its message, details and
    // causes: only its redacted message goes on. The configured URL is replaced whole first, so a
    // malformed one (which the generic redaction would cut short) leaves nothing behind.
    const message = error instanceof Error ? error.message : String(error);
    const scrubbed = config.rpcUrl ? message.replaceAll(config.rpcUrl, "<redacted-url>") : message;
    throw new Error(redactUrls(scrubbed));
  }
}

/** Starts the sponsor from `--config <sponsor.yaml>`; resolves once it is listening. */
export async function main(argv: readonly string[]) {
  const path = argv[argv.indexOf("--config") + 1];
  if (!argv.includes("--config") || !path)
    throw new Error("usage: sponsor --config <sponsor.yaml>");
  return startSponsor(loadConfig(path));
}

if (import.meta.main) {
  const sponsor = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`sponsor: ${redactUrls(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  });
  console.log(`sponsor listening on ${sponsor.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => sponsor.close());
}
