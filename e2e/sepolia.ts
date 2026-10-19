// The Mantle Sepolia acceptance run (docs/DESIGN.md §8) on the real chain. It spends real testnet
// MNT, so it is a script, not a test suite: vitest collects only `*.test.ts`, and CI never runs it.
//
//   node --experimental-transform-types --import ./e2e/source-hooks.mjs e2e/sepolia.ts [phase…]
//
// Phases, in this order by default; each uses fresh root and agent keys (its own MANTLE_AA_HOME),
// so a phase can be rerun on its own:
//   relayer  §8 steps 1–6 through the relayer path (`mantle-aa sponsor serve` relays)
//   bundler  §8 steps 1–6 through the bundler path (`--via bundler`, strict Alto against the real
//            chain via e2e/bundler/sepolia.sh, the deployed VerifyingPaymaster)
//   value    the MNT value case: the account is funded explicitly after init; maxValuePerCall and
//            the MNT limit; the principal goes back to the funder
//   panic    the sponsor is stopped; the root is funded; `account panic --self-pay --undelegate`
// The relayer and bundler phases come first and never fund the human or an agent: they hold 0 MNT
// throughout. Only the value phase's account receives MNT (principal), and only the panic phase's
// root pays gas.
//
// Every overreach of step 4 is refused three times, as in e2e/relayer/relayer.test.ts and
// e2e/bundler/path.test.ts: by `agent exec` (the SDK's local pre-check, nothing sent), by the
// sponsor for a request built without the pre-check, and on chain: a third-party funder EOA sends
// the session-signed batch straight to the account (relayer path), or the session-signed UserOp,
// with paymaster data signed by the paymaster's signer key, to `EntryPoint.handleOps` (bundler
// path). Those transactions are mined (fixed gas, no estimate) and revert or carry the hook's
// revert in `UserOperationRevertReason`; the reason of a whole-transaction revert is decoded from
// an `eth_call` of the same call at the latest block.
//
// Env: MANTLE_SEPOLIA_RPC_URL; ACCEPTANCE_RELAYER_KEY (the sponsor's relayer hot wallet);
// ACCEPTANCE_FUNDER_KEY (the third party: direct submissions, fixtures, the value principal, the
// panic gas); PAYMASTER_SIGNER_PRIVATE_KEY (the deployed VerifyingPaymaster's verifyingSigner);
// BUNDLER_PRIVATE_KEY (the bundler phase: Alto's executor, handed to sepolia.sh); ACCEPTANCE_RUN_DIR
// (default $TMPDIR/mantle-aa-acceptance): homes, the sponsor's database, Alto's logs, and the
// results (`<phase>.jsonl`, `<phase>.md`, `summary.json`). No key is printed or written there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentPolicyHookAbi,
  BundlerExecutor,
  type Call,
  caliburAbi,
  type Executor,
  encodeUserOpCallData,
  getCaliburDomain,
  laneOf,
  launchpadAbi,
  loadDeployments,
  loadKey,
  loadProfileSigner,
  MantleAccount,
  mantleSepolia,
  RelayerExecutor,
  readCaliburNonce,
  readProfiles,
  redactUrls,
  type Signer,
  SponsorRejectedError,
  signBatchedCall,
} from "@mantle-aa/sdk";
import {
  type Address,
  BaseError,
  concat,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  type Hex,
  hashMessage,
  http,
  isHex,
  maxUint256,
  parseAbi,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
  toPrefixedMessage,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  entryPoint08Abi,
  formatUserOperationRequest,
  getUserOperationTypedData,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { run } from "../packages/cli/src/index.js";
import { parsePolicy } from "../packages/cli/src/input.js";
import { type CliResult, cli, PASSWORD, testEnv } from "../packages/cli/test/helpers.js";

// ---- configuration ----------------------------------------------------------------------------

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const RPC = env("MANTLE_SEPOLIA_RPC_URL");
const RELAYER_KEY = env("ACCEPTANCE_RELAYER_KEY") as Hex;
const FUNDER_KEY = env("ACCEPTANCE_FUNDER_KEY") as Hex;
const SIGNER_KEY = env("PAYMASTER_SIGNER_PRIVATE_KEY") as Hex;
const RUN_DIR = process.env.ACCEPTANCE_RUN_DIR ?? join(tmpdir(), "mantle-aa-acceptance");
const SECRETS = [RELAYER_KEY, FUNDER_KEY, SIGNER_KEY, process.env.BUNDLER_PRIVATE_KEY ?? ""]
  .filter(Boolean)
  .map((k) => k.replace(/^0x/, "").toLowerCase());

const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const HOOK = book.agentPolicyHook;
const EP = book.entryPoint;
const PAYMASTER = book.verifyingPaymaster;
const usd = (n: number) => BigInt(n) * 10n ** 6n;
const UNIT = 10n ** 21n; // MockLaunchpad: 1 mUSD buys 1e21 meme units
/** Meme the human holds before any session exists (bought for them by the funder). */
const HUMAN_MEME = 7n * UNIT;
const EXPLORER = "https://sepolia.mantlescan.xyz/tx/";
const BUNDLER_URL = "http://127.0.0.1:4337";
const BUNDLER_RUN_DIR = join(RUN_DIR, "bundler");
const SEPOLIA_SH = new URL("./bundler/sepolia.sh", import.meta.url).pathname;
/** The acceptance sponsor's caps: one request up to 0.1 MNT admits init + first grant (≈0.055). */
const CAPS = {
  accountDailyGas: 30_000_000,
  maxFeePerRequestMnt: "0.1",
  dailyBudgetMnt: "1",
  managementReserveMnt: "0.4",
};
/** Stop before a phase when a wallet holds less than this (MNT); see docs/acceptance.md. */
const FLOOR: Record<
  string,
  Partial<Record<"relayer" | "funder" | "executor" | "deposit", string>>
> = {
  relayer: { relayer: "0.3", funder: "0.3" },
  bundler: { funder: "0.35", executor: "0.2", deposit: "1" },
  value: { relayer: "0.1", funder: "0.15" },
  panic: { relayer: "0.1", funder: "0.1" },
};
/** The MNT value case: principal sent to the account, the session's per-call cap and MNT limit. */
const VALUE = {
  principal: parseEther("0.02"),
  maxValuePerCall: parseEther("0.005"),
  mntCap: parseEther("0.008"),
  paid: parseEther("0.005"),
};
const PANIC_FUNDING = parseEther("0.05");
const SCRYPT = { n: 1024, r: 8, p: 1 };

const client = createPublicClient({
  chain: mantleSepolia,
  transport: http(RPC, { timeout: 30_000, retryCount: 5 }),
});
const relayer = privateKeyToAccount(RELAYER_KEY);
const funder = privateKeyToAccount(FUNDER_KEY);
const paymasterSigner = privateKeyToAccount(SIGNER_KEY);
const funderWallet = createWalletClient({
  account: funder,
  chain: mantleSepolia,
  transport: http(RPC, { timeout: 30_000, retryCount: 5 }),
});

// ---- ABIs and revert decoding -----------------------------------------------------------------

const mockUsdAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const paymasterAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function getHash(PackedUserOperation userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
  "function verifyingSigner() view returns (address)",
]);
const selfExecuteAbi = parseAbi([
  "struct Call { address to; uint256 value; bytes data; }",
  "struct BatchedCall { Call[] calls; bool revertOnFailure; }",
  "function execute(BatchedCall batchedCall)",
]);
/** The reverts a direct submission can produce (Calibur v1.1.0, AgentPolicyHook). */
const revertAbi = parseAbi([
  "error CallFailed(bytes reason)",
  "error InvalidSignature()",
  "error SignatureExpired()",
  "error Unauthorized()",
  "error KeyDoesNotExist()",
  "error KeyExpired(uint40 expiration)",
  "error InvalidNonce()",
  "error OnlyAdminCanSelfCall()",
  "error SessionInactive()",
  "error TargetIsHook()",
  "error CallNotPermitted(address to, bytes4 selector)",
  "error LimitExceeded(address token)",
  "error ValueExceeded(uint256 value, uint256 maxValuePerCall)",
  "error RecipientNotAccount(address recipient)",
  "error DeadlineOutOfRange(uint256 deadline)",
  "error InventoryExceeded(address token, uint256 held)",
  "error AttributionGap(address token)",
  "error CallFailed()",
  "error WrongPaymaster()",
  "error WrongCallData()",
  "error SessionKeySignatureRejected()",
  "error SessionExists()",
  "error SessionRevoked()",
]);

/** `Name` of a revert; a Calibur `CallFailed(bytes)` is unwrapped to `CallFailed(Name)`. */
function revertName(data: Hex): string {
  const { errorName, args } = decodeErrorResult({ abi: revertAbi, data });
  if (errorName === "CallFailed" && args?.length && args[0] !== "0x") {
    return `CallFailed(${revertName(args[0] as Hex)})`;
  }
  return errorName;
}

/** An EntryPoint validation failure as `AAxx reason` or `AAxx reason: InnerRevert`. */
function failedOp(data: Hex): string {
  const { errorName, args } = decodeErrorResult({ abi: entryPoint08Abi, data });
  if (errorName === "FailedOp") return args[1];
  if (errorName === "FailedOpWithRevert") return `${args[1]}: ${revertName(args[2])}`;
  throw new Error(`unexpected EntryPoint revert ${errorName}`);
}

