import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import {
  type AddressBook,
  AgentSession,
  BundlerExecutor,
  ExecutionRevertedError,
  type Executor,
  getChain,
  type KeystoreOptions,
  loadDeployments,
  loadProfileSigner,
  MantleAccount,
  PASSWORD_ENV,
  type PanicResult,
  type Profile,
  RelayerExecutor,
  readProfiles,
  type ScryptParams,
  type SessionGrant,
  type Signer,
  saveKey,
  saveProfile,
  UndelegationFailedError,
} from "@mantle-aa/sdk";
import {
  EMBEDDED_PAYMASTER_SIGNER_KEY_ENV,
  EMBEDDED_SWITCH_ENV,
  Ledger,
  loadConfig,
  loadRelayerAccount,
  type ReplaceOptions,
  SponsorStore,
  startEmbeddedSponsor,
  startSponsor,
} from "@mantle-aa/sponsor";
import {
  type Address,
  BaseError,
  type Client,
  createPublicClient,
  getAddress,
  type Hex,
  http,
  isHex,
  zeroHash,
} from "viem";
import { generatePrivateKey, type LocalAccount, privateKeyToAddress } from "viem/accounts";
import { describeError, redact, UsageError } from "./errors.js";
import {
  amount,
  parseCalls,
  parsePolicy,
  parseRelease,
  promptHidden,
  readAll,
  type SecretInput,
} from "./input.js";

/** The chain's RPC URL when `--rpc-url` is not given. There is no default network. */
export const RPC_URL_ENV = "MANTLE_AA_RPC_URL";
/** A long-running sponsor's URL when `--sponsor-url` is not given. */
export const SPONSOR_URL_ENV = "MANTLE_AA_SPONSOR_URL";
/** The ERC-4337 bundler's URL when `--bundler-url` is not given (`--via bundler` only). */
export const BUNDLER_URL_ENV = "MANTLE_AA_BUNDLER_URL";
/** Overrides the keystore and profile directory `~/.mantle-aa`. */
export const HOME_ENV = "MANTLE_AA_HOME";

export interface CliIO {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  /** Human-readable errors and prompts. */
  stderr?: (text: string) => void;
  /** Where `keys import` reads the key and a TTY is prompted for the password. */
  stdin?: SecretInput;
  /** Stops `sponsor serve`, besides SIGINT and SIGTERM. */
  signal?: AbortSignal;
  /** The scrypt cost of keystores this run writes (tests lower it). */
  scrypt?: ScryptParams;
}

type Values = Record<string, string | boolean | string[] | undefined>;

interface Command {
  options?: ParseArgsOptionsConfig;
  run(ctx: Context, values: Values): Promise<unknown>;
}

/** Returned by a command that printed its own result (`sponsor serve`). */
const PRINTED = Symbol("printed");

const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "rpc-url": { type: "string" },
  "sponsor-url": { type: "string" },
  "bundler-url": { type: "string" },
  via: { type: "string" },
};

