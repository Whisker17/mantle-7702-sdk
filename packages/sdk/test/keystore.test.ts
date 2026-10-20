import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptKeystore,
  encryptKeystore,
  getProfile,
  type KeystoreV3,
  loadProfileSigner,
  loadSigner,
  PASSWORD_ENV,
  readProfiles,
  saveKey,
  saveProfile,
  secp256k1KeyHash,
} from "../src/index.js";

// Cheap scrypt cost for tests only; the default is geth's n = 2^18.
const scrypt = { n: 1024, r: 8, p: 1 };

describe("v3 keystore", () => {
  // The Web3 Secret Storage Definition test key (password "testpassword").
  const vectorKey = "0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d";
  it("decrypts the reference pbkdf2 vector", () => {
    const keystore = {
      version: 3,
      id: "3198bc9c-6672-5ab3-d995-4942343ae5b6",
      address: "",
      crypto: {
        cipher: "aes-128-ctr",
        cipherparams: { iv: "6087dab2f9fdbbfaddc31a909735c1e6" },
        ciphertext: "5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46",
        kdf: "pbkdf2",
        kdfparams: {
          c: 262144,
          dklen: 32,
          prf: "hmac-sha256",
          salt: "ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd",
        },
        mac: "517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2",
      },
    } satisfies KeystoreV3;
    expect(decryptKeystore(keystore, "testpassword")).toBe(vectorKey);
  });

  it("decrypts a scrypt keystore written by foundry `cast wallet import`", () => {
    const keystore = {
      version: 3,
      id: "fbe3eda7-0d97-427b-a59a-8febbd367e97",
      address: "",
      crypto: {
        cipher: "aes-128-ctr",
        cipherparams: { iv: "a8010b34dafab0aa62a1045e755d5890" },
        ciphertext: "24ab238614682c8412bb8f86f4ac38f7e64cd8010b36d30ac33c9529eb07ad1a",
        kdf: "scrypt",
        kdfparams: {
          dklen: 32,
          n: 8192,
          p: 1,
          r: 8,
          salt: "5cbf2f6944c280bbd441113e9f9a32b7ed9cd71b8ce884ce09c352769a46a1a7",
        },
        mac: "21be4aaae61e353b7fa52a602d24d44dfb2753d287d5f575cad0da8d67a9d5e7",
      },
    } satisfies KeystoreV3;
    expect(decryptKeystore(keystore, "testpassword")).toBe(vectorKey);
  });

  it("round-trips and rejects a wrong password or a tampered file", () => {
    const key = generatePrivateKey();
    const keystore = encryptKeystore(key, "pw", scrypt);
    expect(keystore.address).toBe(privateKeyToAddress(key).slice(2).toLowerCase());
    expect(JSON.stringify(keystore)).not.toContain(key.slice(2));
    expect(decryptKeystore(keystore, "pw")).toBe(key);
    expect(() => decryptKeystore(keystore, "wrong")).toThrow(/MAC mismatch/);
    const tampered = structuredClone(keystore);
    tampered.crypto.ciphertext = `00${tampered.crypto.ciphertext.slice(2)}`;
    expect(() => decryptKeystore(tampered, "pw")).toThrow(/MAC mismatch/);
  });

  it("encrypts with geth's scrypt cost by default", () => {
    const keystore = encryptKeystore(generatePrivateKey(), "pw");
    expect(keystore.crypto.kdfparams).toMatchObject({ n: 262144, r: 8, p: 1, dklen: 32 });
  });
});

