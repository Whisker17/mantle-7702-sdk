import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  AgentSession,
  decryptKeystore,
  type Profile,
  readProfiles,
  saveKey,
  saveProfile,
  secp256k1KeyHash,
} from "@0xwh1sker/mantle-aa-sdk";
import { type Address, getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, normalize, PASSWORD, tempHome, testEnv } from "./helpers.js";

// session export's destination: what it accepts, what it refuses, and that a refusal or a failure
// changes nothing. The on-chain key check is stubbed; cli.export.fork.test.ts runs it for real.

/** Makes the next rename onto `fault.renameTo` fail, to test the export's rollback. */
const fault = vi.hoisted(() => ({ renameTo: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof fs.renameSync = (from, to) => {
    if (to === fault.renameTo) {
      fault.renameTo = undefined;
      throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
    }
    fs.renameSync(from, to);
  };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});

const EXPORT_PASSWORD = "cli-test-export-password";
const SCRYPT = { n: 1024, r: 8, p: 1 };

let home: string;
let source: string;
let out: string;
let env: NodeJS.ProcessEnv;
let account: Address;
const keys: Record<string, Hex> = {};

/** An agent profile `name` in the source home, with a real key (file `<name>-1.json`). */
function agent(name: string) {
  const key = generatePrivateKey();
  keys[name] = key;
  saveKey(`${name}-1`, key, { home: source, password: PASSWORD, scrypt: SCRYPT });
  const keyHash = secp256k1KeyHash(privateKeyToAddress(key));
  saveProfile(
    name,
    { account, keyHash, keyfile: `${name}-1.json`, role: "agent" },
    { home: source },
  );
}

const exportTo = async (name: string, dir: string, password = EXPORT_PASSWORD, scrypt = SCRYPT) => {
  const e = { ...env, MANTLE_AA_EXPORT_PASSWORD: password };
  const r = await cli(["session", "export", "--agent", name, "--out", dir], e, { scrypt });
  for (const secret of [PASSWORD, password, ...Object.values(keys).map((k) => k.slice(2))]) {
    expect(r.stdout + r.stderr).not.toContain(secret);
  }
  return { code: r.code, json: normalize(r.json, home), stderr: r.stderr };
};

/** Every entry under `dir` (links unfollowed) with its bytes or link target. */
function tree(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (path: string) => {
    const stat = lstatSync(path);
    const name = relative(dir, path) || ".";
    if (stat.isSymbolicLink()) entries[name] = `-> ${readlinkSync(path)}`;
    else if (stat.isDirectory()) {
      entries[name] = "dir";
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else entries[name] = readFileSync(path, "utf8");
  };
  walk(dir);
  return entries;
}

/** The key `dir`'s `name` keystore holds under `password`, undefined when it does not open. */
const opens = (dir: string, name: string, password: string) => {
  try {
    return decryptKeystore(
      JSON.parse(readFileSync(join(dir, "keys", `${name}.json`), "utf8")),
      password,
    );
  } catch {
    return undefined;
  }
};

/** `out` is exactly `name`'s export: one profile, one key, opening with `password`. */
function expectExport(dir: string, name: string, password = EXPORT_PASSWORD) {
  expect(readdirSync(dir).sort()).toEqual(["keys", "profiles.json"]);
  expect(readdirSync(join(dir, "keys"))).toEqual([`${name}.json`]);
  expect(readProfiles({ home: dir })).toEqual({
    [name]: {
      account,
      keyHash: readProfiles({ home: source })[name]?.keyHash,
      keyfile: `${name}.json`,
      role: "agent",
    },
  });
  expect(opens(dir, name, password) === keys[name], "the export password opens its key").toBe(true);
}

const refused = (message: RegExp) => ({
  code: 1,
  stderr: "",
  json: expect.objectContaining({
    error: expect.objectContaining({ code: "USAGE", message: expect.stringMatching(message) }),
  }),
});
const NOT_EXPORTABLE = /neither new, empty nor an earlier export of/;
const OVERLAPS = /is, holds or lies inside the root's home/;

beforeEach(async () => {
  // Canonical (macOS: /var -> /private/var), as the paths the export reports and renames onto.
  home = realpathSync.native(tempHome());
  env = testEnv(home, { MANTLE_AA_RPC_URL: "http://127.0.0.1:1" });
  source = env.MANTLE_AA_HOME as string;
  expect((await cli(["keys", "new", "--name", "root"], env)).code).toBe(0);
  account = getAddress(readProfiles({ home: source }).root?.account as Address);
  agent("bot");
  agent("eve");
  out = join(home, "agent-home");
  vi.spyOn(AgentSession.prototype, "simulate").mockResolvedValue(undefined);
});
afterEach(() => {
  fault.renameTo = undefined;
  vi.restoreAllMocks();
});

describe("session export: the destination", () => {
  it("writes a new or an empty directory, and nothing beside it", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    expectExport(out, "bot");
    const empty = join(home, "empty");
    mkdirSync(empty, { mode: 0o755 });
    expect((await exportTo("bot", empty)).code).toBe(0);
    expectExport(empty, "bot");
    expect(statSync(empty).mode & 0o777).toBe(0o700);
    expect(readdirSync(home).sort()).toEqual([".mantle-aa", "agent-home", "empty"]);
  });

  it("re-export into an earlier export of the same agent replaces exactly its key and profile", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    expect((await exportTo("bot", out, "a-new-export-password")).code).toBe(0);
    expectExport(out, "bot", "a-new-export-password");
    expect(opens(out, "bot", EXPORT_PASSWORD), "the old password no longer opens it").toBe(
      undefined,
    );
    expect(readdirSync(home).sort()).toEqual([".mantle-aa", "agent-home"]);
  });

  it("refuses to export a second agent into an export, and changes nothing", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    const before = tree(out);
    expect(await exportTo("eve", out)).toEqual(refused(NOT_EXPORTABLE));
    expect(tree(out)).toEqual(before);
  });

  it("refuses anything else in the directory: other files, profiles, keys or links", async () => {
    const cases: Record<string, (dir: string) => void> = {
      "a stray file": (dir) => writeFileSync(join(dir, "notes.txt"), "x"),
      "a stray key": (dir) => writeFileSync(join(dir, "keys", "root.json"), "{}"),
      "a second profile": (dir) =>
        saveProfile("eve", readProfiles({ home: dir }).bot as Profile, { home: dir }),
      "a profile of another account": (dir) => {
        const other = privateKeyToAddress(generatePrivateKey());
        const bot = readProfiles({ home: dir }).bot as Profile;
        saveProfile("bot", { ...bot, account: other }, { home: dir });
      },
      "a key that is a link": (dir) => {
        const file = join(dir, "keys", "bot.json");
        const copy = join(home, `${relative(home, dir)}.json`);
        writeFileSync(copy, readFileSync(file));
        rmSync(file);
        symlinkSync(copy, file);
      },
      "a home that is a link": (dir) => {
        const real = `${dir}-real`;
        mkdirSync(real);
        symlinkSync(real, dir);
      },
    };
    for (const [what, plant] of Object.entries(cases)) {
      const dir = join(home, what.replaceAll(" ", "-"));
      if (what !== "a home that is a link") expect((await exportTo("bot", dir)).code).toBe(0);
      plant(dir);
      const before = tree(dir);
      expect(await exportTo("bot", dir), what).toEqual(refused(NOT_EXPORTABLE));
      expect(tree(dir), what).toEqual(before);
    }
  });

  it("refuses an --out that is, holds or lies inside the root's home, also through a link", async () => {
    const before = tree(home);
    for (const dir of [home, source, join(source, "agent"), join(source, "keys")]) {
      expect(await exportTo("bot", dir), dir).toEqual(refused(OVERLAPS));
    }
    expect(tree(home)).toEqual(before);
    symlinkSync(source, join(home, "alias"));
    for (const dir of [join(home, "alias"), join(home, "alias", "agent")]) {
      expect(await exportTo("bot", dir), dir).toEqual(refused(OVERLAPS));
    }
    expect(tree(home)).toEqual({ ...before, alias: `-> ${source}` });
  });

  it("a planted profiles.json.tmp link to a source file is refused; the source's bytes stay", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    const rootKey = join(source, "keys", "root.json");
    const sourceBefore = tree(source);
    symlinkSync(rootKey, join(out, "profiles.json.tmp"));
    const before = tree(out);
    expect(await exportTo("bot", out)).toEqual(refused(NOT_EXPORTABLE));
    expect(tree(source)).toEqual(sourceBefore);
    expect(tree(out)).toEqual(before);
  });

  it("keys/ as a link is refused; nothing is deleted or written through it", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    // A directory of the root's elsewhere, holding a file of the exported key's name.
    const victim = join(home, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "bot.json"), "the root's file");
    const keysDir = join(out, "keys");
    rmSync(keysDir, { recursive: true });
    symlinkSync(victim, keysDir);
    const before = tree(out);
    expect(await exportTo("bot", out)).toEqual(refused(NOT_EXPORTABLE));
    expect(tree(victim)).toEqual({ ".": "dir", "bot.json": "the root's file" });
    expect(tree(out)).toEqual(before);
  });

  it("a failed re-export leaves the earlier export working: encryption, profile write, swap", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    const intact = () => {
      expectExport(out, "bot");
      expect(readdirSync(home).sort()).toEqual([".mantle-aa", "agent-home"]);
    };

    // scrypt refuses N = 3: the encryption fails.
    const bad = { n: 3, r: 8, p: 1 };
    expect((await exportTo("bot", out, "a-new-export-password", bad)).code).toBe(1);
    intact();

    // An obstruction where the profile writer once put its temporary file.
    mkdirSync(join(out, "profiles.json.tmp"));
    expect((await exportTo("bot", out, "a-new-export-password")).code).toBe(1);
    rmSync(join(out, "profiles.json.tmp"), { recursive: true });
    intact();

    // The new home cannot be moved into place: the earlier one is put back.
    fault.renameTo = out;
    expect((await exportTo("bot", out, "a-new-export-password")).code).toBe(1);
    intact();
  });
});