const USAGE = `usage: mantle-aa <command> [options]

  keys new         --name <name>
  keys import      --name <name>                  (key from stdin or a prompt, never argv)
  keys list
  account init     [--grant <policy.json> --agent <name>] [--root <name>]
  account status   [--root <name>]
  account exec     --calls <json> [--release <keyHash,token,amount>]... [--root <name>]
  account panic    [--self-pay [--undelegate]] [--root <name>]
                   (revokes every session key in one transaction; --self-pay: the root sends
                   and pays for it, no sponsor needed; --undelegate: then clears the EIP-7702
                   delegation, a root transaction too, so it needs --self-pay)
  session grant    --agent <name> --policy <policy.json> [--root <name>]
  session update   --agent <name> --policy <policy.json>
  session revoke   --agent <name>
  session list     [--root <name>]
  agent simulate   --agent <name> --calls <json>
  agent exec       --agent <name> --calls <json> [--via relayer|bundler]
  sponsor serve    --config <sponsor.yaml>
  sponsor relayer  status|bump|cancel --config <sponsor.yaml> [--nonce <n>]
                   [--max-fee-per-gas <wei>] [--max-priority-fee-per-gas <wei>]

options:  --json  --rpc-url <url>  --sponsor-url <url>
          --via relayer|bundler  --bundler-url <url>
          (--via: the path account init|exec|panic, session grant|update|revoke and agent
          exec submit through; default relayer. --via bundler needs a bundler URL.)
env:      ${RPC_URL_ENV}, ${SPONSOR_URL_ENV}, ${BUNDLER_URL_ENV}, ${PASSWORD_ENV}, ${HOME_ENV},
          ${EMBEDDED_SWITCH_ENV}=1 with MANTLE_AA_RELAYER_KEY (embedded sponsor),
          and ${EMBEDDED_PAYMASTER_SIGNER_KEY_ENV} for --via bundler
exit:     0 ok, 10 policy, 11 limit, 12 inventory, 13 key expired/revoked,
          20 sponsor rejected, 21 sponsor busy, 30 reverted, 1 other
`;

const string = (values: Values, name: string): string | undefined => {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
};
const required = (values: Values, name: string): string => {
  const value = string(values, name);
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
};

/** A root signer for commands that only read: it refuses to sign. */
const readOnlySigner = (address: Address): Signer => {
  const locked = () => Promise.reject(new Error("this command does not unlock the root key"));
  return { address, signTypedData: locked, signMessage: locked };
};

/** Settings, the chain client, the keystore and the (lazily started) sponsor of one run. */
class Context {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  #addresses: AddressBook | undefined;
  #client: Client | undefined;
  #password: string | undefined;
  #sponsor: { close(): Promise<void> } | undefined;

  constructor(
    readonly io: CliIO & { stdout: (text: string) => void; stderr: (text: string) => void },
    readonly values: Values,
  ) {
    this.env = io.env ?? process.env;
    this.home = this.env[HOME_ENV] || join(this.env.HOME || homedir(), ".mantle-aa");
  }

  get addresses(): AddressBook {
    this.#addresses ??= loadDeployments();
    return this.#addresses;
  }

  rpcUrl(): string {
    const url = string(this.values, "rpc-url") || this.env[RPC_URL_ENV];
    if (!url) throw new UsageError(`no RPC URL: pass --rpc-url or set ${RPC_URL_ENV}`);
    return url;
  }