describe("keystore files and profiles", () => {
  let home: string;
  const saved = process.env[PASSWORD_ENV];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mantle-aa-"));
    delete process.env[PASSWORD_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[PASSWORD_ENV];
    else process.env[PASSWORD_ENV] = saved;
  });

  it("writes <home>/keys/<name>.json with mode 0600 and never overwrites", () => {
    const file = saveKey("root", generatePrivateKey(), { home, password: "pw", scrypt });
    expect(file).toBe(join(home, "keys", "root.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => saveKey("root", generatePrivateKey(), { home, password: "pw", scrypt })).toThrow(
      /EEXIST/,
    );
    expect(() =>
      saveKey("../evil", generatePrivateKey(), { home, password: "pw", scrypt }),
    ).toThrow(/Invalid key/);
  });

  it("takes the password from MANTLE_AA_KEYSTORE_PASSWORD and fails closed without one", () => {
    const key = generatePrivateKey();
    expect(() => saveKey("k", key, { home, scrypt })).toThrow(PASSWORD_ENV);
    process.env[PASSWORD_ENV] = "from-env";
    saveKey("k", key, { home, scrypt });
    expect(loadSigner("k.json", { home }).address).toBe(privateKeyToAddress(key));
    expect(() => loadSigner("k.json", { home, password: "other" })).toThrow(/MAC mismatch/);
  });

  it("loads root and agent signers through their profiles", () => {
    const opts = { home, password: "pw", scrypt };
    const rootKey = generatePrivateKey();
    const agentKey = generatePrivateKey();
    const account = privateKeyToAddress(rootKey);
    const agent = privateKeyToAddress(agentKey);
    saveProfile(
      "root",
      { account, keyHash: zeroHash, keyfile: saveKey("root", rootKey, opts), role: "root" },
      opts,
    );
    saveKey("agent-1", agentKey, opts);
    saveProfile(
      "agent-1",
      { account, keyHash: secp256k1KeyHash(agent), keyfile: "agent-1.json", role: "agent" },
      opts,
    );

    expect(Object.keys(readProfiles(opts))).toEqual(["root", "agent-1"]);
    expect(getProfile("agent-1", opts).role).toBe("agent");
    expect(statSync(join(home, "profiles.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "profiles.json"), "utf8")).not.toContain(agentKey.slice(2));
    expect(loadProfileSigner("root", opts).address).toBe(account);
    expect(loadProfileSigner("agent-1", opts).address).toBe(agent);
  });

  it("refuses a profile whose key does not match", () => {
    const opts = { home, password: "pw", scrypt };
    const agentKey = generatePrivateKey();
    const other = privateKeyToAddress(generatePrivateKey());
    saveKey("a", agentKey, opts);
    saveProfile(
      "a",
      { account: other, keyHash: secp256k1KeyHash(other), keyfile: "a.json", role: "agent" },
      opts,
    );
    saveProfile("r", { account: other, keyHash: zeroHash, keyfile: "a.json", role: "root" }, opts);
    expect(() => loadProfileSigner("a", opts)).toThrow(/does not match/);
    expect(() => loadProfileSigner("r", opts)).toThrow(/does not match/);
    expect(() => getProfile("missing", opts)).toThrow(/No profile/);
  });

  it("never writes profiles through a link planted at the old temporary name", () => {
    const victim = join(home, "victim");
    writeFileSync(victim, "the root's file");
    symlinkSync(victim, join(home, "profiles.json.tmp"));
    const account = privateKeyToAddress(generatePrivateKey());
    const root = { account, keyHash: zeroHash, keyfile: "r.json", role: "root" } as const;
    saveProfile("r", root, { home });
    saveProfile("s", root, { home });
    expect(readFileSync(victim, "utf8")).toBe("the root's file");
    expect(readProfiles({ home })).toEqual({ r: root, s: root });
    expect(readdirSync(home).sort()).toEqual(["profiles.json", "profiles.json.tmp", "victim"]);
  });

  it("computes Calibur's secp256k1 keyHash", () => {
    // cast keccak $(cast abi-encode "f(uint8,bytes32)" 2 $(cast keccak $(cast abi-encode "f(address)" 0x…01)))
    expect(secp256k1KeyHash("0x0000000000000000000000000000000000000001")).toBe(
      "0xac9388b6088099db3edd705d21985960e6c11e7976e6fb0b9657f6ff56e1e547",
    );
  });
});
