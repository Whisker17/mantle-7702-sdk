// docs/DESIGN.md §8 steps 1–6 through the bundler path (`--via bundler`), on an anvil fork of Mantle
// Sepolia with the pinned strict-mode Alto (harness.ts): once against a long-running sponsor
// (`sponsor serve`) and once in embedded mode (no service). The deployed VerifyingPaymaster's signer
// is swapped on the fork for a key the sponsor (and the test) holds, so the sponsored UserOps run
// through the deployed paymaster code.
//
// Every overreach is refused three times: by the CLI (the SDK's local pre-check, nothing sent), by
// the sponsor's paymaster service (a request built without the pre-check), and on chain, where the
// session UserOp is signed with the session key, carries paymaster data the paymaster accepts, and is
// handed to `EntryPoint.handleOps` by a funded third-party EOA, bypassing the CLI, the SDK, the
// sponsor and the bundler. Plus the bundler-only I10 case (a session UserOp without our paymaster),
// cross-path replay (Calibur's SignedBatchedCall nonce vs the EntryPoint nonce) and cross-lane nonce
// consumption (§4.1, §9). Skipped when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentPolicyHookAbi,
  BundlerExecutor,
  type Call,
  caliburAbi,
  decodeExecute,
  encodeUserOpCallData,
  getCaliburDomain,
  laneOf,
  launchpadAbi,
  loadDeployments,
  loadProfileSigner,
  mantleSepolia,
  type PrivateKeySigner,
  RelayerExecutor,
  readCaliburNonce,
  readProfiles,
  type Signer,
  SponsorRejectedError,
  signBatchedCall,
} from "@mantle-aa/sdk";
import { startEmbeddedSponsor } from "@mantle-aa/sponsor";
import {
  type Address,
  BaseError,
  concat,
  createWalletClient,
  decodeAbiParameters,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  hashMessage,
  http,
  isHex,
  parseAbi,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
  toPrefixedMessage,
  zeroHash,
} from "viem";
import {
  entryPoint08Abi,
  formatUserOperationRequest,
  getUserOperationTypedData,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import {
  generatePrivateKey,
  mnemonicToAccount,
  privateKeyToAccount,
  privateKeyToAddress,
} from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../packages/cli/src/index.js";
import {
  type CliResult,
  cli,
  PASSWORD,
  tempHome,
  testEnv,
} from "../../packages/cli/test/helpers.js";
import { type BundlerStack, setPaymasterSigner, startBundlerStack } from "./harness.js";
import { bundlerRpc, sendSponsoredUserOp } from "./userop.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const HOOK = book.agentPolicyHook;
const EP = book.entryPoint;
const PAYMASTER = book.verifyingPaymaster;
const usd = (n: number) => BigInt(n) * 10n ** 6n;
const UNIT = 10n ** 21n; // MockLaunchpad: 1 mUSD buys 1e21 meme units
/**
 * Per test: above the CLI's own 120 s bound on one bundler submission, so a UserOp that is never
 * included fails with the CLI's error (and Alto's log) rather than a test timeout.
 */
const STEP_MS = 300_000;
/** Meme the human holds before any session exists (bought for them by a third party). */
const HUMAN_MEME = 7n * UNIT;

/** Pays for the direct on-chain submissions (anvil's funded account 2); never the human or an agent. */
const ATTACKER = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 2,
});
const mockUsdAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const paymasterAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function getHash(PackedUserOperation userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
]);

/** §8 policy: approve / buy / sell on the mocks, MockUSD caps, the launchpad as the only spender. */
const policyJson = {
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
  ],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
};

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

/** The revert data of a failed `eth_call` (the deepest cause carries it, as viem's own helper). */
function revertData(error: unknown): Hex {
  const cause = error instanceof BaseError ? (error.walk() as { data?: unknown }) : undefined;
  const raw = cause?.data;
  const data = typeof raw === "object" ? (raw as { data?: unknown } | null)?.data : raw;
  if (!isHex(data)) throw error;
  return data;
}

/** Alto's last 150 log entries, each cut to 300 characters, without its head polling. */
const altoLog = (log: string) =>
  log
    .split(/\n(?=\[\d\d:\d\d:\d\d\.\d{3}\])/)
    .filter((entry) => !/"eth_(getBlockByNumber|blockNumber)"/.test(entry))
    .slice(-150)
    .map((entry) => entry.slice(0, 300))
    .join("\n");

/** Polls `check` every 200 ms until it holds; fails after `ms`. */
async function until(check: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(200);
  }
}

type Mode = "service" | "embedded";