  client(): Client {
    this.#client ??= createPublicClient({
      chain: getChain(this.addresses.chainId),
      transport: http(this.rpcUrl()),
    });
    return this.#client;
  }

  /** Keystore options; `unlock` adds the password (from the environment, else a TTY prompt). */
  async keystore(unlock = false, confirm = false): Promise<KeystoreOptions> {
    const options: KeystoreOptions = { home: this.home };
    if (this.io.scrypt) options.scrypt = this.io.scrypt;
    if (unlock) options.password = await this.#passwordOf(confirm);
    return options;
  }

  async #passwordOf(confirm: boolean): Promise<string> {
    this.#password ??= this.env[PASSWORD_ENV] || undefined;
    if (this.#password) return this.#password;
    const stdin = this.io.stdin;
    if (!stdin?.isTTY) {
      throw new UsageError(`no keystore password: set ${PASSWORD_ENV} or run in a terminal`);
    }
    const password = await promptHidden(stdin, this.io.stderr, "Keystore password: ");
    if (!password) throw new UsageError("empty keystore password");
    if (confirm && (await promptHidden(stdin, this.io.stderr, "Repeat password: ")) !== password) {
      throw new UsageError("the passwords do not match");
    }
    this.#password = password;
    return password;
  }

  /** `--via`: the path every submitting command takes; the relayer by default. */
  get via(): Executor["kind"] {
    return string(this.values, "via") === "bundler" ? "bundler" : "relayer";
  }

  /**
   * The executor for `account`'s batches, on the `--via` path. The sponsor (and the bundler) are
   * reached on first submission only: `--sponsor-url` / MANTLE_AA_SPONSOR_URL, or with
   * MANTLE_AA_EMBEDDED_RELAYER=1 an embedded sponsor (allowlisting `account`, its ledger under the
   * profile directory) closed at exit. A batch that reverted on chain throws
   * `ExecutionRevertedError`.
   */
  executor(account: Address): Executor {
    let inner: Promise<Executor> | undefined;
    const kind = this.via;
    return {
      kind,
      submit: async (request) => {
        inner ??= kind === "bundler" ? this.#bundler(account) : this.#relayer(account);
        const result = await (await inner).submit(request);
        if (!result.success) {
          throw new ExecutionRevertedError({ reason: `transaction ${result.hash} reverted` });
        }
        return result;
      },
    };
  }

  async #relayer(account: Address): Promise<Executor> {
    const { url, relayer } = await this.#sponsorOf(account);
    return new RelayerExecutor({
      client: this.client(),
      url,
      ...(relayer && { relayer }),
      addresses: this.addresses,
    });
  }

  async #bundler(account: Address): Promise<Executor> {
    const bundlerUrl = string(this.values, "bundler-url") || this.env[BUNDLER_URL_ENV];
    if (!bundlerUrl) {
      throw new UsageError(`no bundler: pass --bundler-url or set ${BUNDLER_URL_ENV}`);
    }
    const { url } = await this.#sponsorOf(account);
    return new BundlerExecutor({
      client: this.client(),
      bundlerUrl,
      sponsorUrl: url,
      addresses: this.addresses,
    });
  }

  /** The sponsor's URL; an embedded sponsor's also its relayer. */
  async #sponsorOf(account: Address): Promise<{ url: string; relayer?: Address }> {
    const url = string(this.values, "sponsor-url") || this.env[SPONSOR_URL_ENV];
    const embedded = this.env[EMBEDDED_SWITCH_ENV] === "1";
    if (embedded && url) {
      throw new UsageError(`use either a sponsor URL or ${EMBEDDED_SWITCH_ENV}=1, not both`);
    }
    if (embedded) {
      // Without the paymaster signer key the embedded sponsor serves no pm_* methods.
      if (this.via === "bundler" && !this.env[EMBEDDED_PAYMASTER_SIGNER_KEY_ENV]) {
        throw new UsageError(
          `the embedded sponsor needs ${EMBEDDED_PAYMASTER_SIGNER_KEY_ENV} for --via bundler`,
        );
      }
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      const sponsor = await startEmbeddedSponsor({
        rpcUrl: this.rpcUrl(),
        allowlist: [account],
        database: join(this.home, "embedded-sponsor.sqlite"),
        addresses: this.addresses,
        env: this.env,
      });
      this.#sponsor = sponsor;
      return { url: sponsor.url, relayer: sponsor.relayer };
    }
    if (!url) {
      throw new UsageError(
        `no sponsor: pass --sponsor-url, set ${SPONSOR_URL_ENV}, or set ${EMBEDDED_SWITCH_ENV}=1`,
      );
    }
    return { url };
  }

  async close(): Promise<void> {
    await this.#sponsor?.close();
    this.#sponsor = undefined;
  }
}

// ---- profiles ---------------------------------------------------------------------------------

interface Named {
  name: string;
  profile: Profile;
}

/** The root profile named `--root`, else the only root profile (of `account`, when given). */
function rootProfile(ctx: Context, options: KeystoreOptions, account?: Address): Named {
  const name = string(ctx.values, "root");
  const roots = Object.entries(readProfiles(options)).filter(
    ([n, p]) =>
      p.role === "root" &&
      (name === undefined || n === name) &&
      (account === undefined || getAddress(p.account) === account),
  );
  const [only, ...more] = roots;
  if (!only || more.length) {
    throw new UsageError(
      name !== undefined
        ? `no root profile ${JSON.stringify(name)}${account ? ` for account ${account}` : ""}`
        : roots.length
          ? `${roots.length} root profiles match${account ? ` account ${account}` : ""}; pass --root <name>`
          : `no root profile${account ? ` for account ${account}` : ""}: create one with keys new or keys import`,
    );
  }
  return { name: only[0], profile: only[1] };
}

