import { getChain } from "@mantle-aa/sdk";
import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import { Ledger } from "./ledger.js";
import { loadRelayerAccount } from "./relayer.js";
import { createSponsorServer } from "./server.js";
import { SponsorStore } from "./store.js";

/**
 * Starts the sponsor from `--config <sponsor.yaml>`; resolves once it is listening. With a
 * `relayerKey` it reconciles its ledger with the chain first, then pays for accepted requests.
 */
export async function main(argv: readonly string[]) {
  const path = argv[argv.indexOf("--config") + 1];
  if (!argv.includes("--config") || !path)
    throw new Error("usage: sponsor --config <sponsor.yaml>");
  const config = loadConfig(path);
  const store = new SponsorStore(config.database);
  const client = createPublicClient({
    chain: getChain(config.chainId),
    transport: http(config.rpcUrl, { timeout: 10_000 }),
  });
  const ledger = config.relayerKeyEnv
    ? new Ledger({ config, client, store, account: loadRelayerAccount(config) })
    : undefined;
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
}

if (import.meta.main) {
  const sponsor = await main(process.argv.slice(2));
  console.log(`sponsor listening on ${sponsor.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => sponsor.close());
}