/** The revert data of a failed `eth_call` (the deepest cause carries it). */
function revertData(error: unknown): Hex {
  const cause = error instanceof BaseError ? (error.walk() as { data?: unknown }) : undefined;
  const raw = cause?.data;
  const data = typeof raw === "object" ? (raw as { data?: unknown } | null)?.data : raw;
  if (!isHex(data)) throw error;
  return data;
}

// ---- results ----------------------------------------------------------------------------------

interface Row {
  phase: string;
  step: string;
  item: string;
  /** What happened: a refusal and its reason, a revert reason, `success`, a check. */
  outcome: string;
  hash?: Hex;
  from?: Address;
  status?: string;
  /** Wei the sender paid: L2 gas + L1 fee + operator fee (docs/infra.md §5). */
  paid?: string;
  /** Wei the paymaster's EntryPoint deposit was charged (`actualGasCost`), bundles only. */
  deposit?: string;
  /** MNT moved as principal (value), not gas. */
  principal?: string;
  at: string;
}

let phase = "";
const rows: Row[] = [];
/** Every output: no key, and no URL (the RPC URL may carry an API key; viem errors print it). */
const scrub = (text: string) =>
  redactUrls(
    SECRETS.reduce((t, s) => t.replaceAll(new RegExp(s, "gi"), "<redacted>"), text).replaceAll(
      RPC,
      "<redacted-url>",
    ),
  );

function log(line: string) {
  console.log(scrub(`${new Date().toISOString()} [${phase}] ${line}`));
}

function record(row: Omit<Row, "phase" | "at">): void {
  const line = scrub(JSON.stringify({ phase, ...row, at: new Date().toISOString() }));
  const full: Row = JSON.parse(line);
  rows.push(full);
  appendFileSync(join(RUN_DIR, `${phase}.jsonl`), `${line}\n`);
  log(`${row.step} | ${row.item} | ${row.outcome}${row.hash ? ` | ${row.hash}` : ""}`);
}

/** A mined transaction's sender, status and fee; `deposit` is the op's charge for a bundle. */
async function costOf(hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: 180_000,
    pollingInterval: 2_000,
  });
  const raw = (await client.request({
    method: "eth_getTransactionReceipt",
    params: [hash],
  } as never)) as Record<string, Hex | undefined>;
  const big = (field: string) => BigInt(raw[field] ?? "0x0");
  const paid =
    big("gasUsed") * big("effectiveGasPrice") +
    big("l1Fee") +
    big("gasUsed") * big("operatorFeeScalar") * 100n +
    big("operatorFeeConstant");
  const events = parseEventLogs({
    abi: entryPoint08Abi,
    eventName: "UserOperationEvent",
    logs: receipt.logs,
  });
  const deposit = events.reduce((sum, e) => sum + e.args.actualGasCost, 0n);
  return { receipt, paid, deposit, events };
}

/** Records a mined transaction with its fee. */
async function recordTx(
  step: string,
  item: string,
  hash: Hex,
  outcome: string,
  extra: { principal?: bigint } = {},
) {
  const { receipt, paid, deposit } = await costOf(hash);
  // Every node behind the load balancer has the transaction before the next read or signature.
  await until(
    async () => (await client.getBlockNumber()) >= receipt.blockNumber + 2n,
    120_000,
    "two blocks past the transaction",
  );
  record({
    step,
    item,
    outcome,
    hash,
    from: receipt.from,
    status: receipt.status,
    paid: paid.toString(),
    ...(deposit && { deposit: deposit.toString() }),
    ...(extra.principal !== undefined && { principal: extra.principal.toString() }),
  });
  return receipt;
}

async function balances() {
  const executor = process.env.BUNDLER_PRIVATE_KEY
    ? privateKeyToAccount(process.env.BUNDLER_PRIVATE_KEY as Hex).address
    : undefined;
  return {
    relayer: await client.getBalance({ address: relayer.address }),
    funder: await client.getBalance({ address: funder.address }),
    ...(executor && { executor: await client.getBalance({ address: executor }) }),
    deposit: await client.readContract({
      address: EP,
      abi: entryPoint08Abi,
      functionName: "balanceOf",
      args: [PAYMASTER],
    }),
  };
}
type Balances = Awaited<ReturnType<typeof balances>>;
const mnt = (b: Partial<Balances>) =>
  Object.fromEntries(Object.entries(b).map(([k, v]) => [k, formatEther(v as bigint)]));

/** One markdown table of the phase's rows: every transaction links to the explorer. */
function markdown(list: Row[]): string {
  const fee = (wei?: string) => (wei ? formatEther(BigInt(wei)) : "");
  const lines = [
    "| Step | Item | Outcome | Transaction | Sender | Fee paid (MNT) | Deposit charged (MNT) |",
    "| --- | --- | --- | --- | --- | ---: | ---: |",
    ...list.map((r) =>
      [
        r.step,
        r.item,
        r.outcome.replaceAll("|", "\\|"),
        r.hash ? `[${r.hash.slice(0, 10)}…${r.hash.slice(-4)}](${EXPLORER}${r.hash})` : "—",
        r.from ? `${r.from.slice(0, 6)}…${r.from.slice(-4)}` : "",
        fee(r.paid),
        fee(r.deposit),
      ].join(" | "),
    ),
  ];
  return `${lines.map((l) => (l.startsWith("|") ? l : `| ${l} |`)).join("\n")}\n`;
}

// ---- chain helpers ----------------------------------------------------------------------------

const now = async () => (await client.getBlock()).timestamp;
/** UserOperationEvents of `sender` since `fromBlock`: did a failed attempt land after all? */
const opsSince = (sender: Address, fromBlock: bigint) =>
  client.getContractEvents({
    address: EP,
    abi: entryPoint08Abi,
    eventName: "UserOperationEvent",
    args: { sender },
    fromBlock,
    toBlock: "latest",
  });

/** Polls `check` every 2 s until it holds; fails after `ms`. */
async function until(check: () => Promise<boolean> | boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(2_000);
  }
}

/**
 * Retries `check` for up to `ms`: the public RPC is load-balanced over nodes that can be a block
 * apart (measured: `eth_blockNumber` went backwards by one in 2 of 25 consecutive calls).
 */
async function eventually(check: () => Promise<void>, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(3_000);
    }
  }
}

/** The funder's transaction, mined and recorded. */
async function funderTx(
  step: string,
  item: string,
  request: Parameters<typeof funderWallet.writeContract>[0],
) {
  const hash = await funderWallet.writeContract(request);
  const receipt = await recordTx(step, item, hash, "success");
  assert.equal(receipt.status, "success", `${item}: ${hash}`);
}

/** The funder's MockUSD and its allowance to the launchpad, for the human's meme (once per run). */
async function funderFixture() {
  const held = await client.readContract({
    address: USD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [funder.address],
  });
  if (held < usd(50)) {
    await funderTx("fixture", "funder mints 100 mUSD (for the human's meme)", {
      address: USD,
      abi: mockUsdAbi,
      functionName: "mint",
      args: [funder.address, usd(100)],
    } as never);
  }
  const allowed = await client.readContract({
    address: USD,
    abi: mockUsdAbi,
    functionName: "allowance",
    args: [funder.address, PAD],
  });
  if (allowed < usd(50)) {
    await funderTx("fixture", "funder approves the launchpad", {
      address: USD,
      abi: erc20Abi,
      functionName: "approve",
      args: [PAD, maxUint256],
    } as never);
  }
}

// ---- the acceptance sponsor -------------------------------------------------------------------

/** `mantle-aa sponsor serve` with the relayer key and the paymaster signer key from env. */
async function serveSponsor(home: string, allowlist: Address[], cliEnv: NodeJS.ProcessEnv) {
  const config = join(home, "sponsor.yaml");
  writeFileSync(
    config,
    [
      "chainId: 5003",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
      "rpcUrl: ${MANTLE_SEPOLIA_RPC_URL}",
      "listen: { host: 127.0.0.1, port: 0 }",
      `database: ${join(RUN_DIR, "sponsor.sqlite")}`,
      `relayer: "${relayer.address}"`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
      "relayerKey: ${ACCEPTANCE_RELAYER_KEY}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
      "paymasterSignerKey: ${PAYMASTER_SIGNER_PRIVATE_KEY}",
      "settleTimeoutSeconds: 30",
      "policy:",
      `  allowlist: [${allowlist.map((a) => `"${a}"`).join(", ")}]`,
      `  accountDailyGas: ${CAPS.accountDailyGas}`,
      `  maxFeePerRequestMnt: "${CAPS.maxFeePerRequestMnt}"`,
      `  dailyBudgetMnt: "${CAPS.dailyBudgetMnt}"`,
      `  managementReserveMnt: "${CAPS.managementReserveMnt}"`,
    ].join("\n"),
  );
  const abort = new AbortController();
  let out = "";
  const serving = run(["sponsor", "serve", "--config", config, "--json"], {
    env: {
      ...cliEnv,
      ACCEPTANCE_RELAYER_KEY: RELAYER_KEY,
      PAYMASTER_SIGNER_PRIVATE_KEY: SIGNER_KEY,
    },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => appendFileSync(join(home, "sponsor.log"), scrub(t)),
    signal: abort.signal,
  });
  let exited = false;
  void serving.then(() => {
    exited = true;
  });
  await until(() => out.includes("\n") || exited, 60_000, "sponsor serve");
  assert.ok(!exited, `sponsor serve exited: ${scrub(out)}`);
  const served = JSON.parse(out).result as { url: string; relayer: Address };
  assert.equal(served.relayer, relayer.address);
  log(`sponsor serve on ${served.url}, allowlist ${allowlist.join(", ")}`);
  return {
    url: served.url,
    stop: async () => {
      abort.abort();
      await serving;
      log("sponsor stopped");
    },
  };
}

