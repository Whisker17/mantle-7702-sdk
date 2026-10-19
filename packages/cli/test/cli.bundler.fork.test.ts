import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Call, launchpadAbi, loadDeployments, readProfiles } from "@mantle-aa/sdk";
import { SponsorStore } from "@mantle-aa/sponsor";
import { type Address, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BundlerStack,
  setPaymasterSigner,
  startBundlerStack,
  upstreamSummary,
} from "../../../e2e/bundler/harness.js";
import { mockUsdAbi, THIRD_PARTY, walletFor } from "../../sdk/test/account/fork.js";
import { run } from "../src/index.js";
import { type CliResult, cli, normalize, PASSWORD, tempHome, testEnv } from "./helpers.js";

// `--via bundler`: the CLI's root management and agent commands as ERC-4337 UserOperations through
// the pinned, patched Alto in safe mode on an anvil fork of Mantle Sepolia (e2e/bundler/harness.ts),
// sponsored by the sponsor's ERC-7677 paymaster service; skipped when MANTLE_SEPOLIA_RPC_URL is
// unset. The deployed VerifyingPaymaster's signer is swapped on the fork for a key the sponsor holds.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const usd = (n: number) => BigInt(n) * 10n ** 6n;
const SIGNER_KEY = generatePrivateKey();
const EMBEDDED_RELAYER_KEY = generatePrivateKey();

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