function agentProfile(options: KeystoreOptions, name: string): Profile {
  const profile = readProfiles(options)[name];
  if (!profile) throw new UsageError(`no profile ${JSON.stringify(name)}`);
  if (profile.role !== "agent") throw new UsageError(`profile ${name} is not an agent profile`);
  return profile;
}

async function mantleAccount(ctx: Context, root: Named, unlock: boolean, confirm = false) {
  const keystore = await ctx.keystore(unlock, confirm);
  const account = getAddress(root.profile.account);
  return new MantleAccount({
    client: ctx.client(),
    root: unlock ? loadProfileSigner(root.name, keystore) : readOnlySigner(account),
    executor: ctx.executor(account),
    addresses: ctx.addresses,
    keystore,
  });
}

/**
 * Every grant creates a new key and a new version of the agent's profile (docs/DESIGN.md §5.3):
 * the profile `<agent>` then names the new key, and the one it named before stays reachable as
 * `<agent>.v<n>` (n = 1, 2, …). Returns that archived name.
 */
function archiveProfile(options: KeystoreOptions, agent: string): string | undefined {
  const profiles = readProfiles(options);
  const current = profiles[agent];
  if (!current) return undefined;
  if (current.role !== "agent") throw new UsageError(`profile ${agent} is not an agent profile`);
  // A grant retried after a failure finds its key archived already.
  const archived = Object.entries(profiles).find(
    ([name, p]) => name.startsWith(`${agent}.v`) && p.keyHash === current.keyHash,
  );
  if (archived) return archived[0];
  let n = 1;
  while (profiles[`${agent}.v${n}`]) n++;
  saveProfile(`${agent}.v${n}`, current, options);
  return `${agent}.v${n}`;
}

const grantOutput = (grant: SessionGrant, previous: string | undefined) => ({
  profile: grant.agentName,
  keyHash: grant.keyHash,
  address: grant.address,
  keyfile: grant.keyfile,
  expiry: grant.expiry,
  hash: grant.hash,
  ...(previous && { previousProfile: previous }),
});

function saveRootKey(name: string, privateKey: Hex, options: KeystoreOptions) {
  if (readProfiles(options)[name]) throw new UsageError(`profile ${name} already exists`);
  const keyfile = saveKey(name, privateKey, options);
  const account = privateKeyToAddress(privateKey);
  saveProfile(name, { account, keyHash: zeroHash, keyfile: `${name}.json`, role: "root" }, options);
  return { name, account, keyfile };
}

// ---- commands ---------------------------------------------------------------------------------

const ROOT = { root: { type: "string" } } as const;
const AGENT = { agent: { type: "string" } } as const;
const CALLS = { calls: { type: "string" } } as const;
const RELAYER_OPTIONS = {
  config: { type: "string" },
  nonce: { type: "string" },
  "max-fee-per-gas": { type: "string" },
  "max-priority-fee-per-gas": { type: "string" },
} as const;