// ---- the bundler stack (e2e/bundler/sepolia.sh) -----------------------------------------------

const altoLog = join(BUNDLER_RUN_DIR, "alto.log");
const altoSize = () => (existsSync(altoLog) ? statSync(altoLog).size : 0);
/** Alto's log since byte `since`, the lines worth keeping as evidence. */
function altoExcerpt(
  since: number,
  pattern = /error|reject|unstaked|-325|2nd Validation|too long/i,
) {
  if (!existsSync(altoLog)) return "";
  const text = readFileSync(altoLog, "utf8").slice(since);
  return scrub(
    text
      .split("\n")
      .filter((l) => pattern.test(l))
      .slice(-20)
      .map((l) => l.slice(0, 400))
      .join("\n"),
  );
}

function sepoliaSh(command: "up" | "down") {
  const out = execFileSync(SEPOLIA_SH, [command], {
    env: { ...process.env, BUNDLER_RUN_DIR, UPSTREAM_RPC_URL: RPC },
    encoding: "utf8",
    timeout: 600_000,
  });
  log(`sepolia.sh ${command}: ${out.trim().replaceAll("\n", "; ")}`);
}

/** Nothing else may answer on the stack's fixed ports (another run's anvil or Alto). */
async function portsFree() {
  for (const port of [18545, 18546, 4337]) {
    const answered = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      signal: AbortSignal.timeout(3_000),
    }).then(
      () => true,
      () => false,
    );
    assert.ok(!answered, `port ${port} is in use: is another bundler stack running?`);
  }
}

async function bundlerRpc(method: string, params: unknown[]) {
  const res = await fetch(BUNDLER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

// ---- the paths --------------------------------------------------------------------------------

type Via = "relayer" | "bundler";

/** §8 policy: approve / buy / sell on the mocks, MockUSD caps, the launchpad as the only spender. */
const policyJson = (extra: { value?: boolean } = {}) => ({
  ...(extra.value && {
    maxValuePerCall: String(VALUE.maxValuePerCall),
    mntLimit: {
      token: zeroAddress,
      totalCap: String(VALUE.mntCap),
      periodCap: String(VALUE.mntCap),
    },
  }),
  quoteLimits: [{ token: USD, totalCap: String(usd(100)), periodCap: String(usd(50)) }],
  periodLength: 86400,
  permissions: [
    { target: USD, selector: "approve(address,uint256)", ruleKind: "ERC20_APPROVE" },
    {
      target: PAD,
      selector: "buy(address,uint256,uint256,uint256,address)",
      ruleKind: "LAUNCHPAD_BUY",
    },
    {
      target: PAD,
      selector: "sell(address,uint256,uint256,uint256,address)",
      ruleKind: "LAUNCHPAD_SELL",
    },
    // The value case pays MNT to the funder: a plain transfer (selector 0x00000000).
    ...(extra.value ? [{ target: funder.address, selector: "0x00000000", ruleKind: "NONE" }] : []),
  ],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
});

const callsJson = (calls: Call[]) =>
  JSON.stringify(calls.map((c) => ({ to: c.to, value: String(c.value), data: c.data })));
const approve = (amount: bigint): Call => ({
  to: USD,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAD, amount] }),
});

/** One account (a fresh root key) driven through the CLI on one path. */
class Run {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly keystore: { home: string; password: string; scrypt: typeof SCRYPT };
  account!: Address;
  sponsorUrl!: string;
  stopSponsor: (() => Promise<void>) | undefined;
  /** The sponsor reached without the SDK's pre-check, on this run's path. */
  sponsor!: Executor;
  executor: Address | undefined;
  /** Alto's log size when the last successful `submit` attempt started. */
  stepLog = 0;

  constructor(readonly via: Via) {
    this.home = join(RUN_DIR, `${phase}-${Date.now()}`);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.env = testEnv(this.home, {
      MANTLE_AA_RPC_URL: RPC,
      ...(via === "bundler" && { MANTLE_AA_BUNDLER_URL: BUNDLER_URL }),
    });
    this.keystore = { home: this.env.MANTLE_AA_HOME as string, password: PASSWORD, scrypt: SCRYPT };
    if (via === "bundler") {
      this.executor = privateKeyToAccount(env("BUNDLER_PRIVATE_KEY") as Hex).address;
    }
  }

  async start(policy: object) {
    writeFileSync(join(this.home, "policy.json"), JSON.stringify(policy));
    await this.s(["keys", "new", "--name", "human"], 0);
    this.account = readProfiles(this.keystore).human?.account as Address;
    log(`account (human) ${this.account}, home ${this.home}`);
    await this.serve();
  }

  async serve() {
    const served = await serveSponsor(this.home, [this.account], this.env);
    this.sponsorUrl = served.url;
    this.stopSponsor = served.stop;
    this.env.MANTLE_AA_SPONSOR_URL = served.url;
    this.sponsor =
      this.via === "relayer"
        ? new RelayerExecutor({ client, url: served.url, addresses: book })
        : new BundlerExecutor({
            client,
            bundlerUrl: BUNDLER_URL,
            sponsorUrl: served.url,
            addresses: book,
          });
  }

  get policy() {
    return join(this.home, "policy.json");
  }