/** Polls `check` every 200 ms until it holds; fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(200);
  }
}

describe.skipIf(!rpcUrl)(
  "mantle-aa --via bundler through strict Alto on a Mantle Sepolia fork",
  () => {
    let stack: BundlerStack;
    const now = async () => (await stack.client.getBlock()).timestamp;
    const buy = async (account: Address, amount: bigint): Promise<Call> => ({
      to: PAD,
      value: 0n,
      data: encodeFunctionData({
        abi: launchpadAbi,
        functionName: "buy",
        args: [MEME, amount, 0n, (await now()) + 60n, account],
      }),
    });
    async function mint(account: Address, amount: bigint) {
      const hash = await walletFor(stack.rpcUrl, THIRD_PARTY).writeContract({
        address: USD,
        abi: mockUsdAbi,
        functionName: "mint",
        args: [account, amount],
      });
      await stack.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    }
    /** The transaction a `--json` result names: a bundle Alto sent to the EntryPoint. */
    async function bundle(r: CliResult, type?: "eip7702") {
      const hash = r.stdout.match(/"hash":"(0x[0-9a-f]{64})"/)?.[1] as Hex;
      const tx = await stack.client.getTransaction({ hash });
      expect(stack.bundler.executors).toContain(tx.from.toLowerCase());
      expect(tx.to?.toLowerCase()).toBe(book.entryPoint.toLowerCase());
      if (type) expect(tx.type).toBe(type);
      else expect(tx.type).not.toBe("eip7702");
      const receipt = await stack.client.getTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
    }

    /** Runs a step, checks its exit code and that its output carries no secret or local URL. */
    async function step(
      home: string,
      env: NodeJS.ProcessEnv,
      args: string[],
      code: number,
    ): Promise<CliResult> {
      const started = Date.now();
      const result = await cli(args, env);
      const took = Date.now() - started;
      console.log(
        `[diag-step] ${args.slice(0, 3).join(" ")} ${took}ms ${upstreamSummary(stack.upstream, started)}`,
      );
      if (took > 15_000) {
        console.log(`[diag-slow] alto:\n${stack.bundler.timeline(started)}`);
      }
      const output = result.stdout + result.stderr;
      expect(output).not.toMatch(/127\.0\.0\.1/);
      for (const secret of [PASSWORD, SIGNER_KEY.slice(2), EMBEDDED_RELAYER_KEY.slice(2)]) {
        expect(output).not.toContain(secret);
      }
      expect(result.code, `${args.join(" ")}: ${result.stdout}`).toBe(code);
      expect(result.json.ok).toBe(code === 0);
      if (code) expect(result.json.exitCode).toBe(code);
      result.json = normalize(result.json, home);
      return result;
    }

    beforeAll(async () => {
      const t0 = Date.now();
      stack = await startBundlerStack(rpcUrl as string);
      console.log(`[diag-setup] stack ${Date.now() - t0}ms ${upstreamSummary(stack.upstream, t0)}`);
      await setPaymasterSigner(
        stack.client,
        book.verifyingPaymaster,
        privateKeyToAddress(SIGNER_KEY),
      );
    }, 360_000);
    afterAll(async () => {
      await stack?.stop();
    }, 30_000);

    describe("(a) against a long-running sponsor (sponsor serve with a paymaster signer key)", () => {
      const home = tempHome();
      const env = testEnv(home);
      const config = join(home, "sponsor.yaml");
      const database = join(home, "sponsor.sqlite");
      const abort = new AbortController();
      let serving: Promise<number> | undefined;
      let account: Address;
      const policy = join(home, "policy.json");
      const lowered = join(home, "lowered.json");
      const s = (args: string[], code: number) =>
        step(home, env, [...args, "--via", "bundler"], code);
      /**
       * The sponsor holds the account busy until its reconciliation loop (1 s) sees the op's
       * UserOperationEvent; the next command waits for that, as an agent would on SPONSOR_BUSY.
       */
      const settled = () => {
        const store = new SponsorStore(database);
        return until(
          () => store.entries(["submitted"]).length === 0,
          20_000,
          "the sponsorship to settle",
        ).finally(() => store.close());
      };

      beforeAll(async () => {
        env.MANTLE_AA_RPC_URL = stack.rpcUrl;
        env.MANTLE_AA_BUNDLER_URL = stack.bundler.url;
        writeFileSync(policy, JSON.stringify(policyJson(500, 1000)));
        writeFileSync(lowered, JSON.stringify(policyJson(400, 900)));
        await step(home, env, ["keys", "new", "--name", "root"], 0);
        account = readProfiles({ home: env.MANTLE_AA_HOME as string }).root?.account as Address;
        writeFileSync(
          config,
          [
            "chainId: 5003",
            `rpcUrl: ${stack.rpcUrl}`,
            "listen: { host: 127.0.0.1, port: 0 }",
            `database: ${database}`,
            // No relayer key: this sponsor only signs paymaster data; `relayer` names it.
            `relayer: "${privateKeyToAddress(generatePrivateKey())}"`,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
            "paymasterSignerKey: ${CLI_BUNDLER_FORK_SIGNER_KEY}",
            "policy:",
            `  allowlist: ["${account}"]`,
            "  accountDailyGas: 20000000",
            // The init op with the first grant bounds above 0.05 MNT.
            '  maxFeePerRequestMnt: "1"',
            '  dailyBudgetMnt: "5"',
            '  managementReserveMnt: "2"',
          ].join("\n"),
        );
        let out = "";
        serving = run(["sponsor", "serve", "--config", config, "--json"], {
          env: { ...env, CLI_BUNDLER_FORK_SIGNER_KEY: SIGNER_KEY },
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
        env.MANTLE_AA_SPONSOR_URL = JSON.parse(out).result.url;
      }, 60_000);
      afterAll(async () => {
        abort.abort();
        await serving;
      }, 30_000);

      it("account init: rejected by the paymaster service for an account off the allowlist (20)", async () => {
        const other = tempHome();
        const otherEnv = testEnv(other, {
          MANTLE_AA_RPC_URL: stack.rpcUrl,
          MANTLE_AA_SPONSOR_URL: env.MANTLE_AA_SPONSOR_URL as string,
          MANTLE_AA_BUNDLER_URL: stack.bundler.url,
        });
        await step(other, otherEnv, ["keys", "new", "--name", "outsider"], 0);
        const r = await step(other, otherEnv, ["account", "init", "--via", "bundler"], 20);
        expect(r.json.error).toMatchObject({ code: "SPONSOR_REJECTED", reason: "NOT_ALLOWLISTED" });
        expect(r.json).toMatchSnapshot();
      }, 60_000);

      it("account init --grant --agent: the root's init UserOp (eip7702Auth) with the first grant", async () => {
        const r = await s(["account", "init", "--grant", policy, "--agent", "trader"], 0);
        expect(r.json.result).toMatchObject({
          state: "INITIALIZED",
          session: { profile: "trader" },
        });
        expect(r.json).toMatchSnapshot();
        await bundle(r, "eip7702");
        // The paymaster paid: the account holds no MNT.
        expect(await stack.client.getBalance({ address: account })).toBe(0n);
        await settled();
        await mint(account, usd(100));
      }, 120_000);

      it("agent exec: approve + buy as a session UserOp (0)", async () => {
        const calls = [approve(usd(10)), await buy(account, usd(10))];
        const r = await s(["agent", "exec", "--agent", "trader", "--calls", callsJson(calls)], 0);
        expect(r.json.result).toMatchObject({ success: true });
        expect(r.json).toMatchSnapshot();
        await bundle(r);
        await settled();
      }, 120_000);

      it("agent exec: no bundler URL is a usage error (1)", async () => {
        const r = await step(
          home,
          { ...env, MANTLE_AA_BUNDLER_URL: "" },
          [
            "agent",
            "exec",
            "--agent",
            "trader",
            "--calls",
            callsJson([approve(1n)]),
            "--via",
            "bundler",
          ],
          1,
        );
        expect(r.json).toMatchSnapshot();
      }, 60_000);

      it("account exec: a root UserOp without eip7702Auth (0)", async () => {
        const r = await s(["account", "exec", "--calls", callsJson([approve(0n)])], 0);
        expect(r.json).toMatchSnapshot();
        await bundle(r);
        await settled();
      }, 120_000);

      it("account exec: a reverting batch is refused by the sponsor's own simulation (20)", async () => {
        // The account holds 90 mUSD. The sponsor simulates before it signs anything, so the op
        // never reaches the bundler.
        const transfer: Call = {
          to: USD,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [PAD, usd(1_000_000)],
          }),
        };
        const r = await s(["account", "exec", "--calls", callsJson([transfer])], 20);
        // No snapshot: the message carries the revert data, with the account's address in it.
        expect(r.json.error).toMatchObject({
          code: "SPONSOR_REJECTED",
          type: "SponsorRejectedError",
          reason: "SIMULATION_FAILED",
        });
      }, 120_000);

      it("session grant / update / revoke, then agent exec with the revoked key (13)", async () => {
        const grant = await s(["session", "grant", "--agent", "second", "--policy", policy], 0);
        expect(grant.json).toMatchSnapshot("grant");
        await bundle(grant);
        await settled();
        const update = await s(["session", "update", "--agent", "trader", "--policy", lowered], 0);
        expect(update.json).toMatchSnapshot("update");
        await bundle(update);
        await settled();
        const revoke = await s(["session", "revoke", "--agent", "trader"], 0);
        expect(revoke.json).toMatchSnapshot("revoke");
        await bundle(revoke);
        await settled();
        const r = await s(
          ["agent", "exec", "--agent", "trader", "--calls", callsJson([approve(1n)])],
          13,
        );
        expect(r.json).toMatchSnapshot("revoked");
        expect(await stack.client.getBalance({ address: account })).toBe(0n);
      }, 240_000);
    });

    describe("(b) embedded (MANTLE_AA_EMBEDDED_RELAYER=1 and MANTLE_AA_PAYMASTER_SIGNER_KEY)", () => {
      const home = tempHome();
      const env = testEnv(home, {
        MANTLE_AA_EMBEDDED_RELAYER: "1",
        MANTLE_AA_RELAYER_KEY: EMBEDDED_RELAYER_KEY,
      });
      const s = (args: string[], code: number) =>
        step(home, env, [...args, "--via", "bundler", "--bundler-url", stack.bundler.url], code);

      it("without the paymaster signer key, --via bundler is a usage error (1)", async () => {
        env.MANTLE_AA_RPC_URL = stack.rpcUrl;
        await step(home, env, ["keys", "new", "--name", "root"], 0);
        expect((await s(["account", "init"], 1)).json).toMatchSnapshot();
      }, 60_000);

      it("account init --grant --agent → agent exec → session revoke → agent exec (13), back to back", async () => {
        env.MANTLE_AA_PAYMASTER_SIGNER_KEY = SIGNER_KEY;
        const policy = join(home, "policy.json");
        writeFileSync(policy, JSON.stringify(policyJson(500, 1000)));
        const account = readProfiles({ home: env.MANTLE_AA_HOME as string }).root
          ?.account as Address;

        // Each command starts the embedded sponsor, which settles what the previous one left open
        // before it listens: no wait between the steps.
        const init = await s(["account", "init", "--grant", policy, "--agent", "bot"], 0);
        expect(init.json.result).toMatchObject({
          state: "INITIALIZED",
          session: { profile: "bot" },
        });
        await bundle(init, "eip7702");
        const calls = callsJson([approve(42n)]);
        const exec = await s(["agent", "exec", "--agent", "bot", "--calls", calls], 0);
        expect(exec.json.result).toMatchObject({ success: true });
        await bundle(exec);
        const allowance = () =>
          stack.client.readContract({
            address: USD,
            abi: mockUsdAbi,
            functionName: "allowance",
            args: [account, PAD],
          });
        expect(await allowance()).toBe(42n);
        await bundle(await s(["session", "revoke", "--agent", "bot"], 0));
        expect(await allowance()).toBe(0n);
        await s(["agent", "exec", "--agent", "bot", "--calls", calls], 13);

        // The paymaster paid for everything: the relayer sent nothing, the account holds no MNT.
        const relayer = privateKeyToAddress(EMBEDDED_RELAYER_KEY);
        expect(await stack.client.getTransactionCount({ address: relayer })).toBe(0);
        expect(await stack.client.getBalance({ address: account })).toBe(0n);
      }, 240_000);
    });
  },
);