// A change made while the export awaits its chain check, the window between validating the
// destination and replacing it.
describe("session export: a destination that changes during the export", () => {
  /** Runs `change` inside the export's chain check. */
  const during = (change: () => void) =>
    vi.spyOn(AgentSession.prototype, "simulate").mockImplementation(async () => change());

  it("a parent link retargeted at the source's parent: the source stays, the export lands where validated", async () => {
    const safe = join(home, "safe");
    mkdirSync(safe);
    const link = join(home, "mutable-parent");
    symlinkSync(safe, link);
    const sourceBefore = tree(source);
    during(() => {
      rmSync(link);
      symlinkSync(home, link);
    });
    const r = await exportTo("bot", join(link, ".mantle-aa"));
    expect(tree(source)).toEqual(sourceBefore);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ result: { home: "<home>/safe/.mantle-aa" } });
    expectExport(join(safe, ".mantle-aa"), "bot");
    expect(readdirSync(home).sort()).toEqual([".mantle-aa", "mutable-parent", "safe"]);
  });

  it("a missing parent planted as a link to the source's parent: refused, nothing written", async () => {
    const sourceBefore = tree(source);
    during(() => symlinkSync(home, join(home, "sub")));
    expect(await exportTo("bot", join(home, "sub", ".mantle-aa"))).toEqual(
      refused(/parent changed; nothing was written/),
    );
    expect(tree(source)).toEqual(sourceBefore);
    expect(readdirSync(home).sort()).toEqual([".mantle-aa", "sub"]);
  });

  it("a file added to an earlier export: refused at the swap, the file and the export stay", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    during(() => writeFileSync(join(out, "notes.txt"), "the agent's"));
    expect(await exportTo("bot", out, "a-new-export-password")).toEqual(refused(NOT_EXPORTABLE));
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("the agent's");
    rmSync(join(out, "notes.txt"));
    expectExport(out, "bot");
    expect(readdirSync(home).sort()).toEqual([".mantle-aa", "agent-home"]);
  });

  it("two agents exported to one new destination at once: one succeeds, the other is refused", async () => {
    let waiting = 0;
    let release = () => {};
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(AgentSession.prototype, "simulate").mockImplementation(async () => {
      if (++waiting === 2) release();
      await both;
    });
    const results = await Promise.all([exportTo("bot", out), exportTo("eve", out)]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    const winner = results[0]?.code === 0 ? "bot" : "eve";
    expect(results.find((r) => r.code)).toEqual(refused(NOT_EXPORTABLE));
    expectExport(out, winner);
    expect(readdirSync(home).sort()).toEqual([".mantle-aa", "agent-home"]);
  });
});

