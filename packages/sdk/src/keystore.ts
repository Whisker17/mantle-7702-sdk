import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type Address,
  bytesToHex,
  encodeAbiParameters,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
} from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { PrivateKeySigner } from "./signer.js";

/** Web3 Secret Storage v3 keystore (the format geth and foundry `cast wallet` write). */
export interface KeystoreV3 {
  version: 3;
  id: string;
  address: string;
  crypto: {
    cipher: "aes-128-ctr";
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: "scrypt" | "pbkdf2";
    kdfparams: Record<string, number | string>;
    mac: string;
  };
}

export interface ScryptParams {
  n: number;
  r: number;
  p: number;
}

/** geth's standard scrypt cost. */
const DEFAULT_SCRYPT: ScryptParams = { n: 262144, r: 8, p: 1 };

export const PASSWORD_ENV = "MANTLE_AA_KEYSTORE_PASSWORD";

const strip = (hex: Hex | string) => (hex.startsWith("0x") ? hex.slice(2) : hex);

function deriveKey(crypto: KeystoreV3["crypto"], password: string): Buffer {
  const k = crypto.kdfparams;
  const salt = Buffer.from(String(k.salt), "hex");
  const dklen = Number(k.dklen);
  if (crypto.kdf === "scrypt") {
    const [N, r, p] = [Number(k.n), Number(k.r), Number(k.p)];
    return scryptSync(password, salt, dklen, {
      N,
      r,
      p,
      maxmem: 128 * r * (N + p + 2) + 1024 * 1024,
    });
  }
  if (crypto.kdf === "pbkdf2" && k.prf === "hmac-sha256") {
    return pbkdf2Sync(password, salt, Number(k.c), dklen, "sha256");
  }
  throw new Error(`Unsupported keystore KDF ${crypto.kdf}`);
}

const mac = (derived: Buffer, ciphertext: Buffer) =>
  Buffer.from(hexToBytes(keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]))));

export function encryptKeystore(
  privateKey: Hex,
  password: string,
  scrypt: ScryptParams = DEFAULT_SCRYPT,
): KeystoreV3 {
  const address = privateKeyToAddress(privateKey);
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const crypto: KeystoreV3["crypto"] = {
    cipher: "aes-128-ctr",
    cipherparams: { iv: iv.toString("hex") },
    ciphertext: "",
    kdf: "scrypt",
    kdfparams: { dklen: 32, ...scrypt, salt: salt.toString("hex") },
    mac: "",
  };
  const derived = deriveKey(crypto, password);
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()]);
  crypto.ciphertext = ciphertext.toString("hex");
  crypto.mac = mac(derived, ciphertext).toString("hex");
  return { version: 3, id: randomUUID(), address: strip(address).toLowerCase(), crypto };
}

/** Decrypts a v3 keystore; a wrong password fails the MAC check and throws. */
export function decryptKeystore(keystore: KeystoreV3, password: string): Hex {
  const { crypto } = keystore;
  if (keystore.version !== 3 || crypto?.cipher !== "aes-128-ctr") {
    throw new Error("Unsupported keystore: expected version 3 with aes-128-ctr");
  }
  const derived = deriveKey(crypto, password);
  const ciphertext = Buffer.from(crypto.ciphertext, "hex");
  const expected = Buffer.from(crypto.mac, "hex");
  const actual = mac(derived, ciphertext);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Keystore MAC mismatch: wrong password or corrupted keystore");
  }
  const iv = Buffer.from(crypto.cipherparams.iv, "hex");
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const privateKey = bytesToHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  if (
    keystore.address &&
    getAddress(`0x${strip(keystore.address)}`) !== privateKeyToAddress(privateKey)
  ) {
    throw new Error("Keystore address does not match its decrypted key");
  }
  return privateKey;
}

// ---- On-disk layout: <home>/keys/<name>.json and <home>/profiles.json --------------------------

export interface Profile {
  account: Address;
  keyHash: Hex;
  /** Keystore path; a relative path is resolved against `<home>/keys`. */
  keyfile: string;
  role: "root" | "agent";
}

export interface KeystoreOptions {
  /** Defaults to `~/.mantle-aa`. */
  home?: string;
  /** Defaults to `MANTLE_AA_KEYSTORE_PASSWORD`. */
  password?: string;
  scrypt?: ScryptParams;
}

const homeDir = (o: KeystoreOptions) => o.home ?? join(homedir(), ".mantle-aa");
const keysDir = (o: KeystoreOptions) => join(homeDir(o), "keys");

function password(o: KeystoreOptions): string {
  const value = o.password ?? process.env[PASSWORD_ENV];
  if (!value) throw new Error(`No keystore password: pass one or set ${PASSWORD_ENV}`);
  return value;
}

function checkName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) {
    throw new Error(`Invalid key or profile name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Encrypts `privateKey` to `<home>/keys/<name>.json` (mode 0600); never overwrites. Returns the path. */
export function saveKey(name: string, privateKey: Hex, options: KeystoreOptions = {}): string {
  const dir = keysDir(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${checkName(name)}.json`);
  const keystore = encryptKeystore(privateKey, password(options), options.scrypt);
  writeFileSync(file, `${JSON.stringify(keystore, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

export function loadKey(keyfile: string, options: KeystoreOptions = {}): Hex {
  const file = isAbsolute(keyfile) ? keyfile : join(keysDir(options), keyfile);
  return decryptKeystore(JSON.parse(readFileSync(file, "utf8")), password(options));
}

export function loadSigner(keyfile: string, options: KeystoreOptions = {}): PrivateKeySigner {
  return new PrivateKeySigner(loadKey(keyfile, options));
}

const profilesFile = (o: KeystoreOptions) => join(homeDir(o), "profiles.json");

export function readProfiles(options: KeystoreOptions = {}): Record<string, Profile> {
  try {
    return JSON.parse(readFileSync(profilesFile(options), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Adds or replaces one profile; the file is replaced atomically, through a new temporary file of
 * an unpredictable name (never one that exists, so never through a link planted in the home).
 */
export function saveProfile(name: string, profile: Profile, options: KeystoreOptions = {}): void {
  const profiles = { ...readProfiles(options), [checkName(name)]: profile };
  const file = profilesFile(options);
  mkdirSync(homeDir(options), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(profiles, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function getProfile(name: string, options: KeystoreOptions = {}): Profile {
  const profile = readProfiles(options)[name];
  if (!profile) throw new Error(`No profile named ${JSON.stringify(name)}`);
  return profile;
}

/** Calibur keyHash of a secp256k1 key: keccak256(abi.encode(KeyType.Secp256k1, keccak256(abi.encode(addr)))). */
export function secp256k1KeyHash(address: Address): Hex {
  const publicKey = encodeAbiParameters([{ type: "address" }], [address]);
  return keccak256(
    encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, keccak256(publicKey)]),
  );
}

/**
 * Loads the signer of a profile and checks that it matches the profile: a root key is the account
 * itself (keyHash 0); an agent key's Calibur keyHash equals the profile's.
 */
export function loadProfileSigner(name: string, options: KeystoreOptions = {}): PrivateKeySigner {
  const profile = getProfile(name, options);
  const signer = loadSigner(profile.keyfile, options);
  const ok =
    profile.role === "root"
      ? signer.address === getAddress(profile.account) && BigInt(profile.keyHash) === 0n
      : profile.keyHash.toLowerCase() === secp256k1KeyHash(signer.address);
  if (!ok) throw new Error(`Profile ${name}: key does not match the profile's ${profile.role} key`);
  return signer;
}
