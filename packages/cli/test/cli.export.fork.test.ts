import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptKeystore, loadDeployments, readProfiles } from "@0xwh1sker/mantle-aa-sdk";
import { type Address, encodeFunctionData, erc20Abi, type Hex, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientFor, mockUsdAbi, startFork } from "../../sdk/test/account/fork.js";
import { type CliResult, cli, normalize, PASSWORD, tempHome, testEnv } from "./helpers.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const EXPORT_PASSWORD = "cli-test-export-password";
const RELAYER_KEY = toHex(
  mnemonicToAccount("test test test test test test test test test test test junk", {
    addressIndex: 3,
  }).getHdKey().privateKey as Uint8Array,
);

const policy = {
  quoteLimits: [{ token: USD, totalCap: "1000000000", periodCap: "500000000" }],
  periodLength: 86400,
  permissions: [{ target: USD, selector: "approve(address,uint256)", ruleKind: "ERC20_APPROVE" }],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
};
const approve = (amount: bigint) =>
  JSON.stringify([
    {
      to: USD,
      value: "0",
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAD, amount] }),
    },
  ]);

/** Fails with a message that names the file, never its contents. */
const decrypts = (file: string, password: string) => {
  try {
    return decryptKeystore(JSON.parse(readFileSync(file, "utf8")), password);
  } catch {
    return undefined;
  }
};
const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(!rpcUrl)("session export: an agent-only home on a Mantle Sepolia fork", () => {
  let anvil: string;
  let stop: () => void;
  let client: ReturnType<typeof clientFor>;
  /** The root's home and the exported, agent-only one. */
  const home = tempHome();
  const env = testEnv(home, {
    MANTLE_AA_EMBEDDED_RELAYER: "1",
    MANTLE_AA_RELAYER_KEY: RELAYER_KEY,
    MANTLE_AA_EXPORT_PASSWORD: EXPORT_PASSWORD,
  });
  const rootHome = env.MANTLE_AA_HOME as string;
  const agentDir = tempHome("mantle-aa-agent-");
  const out = join(agentDir, ".mantle-aa");
  // The agent's environment: its home and its password, never the root's.
  const agentEnv = testEnv(agentDir, {
    MANTLE_AA_KEYSTORE_PASSWORD: EXPORT_PASSWORD,
    MANTLE_AA_EMBEDDED_RELAYER: "1",
    MANTLE_AA_RELAYER_KEY: RELAYER_KEY,
  });
  const policyFile = join(home, "policy.json");
  let account: Address;
  /** The agent's private key, only to prove that no output carries it. */
  let agentKey: Hex;

  async function step(
    e: NodeJS.ProcessEnv,
    args: string[],
    code: number,
    options: { defaultScrypt?: boolean } = {},
  ): Promise<CliResult> {
    const result = await cli(args, e, options);
    const output = result.stdout + result.stderr;
    for (const secret of [PASSWORD, EXPORT_PASSWORD, RELAYER_KEY.slice(2), agentKey?.slice(2)]) {
      if (secret) expect(output.includes(secret), "an output carries a secret").toBe(false);
    }
    expect(result.code, `${args.slice(0, 2).join(" ")}: ${result.json?.error?.message}`).toBe(code);
    if (code) expect(result.json).toMatchObject({ ok: false, exitCode: code });
    return result;
  }
  const s = (args: string[], code: number) => step(env, args, code);
  const a = (args: string[], code: number) => step(agentEnv, args, code);

  beforeAll(async () => {
    ({ url: anvil, stop } = await startFork(rpcUrl as string));
    client = clientFor(anvil);
    env.MANTLE_AA_RPC_URL = anvil;
    agentEnv.MANTLE_AA_RPC_URL = anvil;
    writeFileSync(policyFile, JSON.stringify(policy));
    await s(["keys", "new", "--name", "root"], 0);
    account = readProfiles({ home: rootHome }).root?.account as Address;
    await s(["account", "init", "--grant", policyFile, "--agent", "bot"], 0);
    const source = readProfiles({ home: rootHome }).bot;
    agentKey = decrypts(join(rootHome, "keys", source?.keyfile as string), PASSWORD) as Hex;
    expect(agentKey).toBeDefined();
  }, 180_000);
  afterAll(() => stop?.(), 30_000);

  it("writes a home with only the agent's key and profile, under the export password", async () => {
    // The real command: geth's scrypt cost, not the tests' lowered one.
    const r = await step(env, ["session", "export", "--agent", "bot", "--out", out], 0, {
      defaultScrypt: true,
    });
    const source = readProfiles({ home: rootHome }).bot;
    const exported = { account, keyHash: source?.keyHash, keyfile: "bot.json", role: "agent" };
    expect(r.json.result).toEqual({ home: out, profile: "bot", ...exported });
    expect(normalize(r.json, agentDir)).toMatchSnapshot();

    // No root key, no root profile: exactly one key and one agent profile.
    expect(readdirSync(out).sort()).toEqual(["keys", "profiles.json"]);
    expect(readdirSync(join(out, "keys"))).toEqual(["bot.json"]);
    expect(readProfiles({ home: out })).toEqual({ bot: exported });
    // The keystore writer's modes.
    expect([mode(out), mode(join(out, "keys"))]).toEqual([0o700, 0o700]);
    expect([mode(join(out, "profiles.json")), mode(join(out, "keys", "bot.json"))]).toEqual([
      0o600, 0o600,
    ]);

    const file = join(out, "keys", "bot.json");
    const keystore = JSON.parse(readFileSync(file, "utf8"));
    expect(keystore.crypto.kdfparams).toMatchObject({ n: 262144, r: 8, p: 1 });
    expect(decrypts(file, PASSWORD), "decrypts with the source password").toBeUndefined();
    const key = decrypts(file, EXPORT_PASSWORD);
    expect(key !== undefined && key === agentKey, "the export password opens the same key").toBe(
      true,
    );
    expect(privateKeyToAddress(agentKey).slice(2).toLowerCase()).toBe(keystore.address);
  }, 120_000);

  it("agent simulate and agent exec succeed from the exported home", async () => {
    await a(["agent", "simulate", "--agent", "bot", "--calls", approve(42n)], 0);
    const exec = await a(["agent", "exec", "--agent", "bot", "--calls", approve(42n)], 0);
    expect(exec.json.result).toMatchObject({ success: true });
    const allowance = await client.readContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "allowance",
      args: [account, PAD],
    });
    expect(allowance).toBe(42n);
  }, 120_000);

  it("every account and session management command fails there with a usage error (1)", async () => {
    const commands = [
      ["account", "init"],
      ["account", "status"],
      ["account", "exec", "--calls", approve(0n)],
      ["account", "panic"],
      ["session", "grant", "--agent", "bot2", "--policy", policyFile],
      ["session", "update", "--agent", "bot", "--policy", policyFile],
      ["session", "revoke", "--agent", "bot"],
      ["session", "list"],
      ["session", "export", "--agent", "bot", "--out", join(agentDir, "again")],
    ];
    const shown: Record<string, unknown> = {};
    for (const args of commands) {
      const r = await a(args, 1);
      expect(r.json.error.code).toBe("USAGE");
      expect(r.json.error.message).toMatch(/^no root profile/);
      shown[args.slice(0, 2).join(" ")] = { exitCode: r.code, message: r.json.error.message };
    }
    expect(normalize(shown, agentDir)).toMatchSnapshot();
  }, 120_000);

  it("re-export replaces that one profile", async () => {
    await s(["session", "export", "--agent", "bot", "--out", out], 0);
    expect(Object.keys(readProfiles({ home: out }))).toEqual(["bot"]);
    expect(readdirSync(join(out, "keys"))).toEqual(["bot.json"]);
    expect(decrypts(join(out, "keys", "bot.json"), EXPORT_PASSWORD) === agentKey).toBe(true);
  }, 60_000);

  it("refuses --out with a root profile, a non-agent --agent and a revoked key", async () => {
    const before = readFileSync(join(out, "keys", "bot.json"), "utf8");
    const refusals: Record<string, unknown> = {};
    const refuse = async (what: string, args: string[], code: number) => {
      const r = await s(["session", "export", ...args], code);
      refusals[what] = normalize({ exitCode: r.code, error: r.json.error }, home);
    };
    await refuse("--out holds a root profile", ["--agent", "bot", "--out", rootHome], 1);
    await refuse("--agent is a root profile", ["--agent", "root", "--out", out], 1);
    await refuse("--agent is unknown", ["--agent", "ghost", "--out", out], 1);

    await s(["session", "grant", "--agent", "gone", "--policy", policyFile], 0);
    await s(["session", "revoke", "--agent", "gone"], 0);
    await refuse("a revoked key", ["--agent", "gone", "--out", out], 13);
    expect(refusals).toMatchSnapshot();

    // Nothing was written: the agent's home is unchanged, and the root's still holds its root.
    expect(Object.keys(readProfiles({ home: out }))).toEqual(["bot"]);
    expect(readFileSync(join(out, "keys", "bot.json"), "utf8")).toBe(before);
    expect(readProfiles({ home: rootHome }).root?.role).toBe("root");
  }, 180_000);
});