  // ---- reads ----
  read = (fn: "inventory" | "remainingLimit", token: Address, key: Hex) =>
    client.readContract({
      address: HOOK,
      abi: agentPolicyHookAbi,
      functionName: fn as "inventory",
      args: [key, this.account, token],
    });
  balanceOf = (token: Address) =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account],
    });
  allowance = () =>
    client.readContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "allowance",
      args: [this.account, PAD],
    });
  epNonce = (key: bigint) =>
    client.readContract({
      address: EP,
      abi: entryPoint08Abi,
      functionName: "getNonce",
      args: [this.account, key],
    });
  deposit = (who: Address) =>
    client.readContract({
      address: EP,
      abi: entryPoint08Abi,
      functionName: "balanceOf",
      args: [who],
    });
  /** What an overreach must leave untouched. */
  state = async (key: Hex) => ({
    usd: await this.balanceOf(USD),
    meme: await this.balanceOf(MEME),
    allowance: await this.allowance(),
    remaining: await this.read("remainingLimit", USD, key),
    inventory: await this.read("inventory", MEME, key),
    mnt: await client.getBalance({ address: this.account }),
    deposit: await this.deposit(this.account),
  });
  /** Transactions sent by whoever submits on this path: the relayer, or Alto's executor. */
  submitted = () =>
    client.getTransactionCount({
      address: this.via === "relayer" ? relayer.address : (this.executor as Address),
    });
  trade = async (
    fn: "buy" | "sell",
    amount: bigint,
    opts: { deadline?: bigint; recipient?: Address } = {},
  ): Promise<Call> => ({
    to: PAD,
    value: 0n,
    data: encodeFunctionData({
      abi: launchpadAbi,
      functionName: fn,
      args: [
        MEME,
        amount,
        0n,
        opts.deadline ?? (await now()) + 300n,
        opts.recipient ?? this.account,
      ],
    }),
  });
  async zeroMnt(who: Address[]) {
    for (const address of who) {
      assert.equal(await client.getBalance({ address }), 0n, `${address} holds MNT`);
    }
  }

  // ---- the CLI ----

  /** One CLI command (with `--via bundler` on the bundler path); checks its exit code and output. */
  async s(args: string[], code: number): Promise<CliResult> {
    const full =
      args[0] === "keys" || this.via === "relayer" ? args : [...args, "--via", "bundler"];
    const result = await cli(full, this.env);
    const output = (result.stdout + result.stderr).toLowerCase();
    for (const secret of [...SECRETS, PASSWORD.toLowerCase()]) {
      assert.ok(!output.includes(secret), `${args.join(" ")} printed a secret`);
    }
    assert.equal(result.code, code, `${args.join(" ")}: ${scrub(result.stdout)}`);
    assert.equal(result.json?.ok, code === 0);
    return result;
  }

  /**
   * A submitting command that must succeed. On the bundler path, a refusal the bundler stack
   * causes (Alto's 10 s trace timeout, the paymaster throttled as unstaked, an op never included)
   * is recorded with Alto's log, the stack is restarted where that is the remedy, and the command
   * retried once the sponsorship window has passed and nothing of the account landed meanwhile.
   */
  async submit(step: string, item: string, args: () => Promise<string[]> | string[]) {
    for (let attempt = 1; ; attempt++) {
      const since = altoSize();
      const fromBlock = await client.getBlockNumber();
      const result = await cli(
        this.via === "relayer" ? await args() : [...(await args()), "--via", "bundler"],
        this.env,
      );
      if (result.code === 0) {
        this.stepLog = since;
        const output = (result.stdout + result.stderr).toLowerCase();
        for (const secret of SECRETS) assert.ok(!output.includes(secret), "printed a secret");
        return result;
      }
      const message = scrub(JSON.stringify(result.json?.error ?? result.stderr));
      const environmental =
        /too long|not included after|unstaked|-32505|SPONSOR_BUSY|Bundler error|fetch failed|timed out/i;
      if (this.via !== "bundler" || !environmental.test(message) || attempt >= 4) {
        throw new Error(`${item}: exit ${result.code}: ${message}`);
      }
      const restart = /unstaked|-32505|not included after/i.test(message);
      record({
        step,
        item: `${item} (attempt ${attempt})`,
        outcome: `INCIDENT exit ${result.code}: ${message.slice(0, 300)}${restart ? "; restarting the bundler stack" : ""}; Alto: ${altoExcerpt(since).slice(0, 1500) || "(no matching log line)"}`,
      });
      if (restart) {
        sepoliaSh("down");
        sepoliaSh("up");
      }
      // The SDK's sponsorship window is 60 s; the sponsor releases the account's slot after it.
      await sleep(75_000);
      const landed = await opsSince(this.account, fromBlock);
      if (landed.length) {
        throw new Error(
          `${item}: an op of the account landed after the failed attempt (${landed[0]?.transactionHash}); not retrying`,
        );
      }
    }
  }

  /** The transaction a successful command names: relayed by our relayer, or a bundle of our op. */
  async landed(step: string, item: string, r: CliResult, init = false) {
    const hash = r.json.result.hash as Hex;
    const { receipt, events } = await costOf(hash);
    assert.equal(receipt.status, "success");
    if (this.via === "relayer") {
      assert.equal(receipt.from.toLowerCase(), relayer.address.toLowerCase());
      assert.equal(receipt.to?.toLowerCase(), this.account.toLowerCase());
    } else {
      const tx = await client.getTransaction({ hash });
      assert.equal(tx.from.toLowerCase(), this.executor?.toLowerCase());
      assert.equal(tx.to?.toLowerCase(), EP.toLowerCase());
      assert.equal(tx.type === "eip7702", init, `bundle type ${tx.type}`);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.args.sender, this.account);
      assert.equal(events[0]?.args.paymaster, PAYMASTER);
      assert.equal(events[0]?.args.success, true);
      // Safe mode ran: Alto logged the ERC-7562 tracer result of a validation during the step.
      assert.ok(
        readFileSync(altoLog, "utf8").slice(this.stepLog).includes("tracerResult"),
        "no tracerResult in Alto's log for this step",
      );
    }
    await recordTx(
      step,
      item,
      hash,
      init && this.via === "bundler"
        ? "success (type-4 bundle, validation traced)"
        : this.via === "bundler"
          ? "success (validation traced)"
          : "success",
    );
  }

  // ---- refused three times ----

  /** `agent exec` refuses with `code`; nothing is submitted and no nonce moves. */
  async cliRefuses(
    step: string,
    item: string,
    agent: string,
    key: Hex,
    calls: Call[],
    code: number,
  ) {
    const [txs, nonce] = [await this.submitted(), await this.epNonce(laneOf(key))];
    const r = await this.s(["agent", "exec", "--agent", agent, "--calls", callsJson(calls)], code);
    assert.equal(await this.submitted(), txs);
    assert.equal(await this.epNonce(laneOf(key)), nonce);
    record({ step, item, outcome: `CLI refused: exit ${code} ${r.json.error.code}` });
    return r.json.error;
  }

  /** The sponsor, given the signed request without any pre-check, refuses it with `reason`. */
  async sponsorRefuses(
    step: string,
    item: string,
    signer: Signer,
    key: Hex,
    calls: Call[],
    reason: string,
  ) {
    const txs = await this.submitted();
    const error = await this.sponsor
      .submit({
        account: this.account,
        keyHash: key,
        calls,
        lane: laneOf(key),
        signer,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
      })
      .catch((e: unknown) => e);
    assert.ok(error instanceof SponsorRejectedError, `sponsor did not reject: ${String(error)}`);
    assert.equal(error.reason, reason, error.message);
    assert.equal(await this.submitted(), txs);
    record({ step, item, outcome: `sponsor refused: ${reason}` });
  }

  /** Relayer path: the session-signed batch, executor = the funder, deadline 10 min. */
  signDirect = async (signer: Signer, key: Hex, calls: Call[]) =>
    signBatchedCall(client, {
      account: this.account,
      implementation: book.caliburEntry,
      chainId: book.chainId,
      signer,
      keyHash: key,
      calls,
      nonce: await readCaliburNonce(client, this.account, laneOf(key)),
      executor: funder.address,
      deadline: (await now()) + 600n,
    });

  /**
   * Relayer path, on chain: the funder sends `execute(SignedBatchedCall, sig)` to the account with a
   * fixed gas limit, so the reverting transaction is mined; the reason is the same call's
   * `eth_call` revert. A call that would not revert is not sent.
   */
  async execute(step: string, item: string, data: Hex): Promise<string> {
    const reason = await client.call({ account: funder.address, to: this.account, data }).then(
      () => "no revert",
      (e: unknown) => revertName(revertData(e)),
    );
    assert.notEqual(reason, "no revert", `${item}: the direct submission would execute`);
    const hash = await funderWallet.sendTransaction({ to: this.account, data, gas: 1_000_000n });
    const receipt = await recordTx(step, item, hash, `reverted on chain: ${reason}`);
    assert.equal(receipt.status, "reverted");
    return reason;
  }

  /**
   * Bundler path: a UserOp of the account signed by `signer` (the root when `key` is 0), fixed gas,
   * on `key`'s lane; `paymaster` defaults to the deployed one, its data signed with the paymaster's
   * signer key (valid for 10 min of chain time).
   */
  async userOp(signer: Signer, key: Hex, calls: Call[], opts: { paymaster?: "none" } = {}) {
    const fees = await client.estimateFeesPerGas();
    let op: UserOperation<"0.8"> = {
      sender: this.account,
      nonce: await this.epNonce(laneOf(key)),
      callData: encodeUserOpCallData(calls),
      callGasLimit: 500_000n,
      verificationGasLimit: 400_000n,
      preVerificationGas: 60_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signature: "0x",
    };
    if (opts.paymaster !== "none") {
      op = {
        ...op,
        paymaster: PAYMASTER,
        paymasterVerificationGasLimit: 100_000n,
        paymasterPostOpGasLimit: 0n,
        paymasterData: "0x",
      };
      const validUntil = Number(await now()) + 600;
      const hash = await client.readContract({
        address: PAYMASTER,
        abi: paymasterAbi,
        functionName: "getHash",
        args: [toPackedUserOperation(op), validUntil, 0],
      });
      op.paymasterData = concat([
        encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, 0]),
        await paymasterSigner.signMessage({ message: { raw: hash } }),
      ]);
    }
    const signature = await signer.signTypedData(
      getUserOperationTypedData({
        chainId: book.chainId,
        entryPointAddress: EP,
        userOperation: op,
      }),
    );
    op.signature =
      BigInt(key) === 0n
        ? signature
        : encodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
            [key, signature, "0x"],
          );
    return op;
  }

  /**
   * Bundler path, on chain: the funder sends `handleOps([op], funder)` with a fixed gas limit. A
   * validation failure reverts the whole transaction (`AAxx reason[: InnerRevert]`, decoded from
   * the same call's `eth_call`); otherwise the op's UserOperationEvent and UserOperationRevertReason
   * give `success` or `reverted: Name`.
   */
  async handleOps(step: string, item: string, op: UserOperation<"0.8">): Promise<string> {
    const data = encodeFunctionData({
      abi: entryPoint08Abi,
      functionName: "handleOps",
      args: [[toPackedUserOperation(op)], funder.address],
    });
    const failed = await client.call({ account: funder.address, to: EP, data }).then(
      () => undefined,
      (e: unknown) => failedOp(revertData(e)),
    );
    const hash = await funderWallet.sendTransaction({ to: EP, data, gas: 2_000_000n });
    const { receipt, events } = await costOf(hash);
    let outcome: string;
    if (failed) {
      assert.equal(receipt.status, "reverted");
      outcome = failed;
    } else {
      assert.equal(receipt.status, "success");
      assert.equal(events[0]?.args.sender, this.account);
      const [why] = parseEventLogs({
        abi: entryPoint08Abi,
        eventName: "UserOperationRevertReason",
        logs: receipt.logs,
      });
      outcome = events[0]?.args.success
        ? "success"
        : why
          ? `reverted: ${revertName(why.args.revertReason)}`
          : "reverted";
    }
    await recordTx(step, item, hash, failed ? `reverted on chain: ${outcome}` : `op ${outcome}`);
    return outcome;
  }

  /** On chain, bypassing CLI, SDK and sponsor: the batch or UserOp signed with the session key. */
  async onChain(step: string, item: string, signer: Signer, key: Hex, calls: Call[]) {
    return this.via === "relayer"
      ? this.execute(step, item, await this.signDirect(signer, key, calls))
      : this.handleOps(step, item, await this.userOp(signer, key, calls));
  }

  /** The overreach is refused by the CLI, the sponsor and the chain; nothing changes. */
  async refusedEverywhere(
    item: string,
    agent: { name: string; signer: Signer; key: Hex },
    calls: Call[],
    expected: { cli: number; sponsor: string; chain: string },
  ) {
    const step = "4";
    const error = await this.cliRefuses(step, item, agent.name, agent.key, calls, expected.cli);
    await this.sponsorRefuses(step, item, agent.signer, agent.key, calls, expected.sponsor);
    const before = await this.state(agent.key);
    const chain = await this.onChain(step, item, agent.signer, agent.key, calls);
    assert.equal(chain, this.via === "relayer" ? expected.chain : `reverted: ${expected.chain}`);
    assert.deepEqual(await this.state(agent.key), before);
    return error;
  }
}

