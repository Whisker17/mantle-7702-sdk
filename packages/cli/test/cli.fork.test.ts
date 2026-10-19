import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Call, launchpadAbi, loadDeployments, readProfiles } from "@0xwh1sker/mantle-aa-sdk";
import { type Address, encodeFunctionData, erc20Abi, type Hex, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  mockUsdAbi,
  RELAYER,
  startFork,
  THIRD_PARTY,
  walletFor,
} from "../../sdk/test/account/fork.js";
import { run } from "../src/index.js";
import { type CliResult, cli, normalize, PASSWORD, tempHome, testEnv } from "./helpers.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const usd = (n: number) => BigInt(n) * 10n ** 6n;
const anvilAccount = (addressIndex: number) =>
  mnemonicToAccount("test test test test test test test test test test test junk", {
    addressIndex,
  });
const keyOf = (index: number) => toHex(anvilAccount(index).getHdKey().privateKey as Uint8Array);
/** The long-running sponsor's relayer (anvil account 1) and the embedded one's (account 3). */
const RELAYER_KEY = keyOf(1);
const EMBEDDED_RELAYER_KEY = keyOf(3);

const policyJson = (periodCap: number, totalCap: number) => ({
  quoteLimits: [{ token: USD, totalCap: String(usd(totalCap)), periodCap: String(usd(periodCap)) }],
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
});

const callsJson = (calls: Call[]) =>
  JSON.stringify(calls.map((c) => ({ to: c.to, value: String(c.value), data: c.data })));
const approve = (amount: bigint, token: Address = USD): Call => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAD, amount] }),
});
const transfer = (amount: bigint): Call => ({
  to: USD,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [PAD, amount] }),
});