describe("session export: the commit point", () => {
  it("a replaced export that cannot be removed: exit 0, the new export live, a warning naming it", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    chmodSync(join(out, "keys"), 0o500); // the agent's doing, between two exports
    const r = await exportTo("bot", out, "a-new-export-password");
    expect(r.code).toBe(0);
    expectExport(out, "bot", "a-new-export-password");
    const { leftover } = (r.json as { result: { leftover: string } }).result;
    expect(leftover).toMatch(/^<home>\/\.agent-home-/);
    expect(r.stderr).toContain(`warning: `);
    expect(r.stderr).toContain(leftover.replace("<home>", home));
    const kept = join(leftover.replace("<home>", home), "previous");
    expect(opens(kept, "bot", EXPORT_PASSWORD), "the replaced export, kept").toBe(keys.bot);
    chmodSync(join(kept, "keys"), 0o700);
  });
});

describe("session export: who controls the parent", () => {
  it("refuses a parent chain another user could change: group or world writable, not sticky", async () => {
    const shared = join(home, "shared");
    mkdirSync(shared);
    for (const mode of [0o777, 0o775]) {
      chmodSync(shared, mode);
      expect(await exportTo("bot", join(shared, "sub", "agent-home"))).toEqual(
        refused(/shared can be changed by another user/),
      );
      expect(readdirSync(shared)).toEqual([]);
    }
    // Sticky, as /tmp: others cannot rename or delete what they do not own.
    chmodSync(shared, 0o1777);
    expect((await exportTo("bot", join(shared, "sub", "agent-home"))).code).toBe(0);
    expectExport(join(shared, "sub", "agent-home"), "bot");
  });

  it("serializes exporters: an export finding another's lock is refused and changes nothing", async () => {
    expect((await exportTo("bot", out)).code).toBe(0);
    const lock = join(home, ".agent-home.lock");
    writeFileSync(lock, "");
    const before = tree(home);
    expect(await exportTo("bot", out, "a-new-export-password")).toEqual(
      refused(/agent-home\.lock exists/),
    );
    expect(tree(home)).toEqual(before);
    expect(existsSync(lock)).toBe(true);
  });
});