/** `sponsor relayer <op>`: recovery of the sponsor's relayer, from a second process. */
function relayerCommand(op: "status" | "bump" | "cancel"): Command {
  return {
    options: RELAYER_OPTIONS,
    async run(ctx, v) {
      const config = loadConfig(required(v, "config"));
      const client = createPublicClient({
        chain: getChain(config.chainId),
        transport: http(config.rpcUrl, { timeout: 10_000 }),
      });
      const store = new SponsorStore(config.database);
      try {
        // `status` signs nothing and needs no key; bump and cancel sign with the relayer's key.
        const account =
          op === "status"
            ? ({ address: config.relayer } as LocalAccount)
            : loadRelayerAccount(config, ctx.env);
        // Never started: the ledger of the running sponsor stays the only one that settles.
        const ledger = new Ledger({ config, client, store, account });
        if (op === "status") return await ledger.status();
        const options: ReplaceOptions = {};
        const nonce = string(v, "nonce");
        if (nonce !== undefined) options.nonce = Number(amount(nonce, "--nonce"));
        const maxFee = string(v, "max-fee-per-gas");
        if (maxFee !== undefined) options.maxFeePerGas = amount(maxFee, "--max-fee-per-gas");
        const tip = string(v, "max-priority-fee-per-gas");
        if (tip !== undefined) {
          options.maxPriorityFeePerGas = amount(tip, "--max-priority-fee-per-gas");
        }
        return { hash: await ledger[op](options) };
      } finally {
        store.close();
      }
    },
  };
}

/** Resolves on SIGINT, SIGTERM or `signal`. */
function stopped(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done);
  });
}

