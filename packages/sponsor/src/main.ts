import { getChain } from "@mantle-aa/sdk";
import { createPublicClient, http } from "viem";
import { loadConfig, type SponsorConfig } from "./config.js";
import { Ledger } from "./ledger.js";
import { loadRelayerAccount } from "./relayer.js";
import { createSponsorServer } from "./server.js";
import { SponsorStore } from "./store.js";

export interface StartSponsorOptions {
  /** Where the config's `relayerKey` variable is read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The ledger's settlement poll interval; default 1000 ms. */
  pollIntervalMs?: number;
}

/**
 * Starts the sponsor for a config; resolves once it is listening. With a `relayerKey` it
 * reconciles its ledger with the chain first, then pays for accepted requests. `close` stops the
 * server, the ledger's settlement loop and the database, in that order.
 */
export async function startSponsor(config: SponsorConfig, options: StartSponsorOptions = {}) {
  const account = config.relayerKeyEnv ? loadRelayerAccount(config, options.env) : undefined;
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
  try {
    await ledger?.start();
    const server = createSponsorServer({ config, client, store, ...(ledger ? { ledger } : {}) });
    const url = await server.listen();
    return {
      url,
      ledger,
      async close() {
        await server.close();
        await ledger?.close();
        store.close();
      },
    };
  } catch (error) {
    // Nothing is left open when the start fails (the ledger's loop, the database).
    await ledger?.close();
    store.close();
    throw error;
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
  const sponsor = await main(process.argv.slice(2));
  console.log(`sponsor listening on ${sponsor.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => sponsor.close());
}
