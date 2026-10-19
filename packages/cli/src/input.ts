import { readFileSync } from "node:fs";
import type { Call, Policy, QuoteLimit, ReleaseTuple } from "@0xwh1sker/mantle-aa-sdk";
import { RuleKind } from "@0xwh1sker/mantle-aa-sdk";
import { type Address, getAddress, type Hex, isAddress, isHex, toFunctionSelector } from "viem";
import { UsageError } from "./errors.js";

// Command-line JSON is untrusted input: every field is checked before anything is signed.

type Json = Record<string, unknown>;

function object(value: unknown, field: string, keys: string[]): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`${field} must be a JSON object`);
  }
  const unknown = Object.keys(value).filter((k) => !keys.includes(k));
  if (unknown.length) throw new UsageError(`${field} has unknown keys: ${unknown.join(", ")}`);
  return value as Json;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new UsageError(`${field} must be a JSON array`);
  return value;
}

export function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new UsageError(`${field} must be an address`);
  }
  return getAddress(value);
}

/** A non-negative integer as a decimal string or a safe JSON integer. */
export function amount(value: unknown, field: string): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (Number.isSafeInteger(value) && (value as number) >= 0) return BigInt(value as number);
  throw new UsageError(`${field} must be a non-negative integer (decimal string)`);
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new UsageError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function hex(value: unknown, field: string, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length % 2 !== 0) {
    throw new UsageError(`${field} must be 0x-prefixed hex`);
  }
  if (bytes !== undefined && value.length !== 2 + 2 * bytes) {
    throw new UsageError(`${field} must be ${bytes} bytes`);
  }
  return value;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${what} is not valid JSON`);
  }
}

/** `--calls '[{"to": "0x…", "value": "0", "data": "0x…"}]'`; `value` and `data` are optional. */
export function parseCalls(text: string): Call[] {
  const calls = array(parseJson(text, "--calls"), "--calls");
  if (!calls.length) throw new UsageError("--calls must hold at least one call");
  return calls.map((raw, i) => {
    const c = object(raw, `--calls[${i}]`, ["to", "value", "data"]);
    return {
      to: address(c.to, `--calls[${i}].to`),
      value: c.value === undefined ? 0n : amount(c.value, `--calls[${i}].value`),
      data: c.data === undefined ? "0x" : hex(c.data, `--calls[${i}].data`),
    };
  });
}

/** `--release <keyHash>,<token>,<amount>` (repeatable). */
export function parseRelease(values: readonly string[]): ReleaseTuple[] {
  return values.map((value) => {
    const [keyHash, token, amt, ...rest] = value.split(",");
    if (rest.length || amt === undefined) {
      throw new UsageError("--release must be <keyHash>,<token>,<amount>");
    }
    return {
      keyHash: hex(keyHash, "--release keyHash", 32),
      token: address(token, "--release token"),
      amount: amount(amt, "--release amount"),
    };
  });
}

const RULE_KINDS = RuleKind as Record<string, number>;

function quoteLimit(value: unknown, field: string): QuoteLimit {
  const q = object(value, field, ["token", "totalCap", "periodCap"]);
  return {
    token: address(q.token, `${field}.token`),
    totalCap: amount(q.totalCap, `${field}.totalCap`),
    periodCap: amount(q.periodCap, `${field}.periodCap`),
  };
}

/**
 * A policy file: the `setPolicy` struct (docs/DESIGN.md §4.2.2) as JSON, amounts as decimal
 * strings. `maxValuePerCall` and `mntLimit` default to zero (no MNT); a permission's `selector` may
 * be a function signature and its `ruleKind` a `RuleKind` name.
 */
export function parsePolicy(file: string): Policy {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`cannot read the policy file ${file}`);
  }
  const p = object(parseJson(text, "the policy file"), "policy", [
    "maxValuePerCall",
    "mntLimit",
    "quoteLimits",
    "periodLength",
    "permissions",
    "trustedSpenders",
    "maxDeadlineWindow",
  ]);
  const zero = "0x0000000000000000000000000000000000000000";
  return {
    maxValuePerCall:
      p.maxValuePerCall === undefined ? 0n : amount(p.maxValuePerCall, "policy.maxValuePerCall"),
    mntLimit:
      p.mntLimit === undefined
        ? { token: zero, totalCap: 0n, periodCap: 0n }
        : quoteLimit(p.mntLimit, "policy.mntLimit"),
    quoteLimits: array(p.quoteLimits, "policy.quoteLimits").map((q, i) =>
      quoteLimit(q, `policy.quoteLimits[${i}]`),
    ),
    periodLength: integer(p.periodLength, "policy.periodLength"),
    permissions: array(p.permissions, "policy.permissions").map((raw, i) => {
      const field = `policy.permissions[${i}]`;
      const perm = object(raw, field, ["target", "selector", "ruleKind"]);
      const sel = perm.selector;
      const selector =
        typeof sel === "string" && sel.includes("(")
          ? toFunctionSelector(sel)
          : hex(sel, `${field}.selector`, 4);
      const kind = perm.ruleKind;
      const ruleKind = typeof kind === "string" ? RULE_KINDS[kind] : kind;
      if (!Object.values(RULE_KINDS).includes(ruleKind as number)) {
        throw new UsageError(`${field}.ruleKind must be one of ${Object.keys(RULE_KINDS)}`);
      }
      return {
        target: address(perm.target, `${field}.target`),
        selector,
        ruleKind: ruleKind as number,
      };
    }),
    trustedSpenders: array(p.trustedSpenders, "policy.trustedSpenders").map((s, i) =>
      address(s, `policy.trustedSpenders[${i}]`),
    ),
    maxDeadlineWindow: integer(p.maxDeadlineWindow, "policy.maxDeadlineWindow"),
  };
}

/** The input stream a secret may be read from; a TTY is prompted with echo off. */
export interface SecretInput extends AsyncIterable<string | Buffer> {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Reads one line typed at a TTY without echoing it. */
export function promptHidden(
  input: SecretInput,
  prompt: (text: string) => void,
  question: string,
): Promise<string> {
  prompt(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      prompt("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value);
        }
        if (ch === "\u0003" || ch === "\u0004") {
          done();
          return reject(new UsageError("cancelled"));
        }
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  });
}

/** The whole of a piped input, trimmed. */
export async function readAll(input: SecretInput): Promise<string> {
  let text = "";
  for await (const chunk of input) text += String(chunk);
  return text.trim();
}