// ---- phases -----------------------------------------------------------------------------------

/** §8 steps 1–6 on one path. */
async function pathPhase(via: Via) {
  const r = new Run(via);
  if (via === "bundler") {
    await portsFree();
    sepoliaSh("up");
  }
  try {
    await r.start(policyJson());
    await steps(r);
  } finally {
    await r.stopSponsor?.();
    if (via === "bundler") sepoliaSh("down");
  }
}

async function steps(r: Run) {
  const { account } = r;
  const keystore = r.keystore;
  // The human already holds meme before any session exists: the funder buys it for them.
  await funderFixture();
  await funderTx("fixture", "funder buys 7 mUSD of meme for the human", {
    address: PAD,
    abi: launchpadAbi,
    functionName: "buy",
    args: [MEME, usd(7), 0n, (await now()) + 600n, account],
  } as never);
  assert.equal(await r.balanceOf(MEME), HUMAN_MEME);

  // 1. init with the first grant, gasless.
  assert.equal((await r.s(["account", "status"], 0)).json.result.state, "UNDELEGATED");
  const init = await r.submit("1", "account init --grant (trader)", () => [
    "account",
    "init",
    "--grant",
    r.policy,
    "--agent",
    "trader",
  ]);
  assert.equal(init.json.result.account, account);
  assert.equal(init.json.result.state, "INITIALIZED");
  assert.equal(init.json.result.session.profile, "trader");
  await r.landed("1", "account init --grant (trader): 7702 delegation + first grant", init, true);
  const keyHash = readProfiles(keystore).trader?.keyHash as Hex;
  const trader = loadProfileSigner("trader", keystore);
  const agent = { name: "trader", signer: trader, key: keyHash };
  await eventually(async () => {
    assert.equal((await r.s(["account", "status"], 0)).json.result.state, "INITIALIZED");
    await r.zeroMnt([account, trader.address]);
    assert.equal(await r.deposit(account), 0n);
  });
  record({ step: "1", item: "state INITIALIZED; human and agent 0 MNT", outcome: "checked" });
  // Principal is minted, never bought with MNT.
  await funderTx("fixture", "funder mints 200 mUSD to the account (principal)", {
    address: USD,
    abi: mockUsdAbi,
    functionName: "mint",
    args: [account, usd(200)],
  } as never);

  // 2. approve(exact) + buy.
  const buy = await r.submit("2", "agent exec approve + buy", async () => [
    "agent",
    "exec",
    "--agent",
    "trader",
    "--calls",
    callsJson([approve(usd(10)), await r.trade("buy", usd(10))]),
  ]);
  assert.equal(buy.json.result.success, true);
  await r.landed("2", "agent exec: approve(MockUSD → launchpad, 10) + buy(10 mUSD)", buy);
  await eventually(async () => {
    if (r.via === "bundler") {
      assert.equal(await r.epNonce(laneOf(keyHash)), (laneOf(keyHash) << 64n) | 1n);
    }
    assert.equal(await r.balanceOf(USD), usd(190));
    assert.equal(await r.balanceOf(MEME), HUMAN_MEME + 10n * UNIT);
    assert.equal(await r.read("inventory", MEME, keyHash), 10n * UNIT);
    assert.equal(await r.read("remainingLimit", USD, keyHash), usd(40));
    assert.equal(await r.allowance(), 0n);
    await r.zeroMnt([account, trader.address]);
  });
  record({
    step: "2",
    item: "balances: 190 mUSD, inventory 10e21, remaining 40 mUSD, allowance 0",
    outcome: "checked",
  });

  // 3. sell ≤ inventory.
  const sell = await r.submit("3", "agent exec sell", async () => [
    "agent",
    "exec",
    "--agent",
    "trader",
    "--calls",
    callsJson([await r.trade("sell", 5n * UNIT)]),
  ]);
  assert.equal(sell.json.result.success, true);
  await r.landed("3", "agent exec: sell(5e21 meme)", sell);
  await eventually(async () => {
    assert.equal(await r.balanceOf(USD), usd(195));
    assert.equal(await r.balanceOf(MEME), HUMAN_MEME + 5n * UNIT);
    assert.equal(await r.read("inventory", MEME, keyHash), 5n * UNIT);
    assert.equal(await r.read("remainingLimit", USD, keyHash), usd(40));
  });
  record({
    step: "3",
    item: "MockUSD back: 195 mUSD; inventory 5e21; remaining limit unchanged (40)",
    outcome: "checked",
  });

  // 6. status / list.
  await eventually(async () => {
    const status = (await r.s(["account", "status"], 0)).json.result;
    assert.equal(status.state, "INITIALIZED");
    assert.deepEqual(status.inventory, [
      {
        token: MEME,
        balance: String(HUMAN_MEME + 5n * UNIT),
        reserved: String(5n * UNIT),
        unallocated: String(HUMAN_MEME),
      },
    ]);
    const listed = (await r.s(["session", "list"], 0)).json.result;
    assert.deepEqual(listed.sessions, status.sessions);
    assert.equal(status.sessions.length, 1);
    const [session] = status.sessions;
    assert.equal(session.keyHash, keyHash.toLowerCase());
    assert.equal(session.profile, "trader");
    assert.equal(session.registered, true);
    assert.equal(session.isAdmin, false);
    assert.equal(session.hook, HOOK);
    assert.equal(session.hooked, true);
    assert.deepEqual(session.summary, { initialized: true, active: true, revoked: false });
    assert.deepEqual(session.remaining, [{ token: USD, amount: String(usd(40)) }]);
    assert.deepEqual(session.inventory, [{ token: MEME, amount: String(5n * UNIT) }]);
    assert.ok(session.expiry - Math.floor(Date.now() / 1000) > 86400 - 3600);
    assert.deepEqual(session.policy.quoteLimits, [
      { token: USD, totalCap: String(usd(100)), periodCap: String(usd(50)) },
    ]);
    assert.deepEqual(session.policy.trustedSpenders, [PAD]);
    assert.equal(session.policy.permissions.length, 3);
    assert.equal(session.policy.maxDeadlineWindow, 600);
  });
  record({
    step: "6",
    item: "account status / session list after step 3",
    outcome: `INITIALIZED; 1 session (trader) active, hooked, 24 h expiry, remaining 40 mUSD, inventory 5e21; account meme ${HUMAN_MEME + 5n * UNIT} = reserved 5e21 + unallocated 7e21 (the human's)`,
  });

  // A second session whose key expires soon, for the expired-key item (no clock to move here).
  const signer = loadProfileSigner("human", keystore);
  const executor: Executor =
    r.via === "relayer"
      ? new RelayerExecutor({ client, url: r.sponsorUrl, addresses: book })
      : new BundlerExecutor({
          client,
          bundlerUrl: BUNDLER_URL,
          sponsorUrl: r.sponsorUrl,
          addresses: book,
        });
  const mantle = new MantleAccount({ client, root: signer, executor, addresses: book, keystore });
  // Long enough for the grant to land (with the bundler's retries), short enough to pass during step 4.
  const expiry = Number(await now()) + 600;
  const brief = await grantWithRetry(r, mantle, expiry);
  await recordTx(
    "4",
    `grant "brief" (expiry ${new Date(expiry * 1000).toISOString()})`,
    brief.hash,
    "success",
  );
  const briefSigner = loadProfileSigner("brief", keystore);
  if ((await now()) + 30n < BigInt(expiry)) {
    await r.s(["agent", "simulate", "--agent", "brief", "--calls", callsJson([approve(1n)])], 0);
    record({ step: "4", item: "brief: agent simulate before its expiry", outcome: "passes" });
  }

  // 4. every overreach.
  const transfer: Call = {
    to: USD,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [funder.address, 1n],
    }),
  };
  let error = await r.refusedEverywhere(
    "target outside the allowlist (MockUSD.transfer)",
    agent,
    [transfer],
    {
      cli: 10,
      sponsor: "SIMULATION_FAILED",
      chain: "CallNotPermitted",
    },
  );
  assert.equal(error.code, "POLICY_VIOLATION");
  error = await r.refusedEverywhere(
    "approve over the remaining limit (41 > 40 mUSD)",
    agent,
    [approve(usd(41))],
    {
      cli: 11,
      sponsor: "SIMULATION_FAILED",
      chain: "LimitExceeded",
    },
  );
  assert.equal(error.code, "LIMIT_EXCEEDED");
  assert.equal(error.remaining, String(usd(40)));

  // The allowance belongs to the account: the root may approve more than the session's limit.
  const rootApprove = await r.submit("4", "root approves 100 mUSD", () => [
    "account",
    "exec",
    "--calls",
    callsJson([approve(usd(100))]),
  ]);
  await r.landed("4", "root: approve(launchpad, 100 mUSD) for the over-limit buy", rootApprove);
  error = await r.refusedEverywhere(
    "buy over the remaining limit (41 mUSD), spending the root's allowance",
    agent,
    [await r.trade("buy", usd(41))],
    { cli: 11, sponsor: "SIMULATION_FAILED", chain: "LimitExceeded" },
  );
  assert.equal(error.code, "LIMIT_EXCEEDED");
  const reset = await r.submit("4", "root resets the allowance", () => [
    "account",
    "exec",
    "--calls",
    callsJson([approve(0n)]),
  ]);
  await r.landed("4", "root: approve(launchpad, 0)", reset);
  assert.equal(await r.allowance(), 0n);

  assert.ok((await r.balanceOf(MEME)) > 5n * UNIT + 1n);
  error = await r.refusedEverywhere(
    "sell more than the session's inventory (5e21 + 1), the human's meme covering the balance",
    agent,
    [await r.trade("sell", 5n * UNIT + 1n)],
    { cli: 12, sponsor: "SIMULATION_FAILED", chain: "InventoryExceeded" },
  );
  assert.equal(error.code, "INVENTORY_EXCEEDED");
  assert.equal(error.held, String(5n * UNIT));

  const [current] = await client.readContract({
    address: HOOK,
    abi: agentPolicyHookAbi,
    functionName: "getPolicy",
    args: [keyHash, account],
  });
  const raise: Call = {
    to: HOOK,
    value: 0n,
    data: encodeFunctionData({
      abi: agentPolicyHookAbi,
      functionName: "updatePolicy",
      args: [
        keyHash,
        {
          ...current,
          quoteLimits: current.quoteLimits.map((q) => ({ ...q, periodCap: q.totalCap * 10n })),
        },
      ],
    }),
  };
  await r.refusedEverywhere("to == hook (updatePolicy raising its own caps)", agent, [raise], {
    cli: 10,
    sponsor: "SIMULATION_FAILED",
    chain: "TargetIsHook",
  });
  await r.refusedEverywhere(
    "deadline out of range (now + 3600 s > 600 s window)",
    agent,
    [await r.trade("buy", 1n, { deadline: (await now()) + 3600n })],
    { cli: 10, sponsor: "SIMULATION_FAILED", chain: "DeadlineOutOfRange" },
  );
  await r.refusedEverywhere(
    "recipient ≠ self (sell proceeds to the funder)",
    agent,
    [await r.trade("sell", 1n, { recipient: funder.address })],
    { cli: 10, sponsor: "SIMULATION_FAILED", chain: "RecipientNotAccount" },
  );

  // ERC-1271: a valid ERC-7739 nested personal-sign signature by the session key. `isValidSignature`
  // is a view: no CLI or sponsor path signs one, and the chain answers it as an eth_call.
  const message = "permit me";
  const signature = await trader.signTypedData({
    domain: await getCaliburDomain(client, {
      account,
      implementation: book.caliburEntry,
      chainId: book.chainId,
    }),
    types: { PersonalSign: [{ name: "prefixed", type: "bytes" }] },
    primaryType: "PersonalSign",
    message: { prefixed: toPrefixedMessage(message) },
  });
  const sigReason = await client
    .call({
      to: account,
      data: encodeFunctionData({
        abi: parseAbi(["function isValidSignature(bytes32, bytes) view returns (bytes4)"]),
        args: [
          hashMessage(message),
          encodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
            [keyHash, signature, "0x"],
          ),
        ],
      }),
    })
    .then(
      () => "no revert",
      (e: unknown) => revertName(revertData(e)),
    );
  assert.equal(sigReason, "SessionKeySignatureRejected");
  record({
    step: "4",
    item: "ERC-1271 signature by the session key (isValidSignature, eth_call at latest)",
    outcome: `refused on chain: ${sigReason}`,
  });

  if (r.via === "bundler") await wrongPaymaster(r, agent);
  else {
    record({
      step: "4",
      item: "wrong paymaster",
      outcome: "n/a on the relayer path (no paymaster); see the bundler path",
    });
  }

  assert.equal(await r.read("remainingLimit", USD, keyHash), usd(40));
  assert.equal(await r.read("inventory", MEME, keyHash), 5n * UNIT);
  assert.equal(await r.balanceOf(USD), usd(195));
  assert.equal(await r.balanceOf(MEME), HUMAN_MEME + 5n * UNIT);
  assert.equal(await r.allowance(), 0n);
  record({
    step: "4",
    item: "limits, inventory, balances, allowance untouched",
    outcome: "checked",
  });

  // 5. revoke.
  const preSigned =
    r.via === "relayer"
      ? await r.signDirect(trader, keyHash, [approve(1n)])
      : await r.userOp(trader, keyHash, [approve(1n)]);
  const sendPreSigned = (item: string) =>
    typeof preSigned === "string"
      ? r.execute("5", item, preSigned)
      : r.handleOps("5", item, preSigned);
  const revoke = await r.submit("5", "session revoke", () => [
    "session",
    "revoke",
    "--agent",
    "trader",
  ]);
  assert.equal(revoke.json.result.profile, "trader");
  await r.landed("5", "session revoke --agent trader", revoke);
  assert.equal(await r.allowance(), 0n);
  const gone = r.via === "relayer" ? "KeyDoesNotExist" : "AA24 signature error";
  assert.equal(await sendPreSigned("old signature (signed before the revoke)"), gone);
  assert.equal(
    await r.onChain("5", "new signature (signed after the revoke)", trader, keyHash, [approve(1n)]),
    gone,
  );
  assert.equal(
    (await r.cliRefuses("5", "agent exec after revoke", "trader", keyHash, [approve(1n)], 13)).code,
    "KEY_EXPIRED_OR_REVOKED",
  );
  await r.sponsorRefuses(
    "5",
    "request after revoke",
    trader,
    keyHash,
    [approve(1n)],
    "KEY_NOT_REGISTERED",
  );

  // Re-granting the same key.
  const settings = BigInt(HOOK) | (BigInt(Math.floor(Date.now() / 1000) + 86400) << 160n);
  const self = (data: Hex): Call => ({ to: account, value: 0n, data });
  const register = self(
    encodeFunctionData({
      abi: caliburAbi,
      functionName: "register",
      args: [
        { keyType: 2, publicKey: encodeAbiParameters([{ type: "address" }], [trader.address]) },
      ],
    }),
  );
  const update = self(
    encodeFunctionData({ abi: caliburAbi, functionName: "update", args: [keyHash, settings] }),
  );
  const setPolicy: Call = {
    to: HOOK,
    value: 0n,
    data: encodeFunctionData({
      abi: agentPolicyHookAbi,
      functionName: "setPolicy",
      args: [keyHash, current],
    }),
  };
  const regrant = [register, update, setPolicy];
  const refusedRegrant = await r.s(["account", "exec", "--calls", callsJson(regrant)], 20);
  assert.equal(refusedRegrant.json.error.code, "SPONSOR_REJECTED");
  assert.equal(refusedRegrant.json.error.reason, "SIMULATION_FAILED");
  record({
    step: "5",
    item: "re-grant of the same key through the CLI",
    outcome: "sponsor refused: SIMULATION_FAILED (exit 20)",
  });
  const regrantReason = await client
    .call({
      account,
      to: account,
      data: encodeFunctionData({
        abi: selfExecuteAbi,
        functionName: "execute",
        args: [{ calls: regrant, revertOnFailure: true }],
      }),
    })
    .then(
      () => "no revert",
      (e: unknown) => revertName(revertData(e)),
    );
  assert.equal(regrantReason, "CallFailed(SessionRevoked)");
  // On chain: the root's own signature on the re-grant, sent by the funder.
  const human = loadProfileSigner("human", keystore);
  if (r.via === "relayer") {
    const signed = await signBatchedCall(client, {
      account,
      implementation: book.caliburEntry,
      chainId: book.chainId,
      signer: human,
      keyHash: zeroHash,
      calls: regrant,
      nonce: await readCaliburNonce(client, account, 0n),
      executor: funder.address,
      deadline: (await now()) + 600n,
    });
    assert.equal(
      await r.execute("5", "re-grant of the same key, root-signed, sent directly", signed),
      "CallFailed(SessionRevoked)",
    );
  } else {
    assert.equal(
      await r.handleOps(
        "5",
        "re-grant of the same key, root-signed UserOp, sent directly",
        await r.userOp(human, zeroHash, regrant),
      ),
      "reverted: CallFailed(SessionRevoked)",
    );
  }

  // Even with the key registered on Calibur again (without the hook policy), the tombstone holds.
  const reregister = await r.submit("5", "root re-registers the key on Calibur only", () => [
    "account",
    "exec",
    "--calls",
    callsJson([register, update]),
  ]);
  await r.landed("5", "root: Calibur-only re-registration of the revoked key", reregister);
  const inactive = r.via === "relayer" ? "SessionInactive" : "AA23 reverted: SessionInactive";
  assert.equal(await sendPreSigned("old signature, key re-registered on Calibur"), inactive);
  assert.equal(
    await r.onChain("5", "new signature, key re-registered on Calibur", trader, keyHash, [
      approve(1n),
    ]),
    inactive,
  );
  await r.sponsorRefuses(
    "5",
    "request, key re-registered on Calibur",
    trader,
    keyHash,
    [approve(1n)],
    "KEY_INACTIVE",
  );
  assert.equal(
    (
      await r.cliRefuses(
        "5",
        "agent exec, key re-registered on Calibur",
        "trader",
        keyHash,
        [approve(1n)],
        13,
      )
    ).code,
    "KEY_EXPIRED_OR_REVOKED",
  );
  assert.equal(await r.allowance(), 0n);

  // 6. status / list after the revoke.
  await eventually(async () => {
    const after = (await r.s(["account", "status"], 0)).json.result;
    assert.equal(after.state, "INITIALIZED");
    assert.deepEqual((await r.s(["session", "list"], 0)).json.result.sessions, after.sessions);
    const revoked = after.sessions.find((x: { profile?: string }) => x.profile === "trader");
    assert.equal(revoked.keyHash, keyHash.toLowerCase());
    assert.deepEqual(revoked.summary, { initialized: true, active: false, revoked: true });
    assert.deepEqual(revoked.inventory, [{ token: MEME, amount: String(5n * UNIT) }]);
    assert.deepEqual(
      after.sessions.find((x: { profile?: string }) => x.profile === "brief")?.summary,
      { initialized: true, active: true, revoked: false },
    );
    assert.deepEqual(after.inventory, [
      {
        token: MEME,
        balance: String(HUMAN_MEME + 5n * UNIT),
        reserved: String(5n * UNIT),
        unallocated: String(HUMAN_MEME),
      },
    ]);
  });
  record({
    step: "6",
    item: "account status / session list after the revoke",
    outcome:
      "trader revoked (inactive, tombstoned) with its 5e21 inventory frozen as reserved; brief active",
  });

  // 4. the expired key.
  await until(async () => (await now()) > BigInt(expiry), 600_000, "brief's expiry");
  const briefHash = brief.keyHash;
  assert.equal(
    (await r.cliRefuses("4", "expired key: agent exec", "brief", briefHash, [approve(1n)], 13))
      .code,
    "KEY_EXPIRED_OR_REVOKED",
  );
  await r.sponsorRefuses(
    "4",
    "expired key: request",
    briefSigner,
    briefHash,
    [approve(1n)],
    "KEY_EXPIRED",
  );
  assert.equal(
    await r.onChain("4", "expired key, sent directly", briefSigner, briefHash, [approve(1n)]),
    r.via === "relayer" ? "KeyExpired" : "AA22 expired or not due",
  );
  const last = (await r.s(["account", "status"], 0)).json.result;
  const expired = last.sessions.find((x: { profile?: string }) => x.profile === "brief");
  assert.deepEqual(expired.summary, { initialized: true, active: true, revoked: false });
  assert.ok(BigInt(expired.expiry) < (await now()));
  record({
    step: "6",
    item: "account status after the expiry",
    outcome: "brief: hook-active, Calibur expiry passed",
  });

  await r.zeroMnt([account, trader.address, briefSigner.address]);
  assert.equal(await r.deposit(account), 0n);
  record({
    step: "1–6",
    item: "the human (account), trader and brief held 0 MNT throughout; account EntryPoint deposit 0",
    outcome: "checked",
  });
}

