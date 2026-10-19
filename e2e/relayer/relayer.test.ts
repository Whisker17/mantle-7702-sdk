// docs/DESIGN.md §8 steps 1–6 through the relayer path, on an anvil fork of Mantle Sepolia: once
// against a long-running sponsor (`sponsor serve`) and once in embedded mode (no service). Every
// overreach is rejected three times: by the CLI (the SDK's local pre-check, nothing sent), by the
// sponsor's own simulation (a request built without the pre-check), and on chain, where the batch is
// signed with the session key and sent straight to the account by a funded EOA, bypassing both.
// Skipped when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentPolicyHookAbi,
  type Call,
  caliburAbi,
  getCaliburDomain,
  laneOf,
  launchpadAbi,
  loadDeployments,
  loadProfileSigner,
  type PrivateKeySigner,
  RelayerExecutor,
  readCaliburNonce,
  readProfiles,
  SponsorRejectedError,
  signBatchedCall,
} from "@0xwh1sker/mantle-aa-sdk";
import { startEmbeddedSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import {
  type Address,
  BaseError,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  hashMessage,
  isHex,
  parseAbi,
  toHex,
  toPrefixedMessage,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../packages/cli/src/index.js";
import {
  type CliResult,
  cli,
  PASSWORD,
  tempHome,
  testEnv,
} from "../../packages/cli/test/helpers.js";
import {
  clientFor,
  mockUsdAbi,
  startFork,
  THIRD_PARTY,
  walletFor,
} from "../../packages/sdk/test/account/fork.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const HOOK = book.agentPolicyHook;
const usd = (n: number) => BigInt(n) * 10n ** 6n;
const UNIT = 10n ** 21n; // MockLaunchpad: 1 mUSD buys 1e21 meme units
/** Meme the human holds before any session exists (an airdrop from a third party). */
const HUMAN_MEME = 7n * UNIT;

const MNEMONIC = "test test test test test test test test test test test junk";
const anvilKey = (addressIndex: number) =>
  toHex(mnemonicToAccount(MNEMONIC, { addressIndex }).getHdKey().privateKey as Uint8Array);
/** Relayers: the long-running sponsor's (1), the CLI's embedded one (3), the test's embedded one (4). */
const SERVICE_RELAYER_KEY = anvilKey(1);
const EMBEDDED_RELAYER_KEY = anvilKey(3);
const CHECK_RELAYER_KEY = anvilKey(4);
/** Pays for the direct on-chain submissions; never the human or an agent. */
const ATTACKER = THIRD_PARTY;

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

/** The revert data of a failed `eth_call` (the deepest cause carries it, as viem's own helper). */
function revertData(error: unknown): Hex {
  const cause = error instanceof BaseError ? (error.walk() as { data?: unknown }) : undefined;
  const raw = cause?.data;
  const data = typeof raw === "object" ? (raw as { data?: unknown } | null)?.data : raw;
  if (!isHex(data)) throw error;
  return data;
}

/** Polls `check` every 200 ms until it holds; fails after `ms`. */
async function until(check: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(200);
  }
}

type Mode = "service" | "embedded";

function relayerRun(mode: Mode) {
  const relayerKey = mode === "service" ? SERVICE_RELAYER_KEY : EMBEDDED_RELAYER_KEY;
  const relayer = mnemonicToAccount(MNEMONIC, { addressIndex: mode === "service" ? 1 : 3 }).address;
  const home = tempHome("mantle-aa-e2e-");
  const env = testEnv(
    home,
    mode === "embedded"
      ? { MANTLE_AA_EMBEDDED_RELAYER: "1", MANTLE_AA_RELAYER_KEY: relayerKey }
      : {},
  );
  const keystore = { home: env.MANTLE_AA_HOME as string, password: PASSWORD };
  const policy = join(home, "policy.json");
  const config = join(home, "sponsor.yaml");
  const abort = new AbortController();
  let serving: Promise<number> | undefined;
  let checker: Awaited<ReturnType<typeof startEmbeddedSponsor>> | undefined;

  let anvil: string;
  let stopFork: (() => void) | undefined;
  let client: ReturnType<typeof clientFor>;
  let account: Address;
  /** The sponsor, reached without the SDK's pre-check. */
  let sponsor: RelayerExecutor;
  let trader: PrivateKeySigner;
  let keyHash: Hex;

  const now = async () => (await client.getBlock()).timestamp;
  const relayerTxs = () => client.getTransactionCount({ address: relayer });
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

  // ---- the three ways a batch can be submitted ----

  /** Runs a CLI step, checks its exit code and that its output carries no secret. */
  async function s(args: string[], code: number): Promise<CliResult> {
    const result = await cli(args, env);
    const output = result.stdout + result.stderr;
    for (const secret of [PASSWORD, ...[relayerKey, CHECK_RELAYER_KEY].map((k) => k.slice(2))]) {
      expect(output).not.toContain(secret);
    }
    expect(result.code, `${args.join(" ")}: ${result.stdout}`).toBe(code);
    expect(result.json.ok).toBe(code === 0);
    return result;
  }

  /** `agent exec` refuses with `code` and neither the sponsor nor the chain sees a transaction. */
  async function cliRefuses(agent: string, calls: Call[], code: number) {
    const txs = await relayerTxs();
    const r = await s(["agent", "exec", "--agent", agent, "--calls", callsJson(calls)], code);
    expect(await relayerTxs()).toBe(txs);
    return r.json.error;
  }

  /** The sponsor, given the signed request without any pre-check, refuses it with `reason`. */
  async function sponsorRefuses(signer: PrivateKeySigner, key: Hex, calls: Call[], reason: string) {
    const txs = await relayerTxs();
    const error = await sponsor
      .submit({
        account,
        keyHash: key,
        calls,
        lane: laneOf(key),
        signer,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SponsorRejectedError);
    expect((error as SponsorRejectedError).reason, (error as Error).message).toBe(reason);
    expect(await relayerTxs()).toBe(txs);
  }

  /** Signs the batch with the session key, executor = the attacker's EOA. */
  async function signDirect(signer: PrivateKeySigner, key: Hex, calls: Call[]) {
    return signBatchedCall(client, {
      account,
      implementation: book.caliburEntry,
      chainId: book.chainId,
      signer,
      keyHash: key,
      calls,
      nonce: await readCaliburNonce(client, account, laneOf(key)),
      executor: ATTACKER.address,
      deadline: (await now()) + 600n,
    });
  }

  /**
   * Sends `execute(SignedBatchedCall, sig)` from the attacker straight to the account (fixed gas,
   * so the reverting transaction is mined) and returns the revert reason of the same call.
   */
  async function landsReverted(data: Hex): Promise<string> {
    const reason = await client.call({ account: ATTACKER.address, to: account, data }).then(
      () => "no revert",
      (e: unknown) => revertName(revertData(e)),
    );
    const hash = await walletFor(anvil, ATTACKER).sendTransaction({
      to: account,
      data,
      gas: 3_000_000n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    expect(receipt.status).toBe("reverted");
    return reason;
  }

  /** The overreach is refused by the CLI, the sponsor and the chain (the hook / Calibur). */
  async function refusedEverywhere(
    calls: Call[],
    expected: { cli: number; sponsor: string; chain: string },
  ) {
    const error = await cliRefuses("trader", calls, expected.cli);
    await sponsorRefuses(trader, keyHash, calls, expected.sponsor);
    expect(await landsReverted(await signDirect(trader, keyHash, calls))).toBe(expected.chain);
    return error;
  }

  const zeroMnt = async (who: Address[]) => {
    for (const address of who) expect(await client.getBalance({ address }), address).toBe(0n);
  };

  beforeAll(async () => {
    ({ url: anvil, stop: stopFork } = await startFork(rpcUrl as string));
    client = clientFor(anvil);
    env.MANTLE_AA_RPC_URL = anvil;
    writeFileSync(policy, JSON.stringify(policyJson));
    await s(["keys", "new", "--name", "human"], 0);
    account = readProfiles(keystore).human?.account as Address;

    if (mode === "service") {
      writeFileSync(
        config,
        [
          "chainId: 5003",
          `rpcUrl: ${anvil}`,
          "listen: { host: 127.0.0.1, port: 0 }",
          `database: ${join(home, "sponsor.sqlite")}`,
          `relayer: "${relayer}"`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
          "relayerKey: ${E2E_RELAYER_KEY}",
          "settleTimeoutSeconds: 5",
          "policy:",
          `  allowlist: ["${account}"]`,
          "  accountDailyGas: 20000000",
          '  maxFeePerRequestMnt: "0.5"',
          '  dailyBudgetMnt: "5"',
          '  managementReserveMnt: "1"',
        ].join("\n"),
      );
      let out = "";
      serving = run(["sponsor", "serve", "--config", config, "--json"], {
        env: { ...env, E2E_RELAYER_KEY: relayerKey },
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
      const served = JSON.parse(out).result;
      expect(served.relayer).toBe(relayer);
      env.MANTLE_AA_SPONSOR_URL = served.url;
      sponsor = new RelayerExecutor({ client, url: served.url, addresses: book });
    } else {
      // The CLI starts its own embedded sponsor per command; this one only answers the requests
      // that skip the pre-check, with the same sponsor logic.
      checker = await startEmbeddedSponsor({
        rpcUrl: anvil,
        allowlist: [account],
        addresses: book,
        env: { MANTLE_AA_EMBEDDED_RELAYER: "1", MANTLE_AA_RELAYER_KEY: CHECK_RELAYER_KEY },
      });
      sponsor = new RelayerExecutor({ client, url: checker.url, addresses: book });
    }

    // The human already holds meme before any session exists: a third party buys it for them.
    const wallet = walletFor(anvil, THIRD_PARTY);
    for (const request of [
      { address: USD, abi: mockUsdAbi, functionName: "mint", args: [THIRD_PARTY.address, usd(7)] },
      { address: USD, abi: erc20Abi, functionName: "approve", args: [PAD, usd(7)] },
      {
        address: PAD,
        abi: launchpadAbi,
        functionName: "buy",
        args: [MEME, usd(7), 0n, (await now()) + 600n, account],
      },
    ] as const) {
      const hash = await wallet.writeContract(request as never);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      expect(receipt.status).toBe("success");
    }
    expect(await balanceOf(MEME)).toBe(HUMAN_MEME);
  }, 120_000);

  afterAll(async () => {
    abort.abort();
    await serving;
    await checker?.close();
    stopFork?.();
  }, 30_000);

  it("1. account init --grant: gasless, UNDELEGATED → INITIALIZED", async () => {
    expect((await s(["account", "status"], 0)).json.result.state).toBe("UNDELEGATED");
    const txs = await relayerTxs();
    const r = await s(["account", "init", "--grant", policy, "--agent", "trader"], 0);
    expect(r.json.result).toMatchObject({
      account,
      state: "INITIALIZED",
      session: { profile: "trader" },
    });
    expect(await relayerTxs()).toBe(txs + 1);
    const receipt = await client.getTransactionReceipt({ hash: r.json.result.hash });
    expect(receipt.from.toLowerCase()).toBe(relayer.toLowerCase());
    keyHash = readProfiles(keystore).trader?.keyHash as Hex;
    trader = loadProfileSigner("trader", keystore);
    expect((await s(["account", "status"], 0)).json.result.state).toBe("INITIALIZED");
    await zeroMnt([account, trader.address]);

    // Principal is minted, never bought with MNT.
    const hash = await walletFor(anvil, THIRD_PARTY).writeContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "mint",
      args: [account, usd(200)],
    });
    await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  }, 120_000);

  it("2. agent exec: approve(MockUSD → launchpad, exact) + buy", async () => {
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
    const receipt = await client.getTransactionReceipt({ hash: r.json.result.hash });
    expect(receipt.from.toLowerCase()).toBe(relayer.toLowerCase());
    expect(await balanceOf(USD)).toBe(usd(190));
    expect(await balanceOf(MEME)).toBe(HUMAN_MEME + 10n * UNIT);
    expect(await read("inventory", MEME)).toBe(10n * UNIT);
    expect(await read("remainingLimit", USD)).toBe(usd(40));
    expect(await allowance()).toBe(0n);
  }, 120_000);

  it("3. agent exec: sell(≤ inventory) returns MockUSD to the account", async () => {
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
    expect(await balanceOf(USD)).toBe(usd(195));
    expect(await balanceOf(MEME)).toBe(HUMAN_MEME + 5n * UNIT);
    expect(await read("inventory", MEME)).toBe(5n * UNIT);
    // Inflows never restore the limit.
    expect(await read("remainingLimit", USD)).toBe(usd(40));
  }, 120_000);

  it("6. account status / session list: state, keys, policy, remaining limits, inventory", async () => {
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
  }, 120_000);

  describe("4. every overreach is refused by the CLI, the sponsor and, sent directly, the chain", () => {
    it("a target outside the allowlist (MockUSD.transfer)", async () => {
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
        chain: "CallNotPermitted",
      });
      expect(error.code).toBe("POLICY_VIOLATION");
    }, 120_000);

    it("an approve over the remaining limit", async () => {
      const error = await refusedEverywhere([approve(usd(41))], {
        cli: 11,
        sponsor: "SIMULATION_FAILED",
        chain: "LimitExceeded",
      });
      expect(error).toMatchObject({ code: "LIMIT_EXCEEDED", remaining: String(usd(40)) });
    }, 120_000);

    it("a buy over the remaining limit, spending an allowance the human set", async () => {
      // The allowance belongs to the account: the root may approve more than the session's limit.
      await s(["account", "exec", "--calls", callsJson([approve(usd(100))])], 0);
      const error = await refusedEverywhere([await trade("buy", usd(41))], {
        cli: 11,
        sponsor: "SIMULATION_FAILED",
        chain: "LimitExceeded",
      });
      expect(error.code).toBe("LIMIT_EXCEEDED");
      await s(["account", "exec", "--calls", callsJson([approve(0n)])], 0);
      expect(await allowance()).toBe(0n);
    }, 180_000);

    it("selling more than the session's inventory, reaching into the meme the human held before", async () => {
      // 5 attributed + 7 the human's: the balance covers the sale, the attribution does not.
      expect(await balanceOf(MEME)).toBeGreaterThan(5n * UNIT + 1n);
      const error = await refusedEverywhere([await trade("sell", 5n * UNIT + 1n)], {
        cli: 12,
        sponsor: "SIMULATION_FAILED",
        chain: "InventoryExceeded",
      });
      expect(error).toMatchObject({ code: "INVENTORY_EXCEEDED", held: String(5n * UNIT) });
    }, 120_000);

    it("a call to the hook (raising its own caps with updatePolicy)", async () => {
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
        chain: "TargetIsHook",
      });
    }, 120_000);

    it("a buy with a deadline beyond the policy's window", async () => {
      const call = await trade("buy", 1n, { deadline: (await now()) + 3600n });
      await refusedEverywhere([call], {
        cli: 10,
        sponsor: "SIMULATION_FAILED",
        chain: "DeadlineOutOfRange",
      });
    }, 120_000);

    it("a sell whose proceeds go to someone else (recipient ≠ self)", async () => {
      const call = await trade("sell", 1n, { recipient: ATTACKER.address });
      await refusedEverywhere([call], {
        cli: 10,
        sponsor: "SIMULATION_FAILED",
        chain: "RecipientNotAccount",
      });
    }, 120_000);

    it("an ERC-1271 signature by the session key (no CLI or sponsor path exists)", async () => {
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
    }, 120_000);

    it("left the session's limits and inventory untouched", async () => {
      expect(await read("remainingLimit", USD)).toBe(usd(40));
      expect(await read("inventory", MEME)).toBe(5n * UNIT);
      expect(await balanceOf(USD)).toBe(usd(195));
      expect(await balanceOf(MEME)).toBe(HUMAN_MEME + 5n * UNIT);
    }, 120_000);
  });

  describe("5. session revoke", () => {
    let preSigned: Hex;

    it("revokes; old and new signatures no longer execute", async () => {
      preSigned = await signDirect(trader, keyHash, [approve(1n)]);
      const r = await s(["session", "revoke", "--agent", "trader"], 0);
      expect(r.json.result).toMatchObject({ profile: "trader" });
      expect(await allowance()).toBe(0n);

      // The batch signed before the revoke, and one signed after it.
      expect(await landsReverted(preSigned)).toBe("KeyDoesNotExist");
      expect(await landsReverted(await signDirect(trader, keyHash, [approve(1n)]))).toBe(
        "KeyDoesNotExist",
      );
      expect((await cliRefuses("trader", [approve(1n)], 13)).code).toBe("KEY_EXPIRED_OR_REVOKED");
      await sponsorRefuses(trader, keyHash, [approve(1n)], "KEY_NOT_REGISTERED");
    }, 180_000);

    it("re-granting the same key is rejected (SessionRevoked)", async () => {
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
        encodeFunctionData({ abi: caliburAbi, functionName: "update", args: [keyHash, settings] }),
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
      expect(r.json.error).toMatchObject({ code: "SPONSOR_REJECTED", reason: "SIMULATION_FAILED" });
      const execute = encodeFunctionData({
        abi: parseAbi([
          "struct Call { address to; uint256 value; bytes data; }",
          "struct BatchedCall { Call[] calls; bool revertOnFailure; }",
          "function execute(BatchedCall batchedCall)",
        ]),
        args: [{ calls: regrant, revertOnFailure: true }],
      });
      const reason = await client.call({ account, to: account, data: execute }).then(
        () => "no revert",
        (e: unknown) => revertName(revertData(e)),
      );
      expect(reason).toBe("CallFailed(SessionRevoked)");

      // Even with the key registered on Calibur again (without the hook policy), so that Calibur
      // accepts its signature, the hook's tombstone stops the old batch.
      await s(["account", "exec", "--calls", callsJson([register, update])], 0);
      expect(await landsReverted(preSigned)).toBe("SessionInactive");
      expect(await landsReverted(await signDirect(trader, keyHash, [approve(1n)]))).toBe(
        "SessionInactive",
      );
      await sponsorRefuses(trader, keyHash, [approve(1n)], "KEY_INACTIVE");
      expect((await cliRefuses("trader", [approve(1n)], 13)).code).toBe("KEY_EXPIRED_OR_REVOKED");
    }, 180_000);

    it("6. account status / session list show the revoked session with its frozen inventory", async () => {
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
      // Revoke iterates no inventory: it stays reserved until the root releases it.
      expect(status.inventory).toEqual([
        {
          token: MEME,
          balance: String(HUMAN_MEME + 5n * UNIT),
          reserved: String(5n * UNIT),
          unallocated: String(HUMAN_MEME),
        },
      ]);
    }, 120_000);
  });

  it("4. an expired key is refused by the CLI, the sponsor and the chain", async () => {
    const r = await s(["session", "grant", "--agent", "brief", "--policy", policy], 0);
    const brief = loadProfileSigner("brief", keystore);
    const briefHash = r.json.result.keyHash as Hex;
    await s(["agent", "simulate", "--agent", "brief", "--calls", callsJson([approve(1n)])], 0);

    // Past the 24 h expiry.
    await client.request({ method: "evm_increaseTime" as never, params: [86400 + 600] as never });
    await client.request({ method: "evm_mine" as never });

    const error = await cliRefuses("brief", [approve(1n)], 13);
    expect(error.code).toBe("KEY_EXPIRED_OR_REVOKED");
    await sponsorRefuses(brief, briefHash, [approve(1n)], "KEY_EXPIRED");
    expect(await landsReverted(await signDirect(brief, briefHash, [approve(1n)]))).toBe(
      "KeyExpired",
    );

    const status = (await s(["account", "status"], 0)).json.result;
    const session = status.sessions.find((x: { profile?: string }) => x.profile === "brief");
    expect(session).toMatchObject({ summary: { active: true, revoked: false } });
    expect(BigInt(session.expiry)).toBeLessThan(await now());
  }, 180_000);

  it("the human and the agents held 0 MNT throughout", async () => {
    await zeroMnt([
      account,
      loadProfileSigner("trader", keystore).address,
      loadProfileSigner("brief", keystore).address,
    ]);
  }, 120_000);
}

describe.skipIf(!rpcUrl)("relayer path end to end on a Mantle Sepolia fork", () => {
  describe("(a) against a long-running sponsor (sponsor serve)", () => relayerRun("service"));
  describe("(b) embedded sponsor (MANTLE_AA_EMBEDDED_RELAYER=1), no service", () =>
    relayerRun("embedded"));
});
