import { type AddressBook, loadDeployments } from "@mantle-aa/sdk";
import { type Address, getAddress, parseEther } from "viem";
import type { SponsorConfig, SponsorPolicy } from "./config.js";
import { startSponsor } from "./main.js";
import { loadRelayerAccount } from "./relayer.js";

/** The switch that must be `1` for the embedded sponsor to start. */
export const EMBEDDED_SWITCH_ENV = "MANTLE_AA_EMBEDDED_RELAYER";
/** The default environment variable holding the embedded relayer's private key. */
export const EMBEDDED_RELAYER_KEY_ENV = "MANTLE_AA_RELAYER_KEY";
/** The default environment variable holding the paymaster signer's private key, if any. */
export const EMBEDDED_PAYMASTER_SIGNER_KEY_ENV = "MANTLE_AA_PAYMASTER_SIGNER_KEY";

/**
 * Test- and demo-sized caps. The per-request cap leaves room for init with the first grant, whose
 * worst-case fee is about 0.055 MNT on Mantle Sepolia.
 */
export const EMBEDDED_POLICY_DEFAULTS: Omit<SponsorPolicy, "allowlist"> = {
  accountDailyGas: 10_000_000n,
  maxFeePerRequest: parseEther("0.5"),
  dailyBudget: parseEther("5"),
  managementReserve: parseEther("1"),
};

export interface EmbeddedSponsorOptions {
  /** The chain's RPC URL; never logged. */
  rpcUrl: string;
  /** The accounts the sponsor pays for. */
  allowlist: readonly Address[];
  /** The environment variable holding the relayer's private key; default `MANTLE_AA_RELAYER_KEY`. */
  relayerKeyEnv?: string;
  /**
   * The environment variable holding the paymaster signer's private key, which enables the `pm_*`
   * methods; default `MANTLE_AA_PAYMASTER_SIGNER_KEY` when that variable is set.
   */
  paymasterSignerKeyEnv?: string;
  /** SQLite path; default `:memory:` (the ledger lives as long as the process). */
  database?: string;
  /** Overrides `EMBEDDED_POLICY_DEFAULTS`. */
  policy?: Partial<Omit<SponsorPolicy, "allowlist">>;
  /** Defaults to the committed Mantle Sepolia address book; its chain id is the sponsor's. */
  addresses?: AddressBook;
  /** How long one `sponsor_relay` waits for settlement before answering `pending`; default 30 s. */
  settleTimeoutSeconds?: number;
  /** The ledger's settlement poll interval; default 1000 ms. */
  pollIntervalMs?: number;
  /** Where the switch and the key are read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Embedded mode (docs/DESIGN.md §5.2; tests and local demos only): the sponsor service itself —
 * the same authentication, policy, ledger and relayer submission — started in process on an
 * ephemeral loopback port and paying with a local relayer key from the environment (and, given a
 * paymaster signer key, signing UserOps for the `pm_*` methods). Hand `url` to `RelayerExecutor`
 * or use it as the ERC-7677 paymaster service. Refuses to start unless
 * `MANTLE_AA_EMBEDDED_RELAYER=1`, and while another sponsor runs on the same `database` file (one
 * submitting sponsor per database: `SponsorStore.claimSubmitter`); it does not wait for it. `close`
 * leaves no listener, timer or open database behind.
 */
export async function startEmbeddedSponsor(options: EmbeddedSponsorOptions) {
  const env = options.env ?? process.env;
  if (env[EMBEDDED_SWITCH_ENV] !== "1") {
    throw new Error(
      `embedded sponsor mode is for tests and local demos only: set ${EMBEDDED_SWITCH_ENV}=1 to enable it`,
    );
  }
  const relayerKeyEnv = options.relayerKeyEnv ?? EMBEDDED_RELAYER_KEY_ENV;
  const paymasterSignerKeyEnv =
    options.paymasterSignerKeyEnv ??
    (env[EMBEDDED_PAYMASTER_SIGNER_KEY_ENV] ? EMBEDDED_PAYMASTER_SIGNER_KEY_ENV : undefined);
  const addresses = options.addresses ?? loadDeployments();
  const config: SponsorConfig = {
    chainId: addresses.chainId,
    rpcUrl: options.rpcUrl,
    listen: { host: "127.0.0.1", port: 0 },
    database: options.database ?? ":memory:",
    relayer: loadRelayerAccount({ relayerKeyEnv }, env).address,
    relayerKeyEnv,
    ...(paymasterSignerKeyEnv ? { paymasterSignerKeyEnv } : {}),
    settleTimeoutSeconds: options.settleTimeoutSeconds ?? 30,
    addresses,
    maxRequestValiditySeconds: 300,
    policy: {
      ...EMBEDDED_POLICY_DEFAULTS,
      ...options.policy,
      allowlist: options.allowlist.map((a) => getAddress(a)),
    },
  };
  if (config.policy.managementReserve > config.policy.dailyBudget) {
    throw new Error("policy.managementReserve exceeds policy.dailyBudget");
  }
  const sponsor = await startSponsor(config, {
    env,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  return { url: sponsor.url, relayer: config.relayer, close: sponsor.close };
}