/** Grants "brief" through the SDK (the CLI has no expiry option), retried like `Run.submit`. */
async function grantWithRetry(r: Run, mantle: MantleAccount, expiry: number) {
  for (let attempt = 1; ; attempt++) {
    const fromBlock = await client.getBlockNumber();
    try {
      return await mantle.grantSession(parsePolicy(r.policy), { agentName: "brief", expiry });
    } catch (error) {
      const message = scrub(String((error as Error)?.message));
      if (
        r.via !== "bundler" ||
        attempt >= 4 ||
        !/too long|not included|unstaked|busy|Bundler error/i.test(message)
      ) {
        throw error;
      }
      record({
        step: "4",
        item: `grant "brief" (attempt ${attempt})`,
        outcome: `INCIDENT: ${message.slice(0, 300)}`,
      });
      if (/unstaked|-32505|not included/i.test(message)) {
        sepoliaSh("down");
        sepoliaSh("up");
      }
      await sleep(75_000);
      const landed = await opsSince(r.account, fromBlock);
      if (landed.length)
        throw new Error(`grant brief: an op landed after a failed attempt; not retrying`);
    }
  }
}

/** I10, bundler path only: a session UserOp without our paymaster fails validation in the hook. */
async function wrongPaymaster(r: Run, agent: { signer: Signer; key: Hex }) {
  const before = await r.state(agent.key);
  const nonce = await r.epNonce(laneOf(agent.key));
  const op = await r.userOp(agent.signer, agent.key, [approve(1n)], { paymaster: "none" });
  const data = encodeFunctionData({
    abi: entryPoint08Abi,
    functionName: "handleOps",
    args: [[toPackedUserOperation(op)], funder.address],
  });
  // With 1 MNT the account could pay its own prefund: the hook, not an empty balance, refuses.
  const funded = await client
    .call({
      account: funder.address,
      to: EP,
      data,
      stateOverride: [{ address: r.account, balance: parseEther("1") }],
    })
    .then(
      () => "no revert",
      (e: unknown) => failedOp(revertData(e)),
    );
  assert.equal(funded, "AA23 reverted: WrongPaymaster");
  record({
    step: "4",
    item: "wrong paymaster: none, the account funded by a state override (eth_call)",
    outcome: `refused: ${funded}`,
  });
  assert.equal(
    await r.handleOps(
      "4",
      "wrong paymaster: a session UserOp with no paymaster, sent directly",
      op,
    ),
    "AA23 reverted: WrongPaymaster",
  );
  // The strict bundler refuses it in validation too.
  const selector = toFunctionSelector("WrongPaymaster()");
  for (let attempt = 1; ; attempt++) {
    const refusal = await bundlerRpc("eth_sendUserOperation", [
      formatUserOperationRequest(op),
      EP,
    ]).then(
      () => "accepted",
      (e: unknown) => String((e as Error).message),
    );
    if (/too long/i.test(refusal) && attempt < 3) continue;
    assert.ok(refusal.includes(selector) || refusal.includes("WrongPaymaster"), refusal);
    record({
      step: "4",
      item: "wrong paymaster: the same op to the strict bundler (eth_sendUserOperation)",
      outcome: `bundler refused: ${scrub(refusal).slice(0, 200)}`,
    });
    break;
  }
  assert.deepEqual(await r.state(agent.key), before);
  assert.equal(await r.epNonce(laneOf(agent.key)), nonce);
}

