import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProfiles, saveProfile } from "@mantle-aa/sdk";
import { privateKeyToAddress } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { cli, normalize, PASSWORD, tempHome, testEnv } from "./helpers.js";

// Commands that fail before any chain access, and the keystore commands, which need none.
// The chain commands' success shapes are snapshotted by cli.fork.test.ts.

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CREDENTIALED_RPC = "http://user:rpc-password@127.0.0.1:1/v1/rpc-api-key";

let home: string;
let env: NodeJS.ProcessEnv;
const snap = async (args: string[], e = env, stdin?: string) => {
  const r = await cli(args, e, stdin === undefined ? {} : { stdin });
  // Nothing printed ever carries the password, a key or an RPC URL credential.
  for (const secret of [PASSWORD, KEY, KEY.slice(2), "rpc-password", "rpc-api-key"]) {
    expect(r.stdout + r.stderr).not.toContain(secret);
  }
  return { code: r.code, json: normalize(r.json, home) };
};

beforeEach(() => {
  home = tempHome();
  env = testEnv(home);
});

describe("keys", () => {
  it("new: creates an encrypted key and its root profile", async () => {
    const out = await snap(["keys", "new", "--name", "root"]);
    expect(out).toMatchSnapshot();
    const file = join(home, ".mantle-aa", "keys", "root.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 3 });
    expect((await snap(["keys", "new", "--name", "root"])).code).toBe(1);
  });

  it("new: fails without a password when no terminal can prompt", async () => {
    const { MANTLE_AA_KEYSTORE_PASSWORD: _, ...noPassword } = env;
    expect(await snap(["keys", "new", "--name", "root"], noPassword)).toMatchSnapshot();
  });

  it("new: refuses an existing profile name", async () => {
    await snap(["keys", "new", "--name", "root"]);
    expect(await snap(["keys", "new", "--name", "root"])).toMatchSnapshot();
  });

  it("import: reads the key from stdin, never from argv", async () => {
    const out = await snap(["keys", "import", "--name", "imported"], env, `${KEY}\n`);
    expect(out.code).toBe(0);
    const result = (await cli(["keys", "list"], env)).json.result;
    expect(result.profiles[0]).toMatchObject({
      name: "imported",
      account: privateKeyToAddress(KEY),
      role: "root",
    });
    expect(out).toMatchSnapshot();
  });

  it("import: rejects malformed input without echoing it", async () => {
    const out = await snap(["keys", "import", "--name", "x"], env, `${KEY.slice(0, 40)}\n`);
    expect(out).toMatchSnapshot();
    expect(JSON.stringify(out)).not.toContain(KEY.slice(2, 40));
  });

  it("list: keys and profiles", async () => {
    await snap(["keys", "new", "--name", "root"]);
    await snap(["keys", "import", "--name", "imported"], env, KEY);
    expect(await snap(["keys", "list"])).toMatchSnapshot();
  });
});

describe("chain commands before any chain access", () => {
  const POLICY = {
    periodLength: 86400,
    quoteLimits: [],
    permissions: [],
    trustedSpenders: [],
    maxDeadlineWindow: 600,
  };
  let policy: string;
  beforeEach(async () => {
    await snap(["keys", "new", "--name", "root"]);
    policy = join(home, "policy.json");
    writeFileSync(policy, JSON.stringify(POLICY));
  });
  const calls = '[{"to":"0x0000000000000000000000000000000000000001"}]';

  it.each([
    ["account init", ["account", "init"]],
    ["account status", ["account", "status"]],
    ["account exec", ["account", "exec", "--calls", calls]],
    ["session grant", ["session", "grant", "--agent", "a", "--policy", "policy.json"]],
    ["session list", ["session", "list"]],
  ])("%s: no RPC URL", async (_, args) => {
    expect(await snap(args.map((a) => (a === "policy.json" ? policy : a)))).toMatchSnapshot();
  });

  it("account init: --grant without --agent", async () => {
    expect(await snap(["account", "init", "--grant", "policy.json"])).toMatchSnapshot();
  });

  it("account init: a policy file with an unknown key", async () => {
    writeFileSync(policy, JSON.stringify({ ...POLICY, maxValue: "1" }));
    expect(await snap(["account", "init", "--grant", policy, "--agent", "a"])).toMatchSnapshot();
  });

  it("account status: an unreachable RPC; its URL never shows", async () => {
    expect(await snap(["account", "status", "--rpc-url", CREDENTIALED_RPC])).toMatchSnapshot();
  });

  it("account status: two root profiles need --root", async () => {
    await snap(["keys", "import", "--name", "second"], env, KEY);
    expect(await snap(["account", "status", "--rpc-url", CREDENTIALED_RPC])).toMatchSnapshot();
    expect(
      await snap(["account", "status", "--root", "nope", "--rpc-url", CREDENTIALED_RPC]),
    ).toMatchSnapshot();
  });

  it("account exec: malformed calls and release tuples", async () => {
    expect(await snap(["account", "exec", "--calls", "[{"])).toMatchSnapshot();
    expect(await snap(["account", "exec", "--calls", '[{"to":"0x1"}]'])).toMatchSnapshot();
    expect(
      await snap(["account", "exec", "--calls", calls, "--release", "0x12,0x34"]),
    ).toMatchSnapshot();
  });

  it("account panic: not available in this version", async () => {
    expect(await snap(["account", "panic", "--self-pay"])).toMatchSnapshot();
  });

  it.each([
    ["session update", ["session", "update", "--agent", "ghost", "--policy", "policy.json"]],
    ["session revoke", ["session", "revoke", "--agent", "ghost"]],
    ["agent simulate", ["agent", "simulate", "--agent", "ghost", "--calls", calls]],
    ["agent exec", ["agent", "exec", "--agent", "ghost", "--calls", calls]],
  ])("%s: an unknown agent profile", async (_, args) => {
    const fixed = args.map((a) => (a === "policy.json" ? policy : a));
    expect(await snap(fixed)).toMatchSnapshot();
  });

  it("session update / revoke and agent commands refuse a root profile as agent", async () => {
    expect(await snap(["session", "revoke", "--agent", "root"])).toMatchSnapshot();
  });

  it("session grant: archives the agent's current profile once, even when the grant is retried", async () => {
    const options = { home: env.MANTLE_AA_HOME as string };
    const trader = {
      account: readProfiles(options).root?.account as `0x${string}`,
      keyHash: `0x${"22".repeat(32)}` as const,
      keyfile: "trader-old.json",
      role: "agent" as const,
    };
    saveProfile("trader", trader, options);
    const grant = ["session", "grant", "--agent", "trader", "--policy", policy];
    for (let i = 0; i < 2; i++) {
      expect((await snap([...grant, "--rpc-url", CREDENTIALED_RPC])).code).toBe(1);
    }
    const profiles = readProfiles(options);
    expect(Object.keys(profiles).sort()).toEqual(["root", "trader", "trader.v1"]);
    expect(profiles["trader.v1"]).toEqual(trader);
    // A root profile is never replaced by an agent's.
    expect(
      await snap([
        "session",
        "grant",
        "--agent",
        "root",
        "--policy",
        policy,
        "--rpc-url",
        CREDENTIALED_RPC,
      ]),
    ).toMatchSnapshot();
  });

  it("agent exec --via bundler: not available in this version", async () => {
    expect(
      await snap(["agent", "exec", "--agent", "a", "--calls", calls, "--via", "bundler"]),
    ).toMatchSnapshot();
    expect(
      (await snap(["agent", "exec", "--agent", "a", "--calls", calls, "--via", "x"])).code,
    ).toBe(1);
  });
});

describe("sponsor", () => {
  it("serve: --config is required", async () => {
    expect(await snap(["sponsor", "serve"])).toMatchSnapshot();
  });

  it("serve: an invalid config", async () => {
    const config = join(home, "sponsor.yaml");
    writeFileSync(config, "chainId: 5003\nrpcUrl: http://127.0.0.1:1\n");
    expect(await snap(["sponsor", "serve", "--config", config])).toMatchSnapshot();
  });

  it.each(["status", "bump", "cancel"])("relayer %s: --config is required", async (op) => {
    expect(await snap(["sponsor", "relayer", op])).toMatchSnapshot();
  });
});

describe("command line", () => {
  it("unknown commands and options are usage errors (exit 1)", async () => {
    expect(await snap(["account", "frobnicate"])).toMatchSnapshot();
    expect(await snap(["keys", "list", "--bogus"])).toMatchSnapshot();
    expect(await snap(["keys", "list", "extra"])).toMatchSnapshot();
  });

  it("--help prints the usage and exits 0", async () => {
    const r = await cli(["--help"], env, { json: false });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mantle-aa <command>");
  });

  it("without --json, an error is one line on stderr and stdout stays empty", async () => {
    await snap(["keys", "new", "--name", "root"]);
    const r = await cli(["account", "status"], env, { json: false });
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.stderr).toBe("error: no RPC URL: pass --rpc-url or set MANTLE_AA_RPC_URL\n");
  });
});