function bundlerRun(mode: Mode) {
  const signerKey = generatePrivateKey();
  const paymasterSigner = privateKeyToAccount(signerKey);
  /** Never funded: on the bundler path the sponsor's relayer sends nothing. */
  const relayerKey = generatePrivateKey();
  const checkRelayerKey = generatePrivateKey();
  const home = tempHome("mantle-aa-e2e-bundler-");
  const env = testEnv(
    home,
    mode === "embedded"
      ? {
          MANTLE_AA_EMBEDDED_RELAYER: "1",
          MANTLE_AA_RELAYER_KEY: relayerKey,
          MANTLE_AA_PAYMASTER_SIGNER_KEY: signerKey,
        }
      : {},
  );
  const keystore = { home: env.MANTLE_AA_HOME as string, password: PASSWORD };
  const policy = join(home, "policy.json");
  const config = join(home, "sponsor.yaml");
  const abort = new AbortController();
  let serving: Promise<number> | undefined;
  let checker: Awaited<ReturnType<typeof startEmbeddedSponsor>> | undefined;

  let stack: BundlerStack;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let client: BundlerStack["client"];
  let account: Address;
  /** The sponsor's paymaster service, reached without the SDK's pre-check. */
  let sponsor: BundlerExecutor;
  /** The same sponsor's relay endpoint (cross-lane requests only). */
  let relaySponsor: RelayerExecutor;
  let trader: PrivateKeySigner;
  let keyHash: Hex;
  let other: PrivateKeySigner;
  let otherHash: Hex;

  const attacker = () =>
    createWalletClient({ account: ATTACKER, chain: mantleSepolia, transport: http(stack.rpcUrl) });
  const now = async () => (await client.getBlock()).timestamp;
  const bundleTxs = () => client.getTransactionCount({ address: stack.bundler.executor });
  const epNonce = (key: bigint) =>
    client.readContract({
      address: EP,
      abi: entryPoint08Abi,
      functionName: "getNonce",
      args: [account, key],
    });
  const deposit = (who: Address) =>
    client.readContract({
      address: EP,
      abi: entryPoint08Abi,
      functionName: "balanceOf",
      args: [who],
    });
  const read = (functionName: "inventory" | "remainingLimit", token: Address, key = keyHash) =>
    client.readContract({
      address: HOOK,
      abi: agentPolicyHookAbi,
      functionName: functionName as "inventory",
      args: [key, account, token],
    });
  const balanceOf = (token: Address) =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  const allowance = () =>
    client.readContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "allowance",
      args: [account, PAD],
    });
  /** What an overreach must leave untouched: balances, allowance, limits, inventory, 0 MNT. */
  const state = async () => ({
    usd: await balanceOf(USD),
    meme: await balanceOf(MEME),
    allowance: await allowance(),
    remaining: await read("remainingLimit", USD),
    inventory: await read("inventory", MEME),
    mnt: await client.getBalance({ address: account }),
    deposit: await deposit(account),
  });

  // ---- calls ----
  const callsJson = (calls: Call[]) =>
    JSON.stringify(calls.map((c) => ({ to: c.to, value: String(c.value), data: c.data })));
  const approve = (amount: bigint): Call => ({
    to: USD,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAD, amount] }),
  });
  const trade = async (
    fn: "buy" | "sell",
    amount: bigint,
    opts: { deadline?: bigint; recipient?: Address } = {},
  ): Promise<Call> => ({
    to: PAD,
    value: 0n,
    data: encodeFunctionData({
      abi: launchpadAbi,
      functionName: fn,
      args: [MEME, amount, 0n, opts.deadline ?? (await now()) + 60n, opts.recipient ?? account],
    }),
  });

  // ---- the CLI ----

  /** Runs a CLI step (submitting through the bundler), checks its exit code and that it leaks nothing. */
  async function s(args: string[], code: number): Promise<CliResult> {
    const result = await cli(args[0] === "keys" ? args : [...args, "--via", "bundler"], env);
    const output = result.stdout + result.stderr;
    expect(output).not.toMatch(/127\.0\.0\.1/);
    for (const secret of [PASSWORD, signerKey, relayerKey, checkRelayerKey]) {
      expect(output).not.toContain(secret.replace(/^0x/, ""));
    }
    // On a mismatch, Alto's recent log (without its block polling) shows what it did with the op.
    const alto = () =>
      result.code === code ? "" : `\n--- alto ---\n${altoLog(stack.bundler.logs())}`;
    expect(result.code, `${args.join(" ")}: ${result.stdout}${alto()}`).toBe(code);
    expect(result.json.ok).toBe(code === 0);
    return result;
  }

  /**
   * The bundle a successful CLI step names: sent by Alto's executor to the EntryPoint, carrying one
   * UserOp of the account that succeeded, sponsored by the deployed VerifyingPaymaster.
   */
  async function landed(r: CliResult, type?: "eip7702") {
    const hash = r.json.result.hash as Hex;
    const tx = await client.getTransaction({ hash });
    expect(tx.from.toLowerCase()).toBe(stack.bundler.executor.toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(EP.toLowerCase());
    if (type) expect(tx.type).toBe(type);
    else expect(tx.type).not.toBe("eip7702");
    const receipt = await client.getTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    const events = parseEventLogs({
      abi: entryPoint08Abi,
      eventName: "UserOperationEvent",
      logs: receipt.logs,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.args).toMatchObject({ sender: account, paymaster: PAYMASTER, success: true });
  }

  /** `agent exec` refuses with `code`; nothing reaches the bundler or the chain. */
  async function cliRefuses(agent: string, key: Hex, calls: Call[], code: number) {
    const [txs, nonce] = [await bundleTxs(), await epNonce(laneOf(key))];
    const r = await s(["agent", "exec", "--agent", agent, "--calls", callsJson(calls)], code);
    expect(await bundleTxs()).toBe(txs);
    expect(await epNonce(laneOf(key))).toBe(nonce);
    return r.json.error;
  }

  /** The sponsor, given the signed paymaster request without any pre-check, refuses it with `reason`. */
  async function sponsorRefuses(
    signer: Signer,
    key: Hex,
    calls: Call[],
    reason: string,
    via: "bundler" | "relayer" = "bundler",
    lane = laneOf(key),
  ) {
    const txs = await bundleTxs();
    const error = await (via === "bundler" ? sponsor : relaySponsor)
      .submit({
        account,
        keyHash: key,
        calls,
        lane,
        signer,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SponsorRejectedError);
    expect((error as SponsorRejectedError).reason, (error as Error).message).toBe(reason);
    expect(await bundleTxs()).toBe(txs);
  }

  // ---- straight to the chain ----

  /**
   * A UserOp of the account signed by `signer` (the root when `key` is 0, else wrapped as Calibur's
   * `abi.encode(keyHash, signature, "")`), with fixed gas limits, on `key`'s lane unless `nonceKey`
   * says otherwise. `paymaster` defaults to the deployed one; its data is signed with the swapped
   * paymaster signer, valid until `validUntil` (default: an hour of chain time from now).
   * `signature` replaces the account signature.
   */
  async function userOp(
    signer: Signer,
    key: Hex,
    calls: Call[],
    opts: {
      nonceKey?: bigint;
      paymaster?: Address | "none";
      validUntil?: number;
      signature?: Hex;
    } = {},
  ) {
    const fees = (await bundlerRpc(stack.bundler.url, "pimlico_getUserOperationGasPrice", [])) as {
      standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    };
    let op: UserOperation<"0.8"> = {
      sender: account,
      nonce: await epNonce(opts.nonceKey ?? laneOf(key)),
      callData: encodeUserOpCallData(calls),
      callGasLimit: 1_000_000n,
      verificationGasLimit: 500_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas: BigInt(fees.standard.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(fees.standard.maxPriorityFeePerGas),
      signature: "0x",
    };
    const paymaster = opts.paymaster ?? PAYMASTER;
    if (paymaster !== "none") {
      op = {
        ...op,
        paymaster,
        paymasterVerificationGasLimit: 100_000n,
        paymasterPostOpGasLimit: 0n,
        paymasterData: "0x",
      };
      const validUntil = opts.validUntil ?? Number(await now()) + 3600;
      const hash = await client.readContract({
        address: paymaster,
        abi: paymasterAbi,
        functionName: "getHash",
        args: [toPackedUserOperation(op), validUntil, 0],
      });
      op.paymasterData = concat([
        encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, 0]),
        await paymasterSigner.signMessage({ message: { raw: hash } }),
      ]);
    }
    const signature =
      opts.signature ??
      (await signer.signTypedData(
        getUserOperationTypedData({
          chainId: book.chainId,
          entryPointAddress: EP,
          userOperation: op,
        }),
      ));
    op.signature =
      BigInt(key) === 0n
        ? signature
        : encodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
            [key, signature, "0x"],
          );
    return { op, signature };
  }

  /**
   * Sends `handleOps([op], attacker)` from the attacker's EOA (fixed gas, so a reverting call is
   * mined) and returns the outcome: a validation failure as `AAxx reason[: InnerRevert]` (the whole
   * transaction reverts), else `success` or `reverted: Name` from the op's UserOperationEvent and
   * UserOperationRevertReason; an included op must have been paid by the deployed paymaster.
   */
  async function handleOps(op: UserOperation<"0.8">): Promise<string> {
    const data = encodeFunctionData({
      abi: entryPoint08Abi,
      functionName: "handleOps",
      args: [[toPackedUserOperation(op)], ATTACKER.address],
    });
    const failed = await client.call({ account: ATTACKER.address, to: EP, data }).then(
      () => undefined,
      (e: unknown) => failedOp(revertData(e)),
    );
    const hash = await attacker().sendTransaction({ to: EP, data, gas: 5_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (failed) {
      expect(receipt.status).toBe("reverted");
      return failed;
    }
    expect(receipt.status).toBe("success");
    const [event] = parseEventLogs({
      abi: entryPoint08Abi,
      eventName: "UserOperationEvent",
      logs: receipt.logs,
    });
    expect(event?.args).toMatchObject({ sender: account, paymaster: op.paymaster });
    if (event?.args.success) return "success";
    const [why] = parseEventLogs({
      abi: entryPoint08Abi,
      eventName: "UserOperationRevertReason",
      logs: receipt.logs,
    });
    return why ? `reverted: ${revertName(why.args.revertReason)}` : "reverted";
  }

  /** Signs a SignedBatchedCall with `signer`, executor = the attacker's EOA (the relayer path). */
  async function signDirect(signer: Signer, key: Hex, calls: Call[], lane = laneOf(key)) {
    return signBatchedCall(client, {
      account,
      implementation: book.caliburEntry,
      chainId: book.chainId,
      signer,
      keyHash: key,
      calls,
      nonce: await readCaliburNonce(client, account, lane),
      executor: ATTACKER.address,
      deadline: (await now()) + 600n,
    });
  }

  /** Sends `execute(SignedBatchedCall, sig)` from the attacker to the account; `success` or the revert. */
  async function execute(data: Hex): Promise<string> {
    const reason = await client.call({ account: ATTACKER.address, to: account, data }).then(
      () => "success",
      (e: unknown) => revertName(revertData(e)),
    );
    const hash = await attacker().sendTransaction({ to: account, data, gas: 3_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    expect(receipt.status).toBe(reason === "success" ? "success" : "reverted");
    return reason;
  }

  /** The overreach is refused by the CLI, the sponsor and, through handleOps, the hook / Calibur. */
  async function refusedEverywhere(
    calls: Call[],
    expected: { cli: number; sponsor: string; chain: string },
  ) {
    const error = await cliRefuses("trader", keyHash, calls, expected.cli);
    await sponsorRefuses(trader, keyHash, calls, expected.sponsor);
    const before = await state();
    expect(await handleOps((await userOp(trader, keyHash, calls)).op)).toBe(expected.chain);
    expect(await state()).toEqual(before);
    return error;
  }

  const zeroMnt = async (who: Address[]) => {
    for (const address of who) expect(await client.getBalance({ address }), address).toBe(0n);
  };

  beforeAll(async () => {
    stack = await startBundlerStack(rpcUrl as string);
    client = stack.client;
    // An empty block every second besides the automined ones, as a live chain keeps producing.
    // Alto frees its one executor wallet only when a new block shows its bundle included; on a quiet
    // fork a bundle it has not yet seen included keeps the wallet, and the next
    // eth_sendUserOperation then waits for it without bound (its validation needs the wallet).
    heartbeat = setInterval(() => void client.mine({ blocks: 1 }).catch(() => undefined), 1_000);
    await setPaymasterSigner(client, PAYMASTER, paymasterSigner.address);
    // Warm the fresh fork and Alto with a throwaway root init UserOp, as the smoke test lands one.
    // The first UserOp on a fork fetches its state from the upstream RPC: on a slow runner that
    // took up to 41 s of the SDK's 60 s sponsorship window, and Alto drops an op whose window has
    // passed at its pre-bundle re-check (AA32), leaving the client to wait for a receipt.
    const warm = privateKeyToAccount(generatePrivateKey());
    const warmed = await sendSponsoredUserOp({
      client,
      bundlerUrl: stack.bundler.url,
      chainId: book.chainId,
      root: warm,
      authorization: await warm.signAuthorization({
        address: book.caliburEntry,
        chainId: book.chainId,
        nonce: 0,
      }),
      calls: [approve(0n)],
      paymaster: PAYMASTER,
      paymasterSigner,
      sendAttempts: 3,
      logs: () => altoLog(stack.bundler.logs()),
    });
    expect(warmed.success).toBe(true);
    env.MANTLE_AA_RPC_URL = stack.rpcUrl;
    env.MANTLE_AA_BUNDLER_URL = stack.bundler.url;
    writeFileSync(policy, JSON.stringify(policyJson));
    await s(["keys", "new", "--name", "human"], 0);
    account = readProfiles(keystore).human?.account as Address;

    let sponsorUrl: string;
    if (mode === "service") {
      writeFileSync(
        config,
        [
          "chainId: 5003",
          `rpcUrl: ${stack.rpcUrl}`,
          "listen: { host: 127.0.0.1, port: 0 }",
          `database: ${join(home, "sponsor.sqlite")}`,
          // No relayer key: this sponsor only signs paymaster data; `relayer` names it.
          `relayer: "${privateKeyToAddress(relayerKey)}"`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
          "paymasterSignerKey: ${E2E_PAYMASTER_SIGNER_KEY}",
          "policy:",
          `  allowlist: ["${account}"]`,
          "  accountDailyGas: 50000000",
          '  maxFeePerRequestMnt: "1"',
          '  dailyBudgetMnt: "5"',
          '  managementReserveMnt: "2"',
        ].join("\n"),
      );
      let out = "";
      serving = run(["sponsor", "serve", "--config", config, "--json"], {
        env: { ...env, E2E_PAYMASTER_SIGNER_KEY: signerKey },
        stdout: (t) => {
          out += t;
        },
        stderr: () => undefined,
        signal: abort.signal,
      });
      const exited = serving.then((code) => {
        throw new Error(`sponsor serve exited with ${code}`);
      });
      await Promise.race([until(() => out.includes("\n"), 30_000, "sponsor serve"), exited]);
      sponsorUrl = JSON.parse(out).result.url;
      env.MANTLE_AA_SPONSOR_URL = sponsorUrl;
    } else {
      // The CLI starts its own embedded sponsor per command; this one only answers the requests
      // that skip the pre-check, with the same sponsor logic and the same paymaster signer.
      checker = await startEmbeddedSponsor({
        rpcUrl: stack.rpcUrl,
        allowlist: [account],
        addresses: book,
        env: {
          MANTLE_AA_EMBEDDED_RELAYER: "1",
          MANTLE_AA_RELAYER_KEY: checkRelayerKey,
          MANTLE_AA_PAYMASTER_SIGNER_KEY: signerKey,
        },
      });
      sponsorUrl = checker.url;
    }
    sponsor = new BundlerExecutor({
      client,
      bundlerUrl: stack.bundler.url,
      sponsorUrl,
      addresses: book,
    });
    relaySponsor = new RelayerExecutor({ client, url: sponsorUrl, addresses: book });

    // The human already holds meme before any session exists: a third party buys it for them.
    for (const request of [
      { address: USD, abi: mockUsdAbi, functionName: "mint", args: [ATTACKER.address, usd(7)] },
      { address: USD, abi: erc20Abi, functionName: "approve", args: [PAD, usd(7)] },
      {
        address: PAD,
        abi: launchpadAbi,
        functionName: "buy",
        args: [MEME, usd(7), 0n, (await now()) + 600n, account],
      },
    ] as const) {
      const hash = await attacker().writeContract(request as never);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      expect(receipt.status).toBe("success");
    }
    expect(await balanceOf(MEME)).toBe(HUMAN_MEME);
  }, 420_000);

  afterAll(async () => {
    clearInterval(heartbeat);
    abort.abort();
    await serving;
    await checker?.close();
    await stack?.stop();
  }, 60_000);

  it(
    "1. account init --grant: the root's init UserOp (eip7702Auth), gasless, → INITIALIZED",
    async () => {
      expect((await s(["account", "status"], 0)).json.result.state).toBe("UNDELEGATED");
      const r = await s(["account", "init", "--grant", policy, "--agent", "trader"], 0);
      expect(r.json.result).toMatchObject({
        account,
        state: "INITIALIZED",
        session: { profile: "trader" },
      });
      // A type-4 bundle; the paymaster hash covered the 2-byte 0x7702 initCode Alto packs.
      await landed(r, "eip7702");
      keyHash = readProfiles(keystore).trader?.keyHash as Hex;
      trader = loadProfileSigner("trader", keystore);
      expect((await s(["account", "status"], 0)).json.result.state).toBe("INITIALIZED");
      await zeroMnt([account, trader.address]);
      expect(await deposit(account)).toBe(0n);

      // Principal is minted, never bought with MNT.
      const hash = await attacker().writeContract({
        address: USD,
        abi: mockUsdAbi,
        functionName: "mint",
        args: [account, usd(200)],
      });
      await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    },
    STEP_MS,
  );

  it(
    "2. agent exec: approve(MockUSD → launchpad, exact) + buy, a session UserOp through the deployed paymaster",
    async () => {
      const r = await s(
        [
          "agent",
          "exec",
          "--agent",
          "trader",
          "--calls",
          callsJson([approve(usd(10)), await trade("buy", usd(10))]),
        ],
        0,
      );
      expect(r.json.result.success).toBe(true);
      await landed(r);
      // Accepted through safe-mode validation: Alto traced it with its ERC-7562 collector.
      expect(stack.bundler.logs()).toContain("tracerResult");
      expect(await epNonce(laneOf(keyHash))).toBe((laneOf(keyHash) << 64n) | 1n);
      expect(await balanceOf(USD)).toBe(usd(190));
      expect(await balanceOf(MEME)).toBe(HUMAN_MEME + 10n * UNIT);
      expect(await read("inventory", MEME)).toBe(10n * UNIT);
      expect(await read("remainingLimit", USD)).toBe(usd(40));
      expect(await allowance()).toBe(0n);
      await zeroMnt([account, trader.address]);
    },
    STEP_MS,
  );

  it(
    "3. agent exec: sell(≤ inventory) returns MockUSD to the account",
    async () => {
      const r = await s(
        [
          "agent",
          "exec",
          "--agent",
          "trader",
          "--calls",
          callsJson([await trade("sell", 5n * UNIT)]),
        ],
        0,
      );
      expect(r.json.result.success).toBe(true);
      await landed(r);
      expect(await balanceOf(USD)).toBe(usd(195));
      expect(await balanceOf(MEME)).toBe(HUMAN_MEME + 5n * UNIT);
      expect(await read("inventory", MEME)).toBe(5n * UNIT);
      // Inflows never restore the limit.
      expect(await read("remainingLimit", USD)).toBe(usd(40));
    },
    STEP_MS,
  );

  it(
    "6. account status / session list: state, keys, policy, remaining limits, inventory",
    async () => {
      const status = (await s(["account", "status"], 0)).json.result;
      expect(status).toMatchObject({ account, state: "INITIALIZED" });
      expect(status.inventory).toEqual([
        {
          token: MEME,
          balance: String(HUMAN_MEME + 5n * UNIT),
          reserved: String(5n * UNIT),
          unallocated: String(HUMAN_MEME),
        },
      ]);
      const listed = (await s(["session", "list"], 0)).json.result;
      expect(listed.sessions).toEqual(status.sessions);
      expect(status.sessions).toHaveLength(1);
      const [session] = status.sessions;
      expect(session).toMatchObject({
        keyHash: keyHash.toLowerCase(),
        profile: "trader",
        registered: true,
        isAdmin: false,
        hook: HOOK,
        hooked: true,
        summary: { initialized: true, active: true, revoked: false },
        remaining: [{ token: USD, amount: String(usd(40)) }],
        inventory: [{ token: MEME, amount: String(5n * UNIT) }],
      });
      // Calibur Settings carry the 24 h expiry.
      expect(session.expiry - Math.floor(Date.now() / 1000)).toBeGreaterThan(86400 - 600);
      expect(session.policy.quoteLimits).toEqual([
        { token: USD, totalCap: String(usd(100)), periodCap: String(usd(50)) },
      ]);
      expect(session.policy.trustedSpenders).toEqual([PAD]);
      expect(session.policy.permissions).toHaveLength(3);
      expect(session.policy.maxDeadlineWindow).toBe(600);
    },
    STEP_MS,
  );

  describe("4. every overreach is refused by the CLI, the sponsor and, through handleOps, the chain", () => {
    it(
      "a target outside the allowlist (MockUSD.transfer)",
      async () => {
        const transfer: Call = {
          to: USD,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [ATTACKER.address, 1n],
          }),
        };
        const error = await refusedEverywhere([transfer], {
          cli: 10,
          sponsor: "SIMULATION_FAILED",
          chain: "reverted: CallNotPermitted",
        });
        expect(error.code).toBe("POLICY_VIOLATION");
      },
      STEP_MS,
    );

    it(
      "an approve over the remaining limit",
      async () => {
        const error = await refusedEverywhere([approve(usd(41))], {
          cli: 11,
          sponsor: "SIMULATION_FAILED",
          chain: "reverted: LimitExceeded",
        });
        expect(error).toMatchObject({ code: "LIMIT_EXCEEDED", remaining: String(usd(40)) });
      },
      STEP_MS,
    );

    it(
      "a buy over the remaining limit, spending an allowance the human set",
      async () => {
        // The allowance belongs to the account: the root may approve more than the session's limit.
        await landed(await s(["account", "exec", "--calls", callsJson([approve(usd(100))])], 0));
        const error = await refusedEverywhere([await trade("buy", usd(41))], {
          cli: 11,
          sponsor: "SIMULATION_FAILED",
          chain: "reverted: LimitExceeded",
        });
        expect(error.code).toBe("LIMIT_EXCEEDED");
        await landed(await s(["account", "exec", "--calls", callsJson([approve(0n)])], 0));
        expect(await allowance()).toBe(0n);
      },
      STEP_MS,
    );

    it(
      "selling more than the session's inventory, reaching into the meme the human held before",
      async () => {
        // 5 attributed + 7 the human's: the balance covers the sale, the attribution does not.
        expect(await balanceOf(MEME)).toBeGreaterThan(5n * UNIT + 1n);
        const error = await refusedEverywhere([await trade("sell", 5n * UNIT + 1n)], {
          cli: 12,
          sponsor: "SIMULATION_FAILED",
          chain: "reverted: InventoryExceeded",
        });
        expect(error).toMatchObject({ code: "INVENTORY_EXCEEDED", held: String(5n * UNIT) });
      },
      STEP_MS,
    );

    it(
      "a call to the hook (raising its own caps with updatePolicy)",
      async () => {
        const [current] = await client.readContract({
          address: HOOK,
          abi: agentPolicyHookAbi,
          functionName: "getPolicy",
          args: [keyHash, account],
        });
        const raised = {
          ...current,
          quoteLimits: current.quoteLimits.map((q) => ({ ...q, periodCap: q.totalCap * 10n })),
        };
        const call: Call = {
          to: HOOK,
          value: 0n,
          data: encodeFunctionData({
            abi: agentPolicyHookAbi,
            functionName: "updatePolicy",
            args: [keyHash, raised],
          }),
        };
        await refusedEverywhere([call], {
          cli: 10,
          sponsor: "SIMULATION_FAILED",
          chain: "reverted: TargetIsHook",
        });
      },
      STEP_MS,
    );

    it(
      "a buy with a deadline beyond the policy's window",
      async () => {
        const call = await trade("buy", 1n, { deadline: (await now()) + 3600n });
        await refusedEverywhere([call], {
          cli: 10,
          sponsor: "SIMULATION_FAILED",
          chain: "reverted: DeadlineOutOfRange",
        });
      },
      STEP_MS,
    );

    it(
      "a sell whose proceeds go to someone else (recipient ≠ self)",
      async () => {
        const call = await trade("sell", 1n, { recipient: ATTACKER.address });
        await refusedEverywhere([call], {
          cli: 10,
          sponsor: "SIMULATION_FAILED",
          chain: "reverted: RecipientNotAccount",
        });
      },
      STEP_MS,
    );

    it(
      "an ERC-1271 signature by the session key (no CLI or sponsor path exists)",
      async () => {
        // A valid ERC-7739 nested personal-sign signature by the session key: Calibur verifies it,
        // then the hook rejects it.
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
        const wrapped = encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
          [keyHash, signature, "0x"],
        );
        const data = encodeFunctionData({
          abi: parseAbi(["function isValidSignature(bytes32, bytes) view returns (bytes4)"]),
          args: [hashMessage(message), wrapped],
        });
        const reason = await client.call({ to: account, data }).then(
          () => "no revert",
          (e: unknown) => revertName(revertData(e)),
        );
        expect(reason).toBe("SessionKeySignatureRejected");
      },
      STEP_MS,
    );

    it(
      "a UserOp whose sponsorship window has passed: the paymaster refuses it (AA32)",
      async () => {
        // No CLI or sponsor request carries a stale window: the SDK refuses a passed deadline before
        // asking, and the sponsor's REQUEST_EXPIRED check is unit-tested (packages/sponsor/test).
        const before = await state();
        const { op } = await userOp(trader, keyHash, [approve(1n)], {
          validUntil: Number(await now()) - 1,
        });
        expect(await handleOps(op)).toBe("AA32 paymaster expired or not due");
        expect(await state()).toEqual(before);
      },
      STEP_MS,
    );

    describe("I10: a session UserOp without our paymaster fails validation in the hook", () => {
      const wrongPaymaster = toFunctionSelector("WrongPaymaster()");

      it(
        "with no paymaster: AA23 WrongPaymaster, even when the account could pay the prefund",
        async () => {
          const before = await state();
          const nonce = await epNonce(laneOf(keyHash));
          const { op } = await userOp(trader, keyHash, [approve(1n)], { paymaster: "none" });
          // With 1 MNT the account could pay its prefund: the hook, not an empty balance, refuses.
          const funded = await client
            .call({
              account: ATTACKER.address,
              to: EP,
              data: encodeFunctionData({
                abi: entryPoint08Abi,
                functionName: "handleOps",
                args: [[toPackedUserOperation(op)], ATTACKER.address],
              }),
              stateOverride: [{ address: account, balance: parseEther("1") }],
            })
            .then(
              () => "no revert",
              (e: unknown) => failedOp(revertData(e)),
            );
          expect(funded).toBe("AA23 reverted: WrongPaymaster");
          expect(await handleOps(op)).toBe("AA23 reverted: WrongPaymaster");
          // The strict bundler refuses it in validation too.
          await expect(
            bundlerRpc(stack.bundler.url, "eth_sendUserOperation", [
              formatUserOperationRequest(op),
              EP,
            ]),
          ).rejects.toThrow(wrongPaymaster);
          expect(await state()).toEqual(before);
          expect(await epNonce(laneOf(keyHash))).toBe(nonce);
        },
        STEP_MS,
      );

      it(
        "with another working, funded paymaster: AA23 WrongPaymaster; neither deposit is charged",
        async () => {
          // A second VerifyingPaymaster (the deployed code, same signer) with its own deposit. The
          // root's UserOps may use it; a session's may not.
          const clone = privateKeyToAddress(generatePrivateKey());
          await client.setCode({
            address: clone,
            bytecode: (await client.getCode({ address: PAYMASTER })) as Hex,
          });
          const hash = await attacker().writeContract({
            address: EP,
            abi: entryPoint08Abi,
            functionName: "depositTo",
            args: [clone],
            value: parseEther("1"),
          });
          await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
          const human = loadProfileSigner("human", keystore);
          expect(
            await handleOps(
              (await userOp(human, zeroHash, [approve(0n)], { paymaster: clone })).op,
            ),
          ).toBe("success");

          const before = {
            ...(await state()),
            clone: await deposit(clone),
            ours: await deposit(PAYMASTER),
          };
          const { op } = await userOp(trader, keyHash, [approve(1n)], { paymaster: clone });
          expect(await handleOps(op)).toBe("AA23 reverted: WrongPaymaster");
          await expect(
            bundlerRpc(stack.bundler.url, "eth_sendUserOperation", [
              formatUserOperationRequest(op),
              EP,
            ]),
          ).rejects.toThrow(wrongPaymaster);
          expect({
            ...(await state()),
            clone: await deposit(clone),
            ours: await deposit(PAYMASTER),
          }).toEqual(before);
        },
        STEP_MS,
      );
    });

    it("left the session's limits and inventory untouched", async () => {
      expect(await read("remainingLimit", USD)).toBe(usd(40));
      expect(await read("inventory", MEME)).toBe(5n * UNIT);
      expect(await balanceOf(USD)).toBe(usd(195));
      expect(await balanceOf(MEME)).toBe(HUMAN_MEME + 5n * UNIT);
      expect(await allowance()).toBe(0n);
    });
  });

  describe("cross-path replay: a signed batch runs once, and only on the path it was signed for", () => {
    it(
      "a SignedBatchedCall (relayer path) does not validate as a UserOp, and runs once",
      async () => {
        const lane = laneOf(keyHash);
        const [seq, nonce] = [await readCaliburNonce(client, account, lane), await epNonce(lane)];
        const signed = await signDirect(trader, keyHash, [approve(1n)]);
        const [signature] = decodeAbiParameters(
          [{ type: "bytes" }, { type: "bytes" }],
          decodeExecute(signed).wrappedSignature,
        );
        // The same calls, the same key, its signature: the EntryPoint asks for another digest.
        const { op } = await userOp(trader, keyHash, [approve(1n)], { signature });
        expect(await handleOps(op)).toBe("AA24 signature error");

        expect(await execute(signed)).toBe("success");
        expect(await allowance()).toBe(1n);
        expect(await execute(signed)).toBe("InvalidNonce");
        expect(await handleOps(op)).toBe("AA24 signature error");
        expect(await allowance()).toBe(1n);
        // Only Calibur's sequence moved.
        expect(await readCaliburNonce(client, account, lane)).toBe(seq + 1n);
        expect(await epNonce(lane)).toBe(nonce);
      },
      STEP_MS,
    );

    it(
      "a UserOp (bundler path) does not validate as a SignedBatchedCall, and runs once",
      async () => {
        const lane = laneOf(keyHash);
        const [seq, nonce] = [await readCaliburNonce(client, account, lane), await epNonce(lane)];
        const { op, signature } = await userOp(trader, keyHash, [approve(2n)]);
        expect(await handleOps(op)).toBe("success");
        expect(await allowance()).toBe(2n);
        expect(await handleOps(op)).toBe("AA25 invalid account nonce");

        // The UserOp's signature on a SignedBatchedCall of the same calls, key and Calibur nonce.
        const batch = {
          batchedCall: { calls: [approve(2n)], revertOnFailure: true },
          nonce: seq,
          keyHash,
          executor: ATTACKER.address,
          deadline: (await now()) + 600n,
        };
        const forged = encodeFunctionData({
          abi: caliburAbi,
          functionName: "execute",
          args: [
            batch,
            encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [signature, "0x"]),
          ],
        });
        expect(await execute(forged)).toBe("InvalidSignature");
        expect(await allowance()).toBe(2n);
        // Only the EntryPoint nonce moved.
        expect(await epNonce(lane)).toBe(nonce + 1n);
        expect(await readCaliburNonce(client, account, lane)).toBe(seq);
      },
      STEP_MS,
    );
  });

  describe("cross-lane nonce consumption", () => {
    it(
      "on chain a session key can consume another key's and the root's lane (a known limitation)",
      async () => {
        const grant = await s(["session", "grant", "--agent", "other", "--policy", policy], 0);
        await landed(grant);
        otherHash = grant.json.result.keyHash as Hex;
        other = loadProfileSigner("other", keystore);
        const otherLane = laneOf(otherHash);
        expect(otherLane).not.toBe(laneOf(keyHash));

        // EntryPoint nonces: the trader's UserOps on the other key's lane and on the root lane 0 are
        // valid; nothing on chain binds a nonce key to the signing key (DESIGN §4.1).
        const [onOther, onRoot] = [await epNonce(otherLane), await epNonce(0n)];
        for (const nonceKey of [otherLane, 0n]) {
          const { op } = await userOp(trader, keyHash, [approve(0n)], { nonceKey });
          expect(await handleOps(op)).toBe("success");
        }
        expect(await epNonce(otherLane)).toBe(onOther + 1n);
        expect(await epNonce(0n)).toBe(onRoot + 1n);

        // Calibur's SignedBatchedCall sequences: the same.
        const seq = await readCaliburNonce(client, account, otherLane);
        expect(await execute(await signDirect(trader, keyHash, [approve(0n)], otherLane))).toBe(
          "success",
        );
        expect(await readCaliburNonce(client, account, otherLane)).toBe(seq + 1n);

        // A DoS of what the other key had signed only: it still executes on the next sequence.
        const r = await s(
          ["agent", "exec", "--agent", "other", "--calls", callsJson([approve(0n)])],
          0,
        );
        await landed(r);
      },
      STEP_MS,
    );

    it(
      "the sponsor rejects it on both paths: WRONG_LANE, ROOT_LANE_MISUSE",
      async () => {
        for (const via of ["bundler", "relayer"] as const) {
          await sponsorRefuses(
            trader,
            keyHash,
            [approve(0n)],
            "WRONG_LANE",
            via,
            laneOf(otherHash),
          );
          await sponsorRefuses(trader, keyHash, [approve(0n)], "ROOT_LANE_MISUSE", via, 0n);
        }
      },
      STEP_MS,
    );
  });

  describe("5. session revoke", () => {
    let preSigned: UserOperation<"0.8">;

    it(
      "revokes; old and new signatures no longer execute",
      async () => {
        preSigned = (await userOp(trader, keyHash, [approve(1n)])).op;
        const r = await s(["session", "revoke", "--agent", "trader"], 0);
        expect(r.json.result).toMatchObject({ profile: "trader" });
        await landed(r);
        expect(await allowance()).toBe(0n);

        // The UserOp signed before the revoke, and one signed after it: Calibur no longer knows the
        // key and answers SIG_VALIDATION_FAILED.
        expect(await handleOps(preSigned)).toBe("AA24 signature error");
        expect(await handleOps((await userOp(trader, keyHash, [approve(1n)])).op)).toBe(
          "AA24 signature error",
        );
        expect((await cliRefuses("trader", keyHash, [approve(1n)], 13)).code).toBe(
          "KEY_EXPIRED_OR_REVOKED",
        );
        await sponsorRefuses(trader, keyHash, [approve(1n)], "KEY_NOT_REGISTERED");
      },
      STEP_MS,
    );

    it(
      "re-granting the same key is rejected (SessionRevoked)",
      async () => {
        const [old] = await client.readContract({
          address: HOOK,
          abi: agentPolicyHookAbi,
          functionName: "getPolicy",
          args: [keyHash, account],
        });
        const settings = BigInt(HOOK) | (BigInt(Math.floor(Date.now() / 1000) + 86400) << 160n);
        const self = (data: Hex): Call => ({ to: account, value: 0n, data });
        const register = self(
          encodeFunctionData({
            abi: caliburAbi,
            functionName: "register",
            args: [
              {
                keyType: 2,
                publicKey: encodeAbiParameters([{ type: "address" }], [trader.address]),
              },
            ],
          }),
        );
        const update = self(
          encodeFunctionData({
            abi: caliburAbi,
            functionName: "update",
            args: [keyHash, settings],
          }),
        );
        const setPolicy: Call = {
          to: HOOK,
          value: 0n,
          data: encodeFunctionData({
            abi: agentPolicyHookAbi,
            functionName: "setPolicy",
            args: [keyHash, old],
          }),
        };
        const regrant = [register, update, setPolicy];

        // Through the CLI the sponsor's simulation refuses it; the chain says why.
        const r = await s(["account", "exec", "--calls", callsJson(regrant)], 20);
        expect(r.json.error).toMatchObject({
          code: "SPONSOR_REJECTED",
          reason: "SIMULATION_FAILED",
        });
        const batched = encodeFunctionData({
          abi: parseAbi([
            "struct Call { address to; uint256 value; bytes data; }",
            "struct BatchedCall { Call[] calls; bool revertOnFailure; }",
            "function execute(BatchedCall batchedCall)",
          ]),
          args: [{ calls: regrant, revertOnFailure: true }],
        });
        const reason = await client.call({ account, to: account, data: batched }).then(
          () => "no revert",
          (e: unknown) => revertName(revertData(e)),
        );
        expect(reason).toBe("CallFailed(SessionRevoked)");

        // Even with the key registered on Calibur again (without the hook policy), so that Calibur
        // accepts its signature, the hook's validation callback stops the old and a new UserOp.
        await landed(await s(["account", "exec", "--calls", callsJson([register, update])], 0));
        expect(await handleOps(preSigned)).toBe("AA23 reverted: SessionInactive");
        expect(await handleOps((await userOp(trader, keyHash, [approve(1n)])).op)).toBe(
          "AA23 reverted: SessionInactive",
        );
        await sponsorRefuses(trader, keyHash, [approve(1n)], "KEY_INACTIVE");
        expect((await cliRefuses("trader", keyHash, [approve(1n)], 13)).code).toBe(
          "KEY_EXPIRED_OR_REVOKED",
        );
        expect(await allowance()).toBe(0n);
      },
      STEP_MS,
    );

    it(
      "6. account status / session list show the revoked session with its frozen inventory",
      async () => {
        const status = (await s(["account", "status"], 0)).json.result;
        expect(status.state).toBe("INITIALIZED");
        const listed = (await s(["session", "list"], 0)).json.result;
        expect(listed.sessions).toEqual(status.sessions);
        const session = status.sessions.find((x: { profile?: string }) => x.profile === "trader");
        expect(session).toMatchObject({
          keyHash: keyHash.toLowerCase(),
          summary: { initialized: true, active: false, revoked: true },
          inventory: [{ token: MEME, amount: String(5n * UNIT) }],
        });
        expect(
          status.sessions.find((x: { profile?: string }) => x.profile === "other"),
        ).toMatchObject({
          keyHash: otherHash.toLowerCase(),
          summary: { initialized: true, active: true, revoked: false },
        });
        // Revoke iterates no inventory: it stays reserved until the root releases it.
        expect(status.inventory).toEqual([
          {
            token: MEME,
            balance: String(HUMAN_MEME + 5n * UNIT),
            reserved: String(5n * UNIT),
            unallocated: String(HUMAN_MEME),
          },
        ]);
      },
      STEP_MS,
    );
  });

  // Last: it moves the fork's clock a day ahead.
  it(
    "4. an expired key is refused by the CLI, the sponsor and the chain (AA22)",
    async () => {
      await s(["agent", "simulate", "--agent", "other", "--calls", callsJson([approve(1n)])], 0);
      await client.increaseTime({ seconds: 86400 + 600 });
      await client.mine({ blocks: 1 });

      const error = await cliRefuses("other", otherHash, [approve(1n)], 13);
      expect(error.code).toBe("KEY_EXPIRED_OR_REVOKED");
      await sponsorRefuses(other, otherHash, [approve(1n)], "KEY_EXPIRED");
      expect(await handleOps((await userOp(other, otherHash, [approve(1n)])).op)).toBe(
        "AA22 expired or not due",
      );

      const status = (await s(["account", "status"], 0)).json.result;
      const session = status.sessions.find((x: { profile?: string }) => x.profile === "other");
      expect(session).toMatchObject({ summary: { active: true, revoked: false } });
      expect(BigInt(session.expiry)).toBeLessThan(await now());
    },
    STEP_MS,
  );

  it("the human and the agents held 0 MNT throughout, and the account no EntryPoint deposit", async () => {
    await zeroMnt([account, trader.address, other.address]);
    expect(await deposit(account)).toBe(0n);
  });
}

describe.skipIf(!rpcUrl)(
  "bundler path end to end on a Mantle Sepolia fork with strict Alto",
  () => {
    describe("(a) against a long-running sponsor (sponsor serve)", () => bundlerRun("service"));
    describe("(b) embedded sponsor (MANTLE_AA_EMBEDDED_RELAYER=1), no service", () =>
      bundlerRun("embedded"));
  },
);