/** Polls `check` every 200 ms until it holds; fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(200);
  }
}

describe.skipIf(!rpcUrl)("the mantle-aa CLI on a Mantle Sepolia fork", () => {
  let anvil: string;
  let stop: () => void;
  let client: ReturnType<typeof clientFor>;
  const rpc = (method: string, params: unknown[] = []) =>
    client.request({ method, params } as never) as Promise<unknown>;
  const now = async () => (await client.getBlock()).timestamp;
  const trade = async (fn: "buy" | "sell", account: Address, amount: bigint): Promise<Call> => ({
    to: PAD,
    value: 0n,
    data: encodeFunctionData({
      abi: launchpadAbi,
      functionName: fn,
      args: [MEME, amount, 0n, (await now()) + 60n, account],
    }),
  });
  async function mint(account: Address, amount: bigint) {
    const hash = await walletFor(anvil, THIRD_PARTY).writeContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "mint",
      args: [account, amount],
    });
    await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  }

  /** Runs a step, checks its exit code and that its output carries no secret. */
  async function step(
    home: string,
    env: NodeJS.ProcessEnv,
    args: string[],
    code: number,
  ): Promise<CliResult> {
    const result = await cli(args, env);
    const output = result.stdout + result.stderr;
    expect(output).not.toMatch(new RegExp(`${anvil.replace(/[.:/]/g, "\\$&")}(?!\\d)`));
    for (const secret of [PASSWORD, RELAYER_KEY.slice(2), EMBEDDED_RELAYER_KEY.slice(2)]) {
      expect(output).not.toContain(secret);
    }
    expect(result.code, `${args.join(" ")}: ${result.stdout}`).toBe(code);
    expect(result.json.ok).toBe(code === 0);
    if (code) expect(result.json.exitCode).toBe(code);
    result.json = normalize(result.json, home);
    return result;
  }

  beforeAll(async () => {
    ({ url: anvil, stop } = await startFork(rpcUrl as string));
    client = clientFor(anvil);
  }, 60_000);
  afterAll(() => stop?.(), 30_000);

  describe("(a) against a long-running sponsor (sponsor serve)", () => {
    const home = tempHome();
    const env = testEnv(home, { MANTLE_AA_RPC_URL: "" });
    const config = join(home, "sponsor.yaml");
    const abort = new AbortController();
    let serving: Promise<number> | undefined;
    let account: Address;
    let keyHash: Hex;
    const policy = join(home, "policy.json");
    const lowered = join(home, "lowered.json");
    const s = (args: string[], code: number) => step(home, env, args, code);
    /** The operator's environment holds the relayer key; `status` needs none. */
    const relayer = (op: string, code = 0) =>
      step(
        home,
        { ...env, CLI_FORK_RELAYER_KEY: RELAYER_KEY },
        ["sponsor", "relayer", op, "--config", config],
        code,
      );

    beforeAll(async () => {
      env.MANTLE_AA_RPC_URL = anvil;
      writeFileSync(policy, JSON.stringify(policyJson(500, 1000)));
      writeFileSync(lowered, JSON.stringify(policyJson(400, 900)));
      await s(["keys", "new", "--name", "root"], 0);
      account = readProfiles({ home: env.MANTLE_AA_HOME as string }).root?.account as Address;
      writeFileSync(
        config,
        [
          "chainId: 5003",
          `rpcUrl: ${anvil}`,
          "listen: { host: 127.0.0.1, port: 0 }",
          `database: ${join(home, "sponsor.sqlite")}`,
          `relayer: "${RELAYER.address}"`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
          "relayerKey: ${CLI_FORK_RELAYER_KEY}",
          "settleTimeoutSeconds: 5",
          "policy:",
          `  allowlist: ["${account}"]`,
          "  accountDailyGas: 20000000",
          '  maxFeePerRequestMnt: "0.5"',
          '  dailyBudgetMnt: "5"',
          '  managementReserveMnt: "1"',
        ].join("\n"),
      );
    }, 30_000);
    afterAll(async () => {
      abort.abort();
      await serving;
    }, 30_000);

    it("sponsor serve: listens and prints its URL and relayer", async () => {
      let out = "";
      serving = run(["sponsor", "serve", "--config", config, "--json"], {
        env: { ...env, CLI_FORK_RELAYER_KEY: RELAYER_KEY },
        stdout: (t) => {
          out += t;
        },
        stderr: () => undefined,
        signal: abort.signal,
      });
      const exited = serving.then((code) => {
        throw new Error(`sponsor serve exited with ${code}: ${out}`);
      });
      await Promise.race([until(() => out.includes("\n"), 30_000, "sponsor serve"), exited]);
      const served = JSON.parse(out);
      expect(served.result.relayer).toBe(RELAYER.address);
      expect(out).not.toContain(RELAYER_KEY.slice(2));
      env.MANTLE_AA_SPONSOR_URL = served.result.url;
      expect(normalize(served, home)).toMatchSnapshot();
    }, 60_000);

    it("account status: an undelegated account", async () => {
      expect((await s(["account", "status"], 0)).json).toMatchSnapshot();
    }, 60_000);

    it("account init: rejected for an account off the allowlist (20)", async () => {
      const other = tempHome();
      const otherEnv = testEnv(other, {
        MANTLE_AA_RPC_URL: anvil,
        MANTLE_AA_SPONSOR_URL: env.MANTLE_AA_SPONSOR_URL as string,
      });
      await step(other, otherEnv, ["keys", "new", "--name", "outsider"], 0);
      const r = await step(other, otherEnv, ["account", "init"], 20);
      expect(r.json.error).toMatchObject({ code: "SPONSOR_REJECTED", reason: "NOT_ALLOWLISTED" });
      expect(r.json).toMatchSnapshot();
    }, 60_000);

    it("account init --grant --agent: initialises with the first grant", async () => {
      const r = await s(["account", "init", "--grant", policy, "--agent", "trader"], 0);
      expect(r.json.result).toMatchObject({ state: "INITIALIZED", session: { profile: "trader" } });
      expect(r.json).toMatchSnapshot();
      keyHash = readProfiles({ home: env.MANTLE_AA_HOME as string }).trader?.keyHash as Hex;
      await mint(account, usd(100));
      // The sponsor paid: the account holds no MNT.
      expect(await client.getBalance({ address: account })).toBe(0n);
    }, 120_000);

    it("agent simulate: a passing batch (0)", async () => {
      const calls = [approve(usd(10)), await trade("buy", account, usd(10))];
      expect(
        (await s(["agent", "simulate", "--agent", "trader", "--calls", callsJson(calls)], 0)).json,
      ).toMatchSnapshot();
    }, 60_000);

    it("agent exec: approve + buy (0)", async () => {
      const calls = [approve(usd(10)), await trade("buy", account, usd(10))];
      const r = await s(["agent", "exec", "--agent", "trader", "--calls", callsJson(calls)], 0);
      expect(r.json).toMatchSnapshot();
      const receipt = await client.getTransactionReceipt({
        hash: r.stdout.match(/"hash":"(0x[0-9a-f]{64})"/)?.[1] as Hex,
      });
      expect(receipt.status).toBe("success");
      expect(receipt.from.toLowerCase()).toBe(RELAYER.address.toLowerCase());
    }, 60_000);

    it("agent exec: a call outside the allowlist (10)", async () => {
      const r = await s(
        ["agent", "exec", "--agent", "trader", "--calls", callsJson([transfer(1n)])],
        10,
      );
      expect(r.json).toMatchSnapshot();
    }, 60_000);

    it("agent simulate: an approve over the period cap (11)", async () => {
      const r = await s(
        ["agent", "simulate", "--agent", "trader", "--calls", callsJson([approve(usd(600))])],
        11,
      );
      expect(r.json).toMatchSnapshot();
    }, 60_000);

    it("agent exec: selling more than the session's inventory (12)", async () => {
      const calls = [await trade("sell", account, 10n ** 30n)];
      const r = await s(["agent", "exec", "--agent", "trader", "--calls", callsJson(calls)], 12);
      expect(r.json).toMatchSnapshot();
    }, 60_000);

    it("agent simulate: a batch the chain reverts (30)", async () => {
      // Within every cap, but the account holds 90 mUSD only.
      const calls = [approve(usd(200)), await trade("buy", account, usd(200))];
      const r = await s(
        ["agent", "simulate", "--agent", "trader", "--calls", callsJson(calls)],
        30,
      );
      expect(r.json).toMatchSnapshot();
    }, 60_000);

    it("session list", async () => {
      expect((await s(["session", "list"], 0)).json).toMatchSnapshot();
    }, 60_000);

    it("account exec --release: root execution releasing session inventory", async () => {
      const r = await s(
        [
          "account",
          "exec",
          "--calls",
          callsJson([approve(0n)]),
          "--release",
          `${keyHash},${MEME},1`,
        ],
        0,
      );
      expect(r.json).toMatchSnapshot();
    }, 60_000);

    it("session update: lowers the caps", async () => {
      const r = await s(["session", "update", "--agent", "trader", "--policy", lowered], 0);
      expect(r.json).toMatchSnapshot();
    }, 60_000);

    it("sponsor relayer status|bump|cancel on a pending transaction; busy (21) and cancelled (20)", async () => {
      await rpc("evm_setAutomine", [false]);
      let pending: Promise<CliResult> | undefined;
      try {
        pending = cli(
          ["agent", "exec", "--agent", "trader", "--calls", callsJson([approve(1n)])],
          env,
        );
        let status: CliResult | undefined;
        await until(
          async () => {
            status = await cli(["sponsor", "relayer", "status", "--config", config], env);
            return status.json?.result?.open?.[0]?.attempts?.length === 1;
          },
          30_000,
          "the pending relayer transaction",
        );
        expect(normalize(status?.json, home)).toMatchSnapshot("status");

        const busy = await s(["account", "exec", "--calls", callsJson([approve(0n)])], 21);
        expect(busy.json).toMatchSnapshot("busy");

        expect((await relayer("bump")).json).toMatchSnapshot("bump");
        expect((await relayer("cancel")).json).toMatchSnapshot("cancel");
        const attempts = (await relayer("status")).json.result.open[0].attempts;
        expect(attempts.map((a: { kind: string }) => a.kind)).toEqual(["submit", "bump", "cancel"]);
      } finally {
        await rpc("evm_mine");
        await rpc("evm_setAutomine", [true]);
      }
      const cancelled = await pending;
      expect(cancelled?.code).toBe(20);
      expect(cancelled?.json.error).toMatchObject({
        code: "SPONSOR_REJECTED",
        reason: "CANCELLED",
      });
      expect(normalize(cancelled?.json, home)).toMatchSnapshot("cancelled");
      expect((await relayer("status")).json.result.open).toEqual([]);
    }, 180_000);

    it("session grant: a new key and a new profile version", async () => {
      const r = await s(["session", "grant", "--agent", "trader", "--policy", policy], 0);
      expect(r.json.result).toMatchObject({ profile: "trader", previousProfile: "trader.v1" });
      expect(r.json).toMatchSnapshot();
      const profiles = readProfiles({ home: env.MANTLE_AA_HOME as string });
      expect(profiles["trader.v1"]?.keyHash).toBe(keyHash);
      expect(profiles.trader?.keyHash).not.toBe(keyHash);
      expect(profiles.trader?.keyfile).not.toBe(profiles["trader.v1"]?.keyfile);
      expect((await s(["keys", "list"], 0)).json).toMatchSnapshot();
    }, 60_000);

    it("session revoke, then agent exec with the revoked key (13)", async () => {
      expect((await s(["session", "revoke", "--agent", "trader"], 0)).json).toMatchSnapshot();
      const r = await s(
        ["agent", "exec", "--agent", "trader", "--calls", callsJson([approve(1n)])],
        13,
      );
      expect(r.json).toMatchSnapshot();
      // The previous version's key is untouched.
      await s(
        ["agent", "simulate", "--agent", "trader.v1", "--calls", callsJson([approve(1n)])],
        0,
      );
    }, 120_000);

    it("account status: an initialised account with its sessions", async () => {
      expect((await s(["account", "status"], 0)).json).toMatchSnapshot();
    }, 60_000);
  });

  describe("(b) embedded (MANTLE_AA_EMBEDDED_RELAYER=1)", () => {
    const home = tempHome();
    const env = testEnv(home, {
      MANTLE_AA_EMBEDDED_RELAYER: "1",
      MANTLE_AA_RELAYER_KEY: EMBEDDED_RELAYER_KEY,
    });
    const s = (args: string[], code: number) => step(home, env, args, code);

    it("keys new → account init --grant --agent → agent simulate → agent exec → session revoke", async () => {
      env.MANTLE_AA_RPC_URL = anvil;
      const policy = join(home, "policy.json");
      writeFileSync(policy, JSON.stringify(policyJson(500, 1000)));
      await s(["keys", "new", "--name", "root"], 0);
      const account = readProfiles({ home: env.MANTLE_AA_HOME as string }).root?.account as Address;
      const relayerTxs = () => client.getTransactionCount({ address: anvilAccount(3).address });
      const before = await relayerTxs();

      const init = await s(["account", "init", "--grant", policy, "--agent", "bot"], 0);
      expect(init.json.result).toMatchObject({ state: "INITIALIZED", session: { profile: "bot" } });
      const calls = callsJson([approve(42n)]);
      await s(["agent", "simulate", "--agent", "bot", "--calls", calls], 0);
      const exec = await s(["agent", "exec", "--agent", "bot", "--calls", calls], 0);
      expect(exec.json.result).toMatchObject({ success: true });
      const allowance = () =>
        client.readContract({
          address: USD,
          abi: mockUsdAbi,
          functionName: "allowance",
          args: [account, PAD],
        });
      expect(await allowance()).toBe(42n);
      await s(["session", "revoke", "--agent", "bot"], 0);
      // Revoke resets the allowances the session's policy allowed.
      expect(await allowance()).toBe(0n);
      await s(["agent", "exec", "--agent", "bot", "--calls", calls], 13);

      // The embedded relayer paid for init, exec and revoke; the account holds no MNT.
      expect((await relayerTxs()) - before).toBe(3);
      expect(await client.getBalance({ address: account })).toBe(0n);
    }, 180_000);
  });
});