/** The MNT value case (relayer path): funded after init; maxValuePerCall and the MNT limit. */
async function valuePhase() {
  const r = new Run("relayer");
  await r.start(policyJson({ value: true }));
  try {
    const init = await r.submit("value", "account init --grant (payer)", () => [
      "account",
      "init",
      "--grant",
      r.policy,
      "--agent",
      "payer",
    ]);
    await r.landed(
      "value",
      "account init --grant (payer): policy with maxValuePerCall 0.005 MNT, MNT limit 0.008",
      init,
      true,
    );
    const keyHash = readProfiles(r.keystore).payer?.keyHash as Hex;
    const payer = loadProfileSigner("payer", r.keystore);
    await r.zeroMnt([r.account, payer.address]);
    record({
      step: "value",
      item: "after init: the account and the agent hold 0 MNT",
      outcome: "checked",
    });

    // Funded explicitly, after init.
    const fund = await funderWallet.sendTransaction({ to: r.account, value: VALUE.principal });
    await recordTx("value", "funder sends the principal to the account", fund, "success", {
      principal: VALUE.principal,
    });
    assert.equal(await client.getBalance({ address: r.account }), VALUE.principal);

    const pay = (value: bigint): Call => ({ to: funder.address, value, data: "0x" });
    const paid = await r.submit("value", "agent exec: pay 0.005 MNT", () => [
      "agent",
      "exec",
      "--agent",
      "payer",
      "--calls",
      callsJson([pay(VALUE.paid)]),
    ]);
    assert.equal(paid.json.result.success, true);
    await recordTx(
      "value",
      "agent exec: pay 0.005 MNT to the funder (= maxValuePerCall)",
      paid.json.result.hash,
      "success",
      {
        principal: VALUE.paid,
      },
    );
    await eventually(async () => {
      assert.equal(await client.getBalance({ address: r.account }), VALUE.principal - VALUE.paid);
      assert.equal(await r.read("remainingLimit", zeroAddress, keyHash), VALUE.mntCap - VALUE.paid);
    });
    record({
      step: "value",
      item: "MNT limit remaining 0.003 MNT; account 0.015 MNT",
      outcome: "checked",
    });

    const step = "value";
    const over = async (item: string, value: bigint, chain: string) => {
      const error = await r.cliRefuses(step, item, "payer", keyHash, [pay(value)], 11);
      assert.equal(error.code, "LIMIT_EXCEEDED");
      await r.sponsorRefuses(step, item, payer, keyHash, [pay(value)], "SIMULATION_FAILED");
      const before = await r.state(keyHash);
      assert.equal(await r.onChain(step, item, payer, keyHash, [pay(value)]), chain);
      assert.deepEqual(await r.state(keyHash), before);
    };
    await over(
      "value above maxValuePerCall (0.006 > 0.005 MNT)",
      parseEther("0.006"),
      "ValueExceeded",
    );
    await over(
      "value above the remaining MNT limit (0.004 > 0.003 MNT)",
      parseEther("0.004"),
      "LimitExceeded",
    );

    // The rest of the principal goes back to the funder, from the root (no hook), gaslessly.
    const left = await client.getBalance({ address: r.account });
    const back = await r.submit("value", "root returns the principal", () => [
      "account",
      "exec",
      "--calls",
      callsJson([pay(left)]),
    ]);
    await r.landed(
      "value",
      `root: return the remaining principal (${formatEther(left)} MNT) to the funder`,
      back,
    );
    assert.equal(await client.getBalance({ address: r.account }), 0n);
    await r.zeroMnt([payer.address]);
    record({
      step: "value",
      item: "principal: in 0.02 MNT; out 0.005 (session) + 0.015 (root); account 0 MNT; gas paid by the sponsor's relayer and, for the direct submissions, the funder",
      outcome: "checked",
    });
  } finally {
    await r.stopSponsor?.();
  }
}