export const COMMANDS: Record<string, Command> = {
  "keys new": {
    options: { name: { type: "string" } },
    async run(ctx, v) {
      const name = required(v, "name");
      return saveRootKey(name, generatePrivateKey(), await ctx.keystore(true, true));
    },
  },
  "keys import": {
    options: { name: { type: "string" } },
    async run(ctx, v) {
      const name = required(v, "name");
      const stdin = ctx.io.stdin;
      if (!stdin) throw new UsageError("keys import reads the private key from stdin");
      const key = stdin.isTTY
        ? await promptHidden(stdin, ctx.io.stderr, "Private key: ")
        : await readAll(stdin);
      // Never echo the input: it is (almost) a key.
      if (!isHex(key) || key.length !== 66) {
        throw new UsageError("the private key must be 32 bytes of 0x-prefixed hex");
      }
      return saveRootKey(name, key, await ctx.keystore(true, true));
    },
  },
  "keys list": {
    async run(ctx) {
      const options = await ctx.keystore();
      const dir = join(ctx.home, "keys");
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
      return {
        keys: files.sort().map((keyfile) => {
          const { address } = JSON.parse(readFileSync(join(dir, keyfile), "utf8"));
          return { keyfile, address: getAddress(`0x${String(address).replace(/^0x/, "")}`) };
        }),
        profiles: Object.entries(readProfiles(options)).map(([name, p]) => ({ name, ...p })),
      };
    },
  },
  "account init": {
    options: { ...ROOT, ...AGENT, grant: { type: "string" } },
    async run(ctx, v) {
      const [file, agent] = [string(v, "grant"), string(v, "agent")];
      if (!file !== !agent) throw new UsageError("--grant and --agent go together");
      const policy = file ? parsePolicy(file) : undefined;
      const root = rootProfile(ctx, await ctx.keystore());
      const account = await mantleAccount(ctx, root, true);
      const options = await ctx.keystore(true);
      const previous = agent ? archiveProfile(options, agent) : undefined;
      const result = await account.init(
        policy && agent ? { grant: { policy, agentName: agent } } : {},
      );
      return {
        account: account.address,
        state: result.state,
        hash: result.hash ?? null,
        session: result.session ? grantOutput(result.session, previous) : null,
      };
    },
  },
  "account status": {
    options: ROOT,
    async run(ctx) {
      const root = rootProfile(ctx, await ctx.keystore());
      return (await mantleAccount(ctx, root, false)).status();
    },
  },
  "account exec": {
    options: { ...ROOT, ...CALLS, release: { type: "string", multiple: true } },
    async run(ctx, v) {
      const calls = parseCalls(required(v, "calls"));
      const release = parseRelease((v.release as string[] | undefined) ?? []);
      const account = await mantleAccount(ctx, rootProfile(ctx, await ctx.keystore()), true);
      return { account: account.address, ...(await account.exec(calls, { release })) };
    },
  },
  "account panic": {
    options: { ...ROOT, "self-pay": { type: "boolean" }, undelegate: { type: "boolean" } },
    async run(ctx, v) {
      const selfPay = v["self-pay"] === true;
      const undelegate = v.undelegate === true;
      if (undelegate && !selfPay) {
        throw new UsageError(
          "--undelegate needs --self-pay: the sponsor relays no delegation to the zero address, so the root sends it",
        );
      }
      const account = await mantleAccount(ctx, rootProfile(ctx, await ctx.keystore()), true);
      let result: PanicResult;
      try {
        result = await account.panic({ selfPay, undelegate });
      } catch (error) {
        if (error instanceof UndelegationFailedError) throw error;
        const why = error instanceof BaseError ? error.shortMessage : (error as Error)?.message;
        throw new Error(
          `Revocation (phase 1) not confirmed${undelegate ? "; undelegation (phase 2) not attempted" : ""}: ${why}. ` +
            `Check account status, then rerun account panic${selfPay ? "" : " (with --self-pay, after funding the root, if the sponsor is down)"}`,
          { cause: error },
        );
      }
      return { account: account.address, ...result, recovery: panicRecovery(result) };
    },
  },
  "session grant": {
    options: { ...ROOT, ...AGENT, policy: { type: "string" } },
    async run(ctx, v) {
      const agent = required(v, "agent");
      const policy = parsePolicy(required(v, "policy"));
      const account = await mantleAccount(ctx, rootProfile(ctx, await ctx.keystore()), true);
      const previous = archiveProfile(await ctx.keystore(true), agent);
      const grant = await account.grantSession(policy, { agentName: agent });
      return { account: account.address, ...grantOutput(grant, previous) };
    },
  },
  "session update": {
    options: { ...ROOT, ...AGENT, policy: { type: "string" } },
    async run(ctx, v) {
      const agent = required(v, "agent");
      const policy = parsePolicy(required(v, "policy"));
      const options = await ctx.keystore();
      const { account: owner, keyHash } = agentProfile(options, agent);
      const account = await mantleAccount(ctx, rootProfile(ctx, options, getAddress(owner)), true);
      const result = await account.updateSession(keyHash, policy);
      return { account: account.address, profile: agent, keyHash, ...result };
    },
  },
  "session revoke": {
    options: { ...ROOT, ...AGENT },
    async run(ctx, v) {
      const agent = required(v, "agent");
      const options = await ctx.keystore();
      const { account: owner, keyHash } = agentProfile(options, agent);
      const account = await mantleAccount(ctx, rootProfile(ctx, options, getAddress(owner)), true);
      const result = await account.revokeSession(keyHash);
      return { account: account.address, profile: agent, keyHash, ...result };
    },
  },
  "session list": {
    options: ROOT,
    async run(ctx) {
      const account = await mantleAccount(ctx, rootProfile(ctx, await ctx.keystore()), false);
      return { account: account.address, sessions: await account.listSessions() };
    },
  },
  "agent simulate": {
    options: { ...AGENT, ...CALLS },
    async run(ctx, v) {
      const agent = required(v, "agent");
      const calls = parseCalls(required(v, "calls"));
      const session = await agentSession(ctx, agent, false);
      await session.simulate(calls);
      return {
        account: session.account,
        profile: agent,
        keyHash: session.keyHash,
        calls: calls.length,
      };
    },
  },
  "agent exec": {
    options: { ...AGENT, ...CALLS },
    async run(ctx, v) {
      const agent = required(v, "agent");
      const calls = parseCalls(required(v, "calls"));
      const session = await agentSession(ctx, agent, true);
      const result = await session.exec(calls, { via: ctx.via });
      return { account: session.account, profile: agent, keyHash: session.keyHash, ...result };
    },
  },
  "sponsor serve": {
    options: { config: { type: "string" } },
    async run(ctx, v) {
      const config = loadConfig(required(v, "config"));
      const sponsor = await startSponsor(config, { env: ctx.env });
      try {
        print(ctx, "sponsor serve", { url: sponsor.url, relayer: config.relayer });
        await stopped(ctx.io.signal);
      } finally {
        await sponsor.close();
      }
      return PRINTED;
    },
  },
  "sponsor relayer status": relayerCommand("status"),
  "sponsor relayer bump": relayerCommand("bump"),
  "sponsor relayer cancel": relayerCommand("cancel"),
};

