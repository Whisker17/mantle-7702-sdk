import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type AddressBook, loadDeployments } from "@mantle-aa/sdk";
import { type Address, getAddress, isAddress, parseEther } from "viem";
import { parse } from "yaml";

/**
 * Sponsor configuration, read from YAML:
 *
 * ```yaml
 * chainId: 5003
 * rpcUrl: ${MANTLE_SEPOLIA_RPC_URL}   # a literal URL, or ${VAR} to read it from the environment
 * listen: { host: 127.0.0.1, port: 8548 }
 * database: ./sponsor.sqlite          # relative paths resolve against this file
 * relayer: "0x…"                      # the relayer (batch executor) address; names this sponsor
 * deployments: ../deployments/mantle-sepolia.json   # optional; default: the committed book
 * maxRequestValiditySeconds: 300      # optional; longest request validity window accepted
 * policy:
 *   allowlist: ["0x…"]
 *   accountDailyGas: 5000000          # gas per account, per UTC day, per budget class
 *   maxFeePerRequestMnt: "0.05"       # worst-case fee of one request
 *   dailyBudgetMnt: "5"               # every request of a UTC day
 *   managementReserveMnt: "1"         # the part of dailyBudget only management requests may use
 * ```
 *
 * Addresses must be quoted: YAML reads an unquoted `0x…` as a number.
 */
export interface SponsorConfig {
  chainId: number;
  rpcUrl: string;
  listen: { host: string; port: number };
  database: string;
  relayer: Address;
  addresses: AddressBook;
  maxRequestValiditySeconds: number;
  policy: SponsorPolicy;
}

export interface SponsorPolicy {
  allowlist: Address[];
  accountDailyGas: bigint;
  /** Wei. */
  maxFeePerRequest: bigint;
  /** Wei. */
  dailyBudget: bigint;
  /** Wei. */
  managementReserve: bigint;
}

export function loadConfig(path: string): SponsorConfig {
  return parseConfig(parse(readFileSync(path, "utf8")), dirname(resolve(path)));
}

/** Validates a parsed config; relative paths resolve against `baseDir`. Throws on the first bad field. */
export function parseConfig(raw: unknown, baseDir: string): SponsorConfig {
  const c = record(raw, "config", [
    "chainId",
    "rpcUrl",
    "listen",
    "database",
    "relayer",
    "deployments",
    "maxRequestValiditySeconds",
    "policy",
  ]);
  const listen = record(c.listen ?? {}, "listen", ["host", "port"]);
  const p = record(c.policy, "policy", [
    "allowlist",
    "accountDailyGas",
    "maxFeePerRequestMnt",
    "dailyBudgetMnt",
    "managementReserveMnt",
  ]);
  if (!Array.isArray(p.allowlist)) throw new Error("policy.allowlist must be a list of addresses");

  const chainId = integer(c.chainId, "chainId");
  const addresses =
    c.deployments === undefined
      ? loadDeployments()
      : loadDeployments(resolve(baseDir, string(c.deployments, "deployments")));
  if (addresses.chainId !== chainId) {
    throw new Error(`chainId ${chainId} is not the deployments' ${addresses.chainId}`);
  }
  const policy: SponsorPolicy = {
    allowlist: p.allowlist.map((a, i) => address(a, `policy.allowlist[${i}]`)),
    accountDailyGas: BigInt(integer(p.accountDailyGas, "policy.accountDailyGas")),
    maxFeePerRequest: mnt(p.maxFeePerRequestMnt, "policy.maxFeePerRequestMnt"),
    dailyBudget: mnt(p.dailyBudgetMnt, "policy.dailyBudgetMnt"),
    managementReserve: mnt(p.managementReserveMnt, "policy.managementReserveMnt"),
  };
  if (policy.managementReserve > policy.dailyBudget) {
    throw new Error("policy.managementReserveMnt exceeds policy.dailyBudgetMnt");
  }
  return {
    chainId,
    rpcUrl: rpcUrl(c.rpcUrl),
    listen: {
      host: listen.host === undefined ? "127.0.0.1" : string(listen.host, "listen.host"),
      port: listen.port === undefined ? 8548 : integer(listen.port, "listen.port"),
    },
    database: resolve(baseDir, string(c.database, "database")),
    relayer: address(c.relayer, "relayer"),
    addresses,
    maxRequestValiditySeconds:
      c.maxRequestValiditySeconds === undefined
        ? 300
        : integer(c.maxRequestValiditySeconds, "maxRequestValiditySeconds"),
    policy,
  };
}

function record(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  const unknown = Object.keys(value).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`${field} has unknown keys: ${unknown.join(", ")}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a string`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${field} must be a quoted address`);
  }
  return getAddress(value);
}

function mnt(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+(\.\d{1,18})?$/.test(value)) {
    throw new Error(`${field} must be a quoted decimal MNT amount`);
  }
  return parseEther(value);
}

/** Never echoes the URL: it may carry credentials. */
function rpcUrl(value: unknown): string {
  const raw = string(value, "rpcUrl");
  const env = /^\$\{(\w+)\}$/.exec(raw)?.[1];
  const url = env ? process.env[env] : raw;
  if (!url) throw new Error(`rpcUrl: environment variable ${env} is not set`);
  if (!/^https?:\/\//.test(url)) throw new Error("rpcUrl must be an http(s) URL");
  return url;
}