/** Panic with the sponsor stopped: the root is funded, `--self-pay --undelegate`, frozen inventory. */
async function panicPhase() {
  const r = new Run("relayer");
  await r.start(policyJson());
  let sponsorUp = true;
  try {
    const init = await r.submit("panic", "account init --grant (agent)", () => [
      "account",
      "init",
      "--grant",
      r.policy,
      "--agent",
      "agent",
    ]);
    await r.landed("panic", "account init --grant (agent)", init, true);
    const keyHash = readProfiles(r.keystore).agent?.keyHash as Hex;
    await funderFixture();
    await funderTx("panic", "funder mints 20 mUSD to the account", {
      address: USD,
      abi: mockUsdAbi,
      functionName: "mint",
      args: [r.account, usd(20)],
    } as never);
    const buy = await r.submit("panic", "agent exec approve + buy", async () => [
      "agent",
      "exec",
      "--agent",
      "agent",
      "--calls",
      callsJson([approve(usd(5)), await r.trade("buy", usd(5))]),
    ]);
    await r.landed("panic", "agent exec: approve + buy(5 mUSD): inventory to freeze", buy);
    assert.equal(await r.read("inventory", MEME, keyHash), 5n * UNIT);

    // The sponsor stops; a sponsored panic cannot reach it and sends nothing.
    await r.stopSponsor?.();
    sponsorUp = false;
    const refused = await r.s(["account", "panic"], 1);
    assert.match(
      refused.json.error.message,
      /^Revocation \(phase 1\) not confirmed: Sponsor unreachable/,
    );
    record({
      step: "panic",
      item: "account panic with the sponsor stopped",
      outcome: "refused, nothing sent: Sponsor unreachable",
    });
    assert.equal(await client.getBalance({ address: r.account }), 0n);
    const nonce = await client.getTransactionCount({ address: r.account });
    const unfunded = await r.s(["account", "panic", "--self-pay"], 1);
    assert.match(unfunded.json.error.message, /^Revocation \(phase 1\) not confirmed: /);
    assert.equal(await client.getTransactionCount({ address: r.account }), nonce);
    record({
      step: "panic",
      item: "account panic --self-pay with the root at 0 MNT",
      outcome: `refused, nothing sent: ${scrub(unfunded.json.error.message).slice(0, 160)}`,
    });

    // Funded, the root revokes, then undelegates.
    const fund = await funderWallet.sendTransaction({ to: r.account, value: PANIC_FUNDING });
    await recordTx("panic", "funder funds the root for gas (0.05 MNT)", fund, "success", {
      principal: PANIC_FUNDING,
    });
    const p = await r.s(["account", "panic", "--self-pay", "--undelegate"], 0);
    const { revocation, undelegation, recovery } = p.json.result;
    assert.equal(revocation.status, "confirmed");
    assert.deepEqual(
      revocation.revokedKeys.map((k: string) => k.toLowerCase()),
      [keyHash.toLowerCase()],
    );
    assert.deepEqual(revocation.resetAllowances, [{ token: USD, spender: PAD }]);
    assert.equal(undelegation.status, "confirmed");
    const phase1 = await recordTx(
      "panic",
      "phase 1: revoke every key + tombstone + allowance reset (root self-pays)",
      revocation.hash,
      "success",
    );
    const phase2 = await recordTx(
      "panic",
      "phase 2: type-4 delegation to the zero address (root self-pays)",
      undelegation.hash,
      "success",
    );
    assert.equal(phase1.from.toLowerCase(), r.account.toLowerCase());
    assert.equal(phase1.to?.toLowerCase(), r.account.toLowerCase());
    assert.equal(phase1.status, "success");
    assert.equal(phase2.status, "success");
    assert.equal(phase2.type, "eip7702");
    assert.ok(phase2.blockNumber > phase1.blockNumber);
    assert.equal(await client.getCode({ address: r.account }), undefined);
    assert.equal(await r.allowance(), 0n);
    assert.ok(recovery.length >= 2);

    await eventually(async () => {
      const status = (await r.s(["account", "status"], 0)).json.result;
      assert.equal(status.state, "UNDELEGATED");
      assert.equal(status.sessions.length, 1);
      assert.equal(status.sessions[0].registered, false);
      assert.deepEqual(status.sessions[0].summary, {
        initialized: true,
        active: false,
        revoked: true,
      });
      assert.deepEqual(status.inventory, [
        { token: MEME, balance: String(5n * UNIT), reserved: String(5n * UNIT), unallocated: "0" },
      ]);
    });
    record({
      step: "panic",
      item: "account status after panic",
      outcome:
        "UNDELEGATED; the agent's key revoked and tombstoned; its 5e21 meme frozen (reserved), awaiting the root's release",
    });

    // Leftover gas money back to the funder: the root is a plain EOA again.
    const left = await client.getBalance({ address: r.account });
    const fees = await client.estimateFeesPerGas();
    const gas = await client.estimateGas({ account: r.account, to: funder.address, value: 1n });
    // Worst case of the transfer: L2 gas at maxFeePerGas, the operator fee (10 gwei per gas,
    // docs/infra.md §5) and a margin for the L1 fee (measured ≈1e8 wei).
    const keep = gas * (fees.maxFeePerGas + 10_000_000_000n) + 10n ** 12n;
    if (left > keep) {
      const root = createWalletClient({
        account: privateKeyToAccount(
          loadKey(readProfiles(r.keystore).human?.keyfile as string, r.keystore),
        ),
        chain: mantleSepolia,
        transport: http(RPC, { timeout: 30_000, retryCount: 5 }),
      });
      const hash = await root.sendTransaction({
        to: funder.address,
        value: left - keep,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      await recordTx("panic", "root returns the unused gas money to the funder", hash, "success", {
        principal: left - keep,
      });
    }
    record({
      step: "panic",
      item: "left on the undelegated root",
      outcome: `${formatEther(await client.getBalance({ address: r.account }))} MNT`,
    });
  } finally {
    if (sponsorUp) await r.stopSponsor?.();
  }
}

// ---- main -------------------------------------------------------------------------------------

const PHASES: Record<string, () => Promise<void>> = {
  relayer: () => pathPhase("relayer"),
  bundler: () => pathPhase("bundler"),
  value: valuePhase,
  panic: panicPhase,
};

async function main() {
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PHASES);
  for (const name of selected) assert.ok(PHASES[name], `unknown phase ${name}`);
  assert.equal(await client.getChainId(), 5003);
  const signerOnChain = await client.readContract({
    address: PAYMASTER,
    abi: paymasterAbi,
    functionName: "verifyingSigner",
  });
  assert.equal(
    signerOnChain,
    paymasterSigner.address,
    "PAYMASTER_SIGNER_PRIVATE_KEY is not the paymaster's signer",
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    }).trim();
  const commit = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--", "e2e", "packages", "deployments") !== "";
  const summaryFile = join(RUN_DIR, "summary.json");
  const summary = existsSync(summaryFile)
    ? JSON.parse(readFileSync(summaryFile, "utf8"))
    : { phases: {} };
  summary.deployments = {
    CaliburEntry: book.caliburEntry,
    AgentPolicyHook: HOOK,
    VerifyingPaymaster: PAYMASTER,
    EntryPoint: EP,
    MockUSD: USD,
    MockLaunchpad: PAD,
    MemeToken: MEME,
  };
  summary.wallets = {
    relayer: relayer.address,
    funder: funder.address,
    paymasterSigner: paymasterSigner.address,
  };
  summary.caps = CAPS;

  for (const name of selected) {
    phase = name;
    rows.length = 0;
    const before = await balances();
    log(`commit ${commit}${dirty ? " (dirty)" : ""}; balances ${JSON.stringify(mnt(before))}`);
    for (const [wallet, floor] of Object.entries(FLOOR[name] ?? {})) {
      const held = before[wallet as keyof Balances];
      if (held !== undefined && held < parseEther(floor)) {
        throw new Error(
          `budget: ${wallet} holds ${formatEther(held)} MNT < ${floor} MNT needed for ${name}; stopping`,
        );
      }
    }
    const started = new Date().toISOString();
    let failure: string | undefined;
    try {
      await PHASES[name]?.();
    } catch (error) {
      failure = scrub(
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      );
      record({ step: "—", item: "phase failed", outcome: `FAILED: ${failure.split("\n")[0]}` });
    }
    const after = await balances();
    const spent = Object.fromEntries(
      Object.entries(before).map(([k, v]) => [
        k,
        formatEther((v as bigint) - (after[k as keyof Balances] ?? 0n)),
      ]),
    );
    summary.phases[name] = {
      ok: !failure,
      commit,
      dirty,
      started,
      finished: new Date().toISOString(),
      before: mnt(before),
      after: mnt(after),
      spent,
      transactions: rows.filter((x) => x.hash).length,
      ...(failure && { failure }),
    };
    writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(RUN_DIR, `${name}.md`), markdown(rows));
    log(`${failure ? "FAILED" : "done"}; spent ${JSON.stringify(spent)}`);
    if (failure) {
      console.error(failure);
      process.exitCode = 1;
      return;
    }
  }
}

/** A failure outside a phase (start-up, balances, an unhandled rejection), printed scrubbed. */
function fatal(error: unknown) {
  console.error(scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exit(1);
}
process.on("uncaughtException", fatal);
await main().catch(fatal);
// The in-process sponsor's HTTP agents and timers must not keep the run alive.
process.exit(process.exitCode ?? 0);