/** What the root does after a panic (docs/DESIGN.md §7.3). */
function panicRecovery(result: PanicResult): string[] {
  return [
    ...(result.undelegation
      ? [
          "The account is undelegated; its keys, nonces and hook storage remain. To use it as a smart account again, run account init: revoked keys stay revoked.",
        ]
      : []),
    "Revoked keys never come back. Their inventory stays frozen until the root releases it: account exec --release <keyHash,token,amount>.",
    "Grant new sessions with session grant (always a new key).",
  ];
}

async function agentSession(ctx: Context, agent: string, submits: boolean) {
  const options = await ctx.keystore(true);
  const profile = agentProfile(options, agent);
  return new AgentSession({
    client: ctx.client(),
    account: profile.account,
    keyHash: profile.keyHash,
    signer: loadProfileSigner(agent, options),
    addresses: ctx.addresses,
    ...(submits && { executor: ctx.executor(getAddress(profile.account)) }),
  });
}

// ---- entry point ------------------------------------------------------------------------------

const toJson = (value: unknown, indent?: number) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), indent);

function print(ctx: Context, command: string, result: unknown): void {
  ctx.io.stdout(
    ctx.values.json ? `${toJson({ ok: true, command, result })}\n` : `${toJson(result, 2)}\n`,
  );
}

/**
 * Runs one `mantle-aa` command line and resolves to its exit code (docs/DESIGN.md §6). With
 * `--json`, stdout carries exactly one JSON object: `{ ok: true, command, result }`, or
 * `{ ok: false, command, exitCode, error: { code, type, message, …fields } }`. Without it, the
 * result is printed as indented JSON and an error as one line on stderr. No output carries a key,
 * a password or a URL of the error's making (URLs in errors are redacted).
 */
export async function run(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const stdin = io.stdin ?? (process.stdin as SecretInput);
  const firstOption = argv.findIndex((a) => a.startsWith("-"));
  const words = argv.slice(0, firstOption === -1 ? argv.length : firstOption);
  const command = [3, 2].map((n) => words.slice(0, n).join(" ")).find((c) => COMMANDS[c]);
  const json = argv.includes("--json");
  let ctx: Context | undefined;
  try {
    if (!command) {
      if (argv.includes("--help") || argv.includes("-h") || !argv.length) {
        stdout(USAGE);
        return argv.length ? 0 : 1;
      }
      throw new UsageError(`unknown command ${JSON.stringify(words.join(" "))}`);
    }
    const spec = COMMANDS[command] as Command;
    const extra = words.length - command.split(" ").length;
    if (extra) throw new UsageError(`unexpected argument ${JSON.stringify(words.at(-extra))}`);
    let values: Values;
    try {
      values = parseArgs({
        args: argv.slice(command.split(" ").length) as string[],
        options: { ...GLOBAL_OPTIONS, ...spec.options },
        strict: true,
        allowPositionals: false,
      }).values as Values;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    if (values.help) {
      stdout(USAGE);
      return 0;
    }
    if (values.via !== undefined && values.via !== "relayer" && values.via !== "bundler") {
      throw new UsageError("--via must be relayer or bundler");
    }
    ctx = new Context({ ...io, stdout, stderr, stdin }, values);
    const result = await spec.run(ctx, values);
    if (result !== PRINTED) print(ctx, command, result);
    return 0;
  } catch (error) {
    const { exitCode, error: details } = describeError(error);
    if (json) {
      stdout(
        `${redact(toJson({ ok: false, command: command ?? null, exitCode, error: details }))}\n`,
      );
    } else {
      stderr(`error: ${details.message}\n`);
    }
    return exitCode;
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}
