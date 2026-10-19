import {
  DeadlineOutOfRangeError,
  ExecutionRevertedError,
  InventoryExceededError,
  KeyExpiredError,
  LimitExceededError,
  PolicyViolationError,
  SponsorBusyError,
  SponsorRejectedError,
} from "@0xwh1sker/mantle-aa-sdk";
import { HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { describeError, EXIT_CODES, NotAvailableError, UsageError } from "../src/index.js";

const TOKEN = "0x00000000000000000000000000000000000000aa";
const KEY = `0x${"11".repeat(32)}` as const;

// One row per exit code of docs/DESIGN.md §6 (and per error class that maps to it).
const ROWS: [string, Error, number, string][] = [
  [
    "PolicyViolationError",
    new PolicyViolationError({ reason: "x", callIndex: 0 }),
    10,
    "POLICY_VIOLATION",
  ],
  ["DeadlineOutOfRangeError", new DeadlineOutOfRangeError({ deadline: 1 }), 10, "POLICY_VIOLATION"],
  [
    "LimitExceededError",
    new LimitExceededError({ asset: TOKEN, remaining: 5n, requested: 6n }),
    11,
    "LIMIT_EXCEEDED",
  ],
  [
    "InventoryExceededError",
    new InventoryExceededError({ token: TOKEN, held: 1n, requested: 2n }),
    12,
    "INVENTORY_EXCEEDED",
  ],
  [
    "KeyExpiredError",
    new KeyExpiredError({ keyHash: KEY, expiry: 1 }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "a revoked session (Calibur key removed)",
    new PolicyViolationError({ reason: "Session key is not registered on the account" }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "a revoked session (hook tombstone)",
    new PolicyViolationError({ reason: "Session is revoked" }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "SponsorRejectedError KEY_EXPIRED",
    new SponsorRejectedError({ reason: "KEY_EXPIRED" }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "SponsorRejectedError KEY_INACTIVE",
    new SponsorRejectedError({ reason: "KEY_INACTIVE" }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "SponsorRejectedError KEY_NOT_REGISTERED",
    new SponsorRejectedError({ reason: "KEY_NOT_REGISTERED" }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "SponsorRejectedError",
    new SponsorRejectedError({ reason: "NOT_ALLOWLISTED" }),
    20,
    "SPONSOR_REJECTED",
  ],
  [
    "SponsorRejectedError CANCELLED",
    new SponsorRejectedError({ reason: "CANCELLED" }),
    20,
    "SPONSOR_REJECTED",
  ],
  ["SponsorBusyError", new SponsorBusyError(), 21, "SPONSOR_BUSY"],
  [
    "ExecutionRevertedError",
    new ExecutionRevertedError({ data: "0x1234", reason: "r" }),
    30,
    "EXECUTION_REVERTED",
  ],
  ["UsageError", new UsageError("bad"), 1, "USAGE"],
  ["NotAvailableError", new NotAvailableError("later"), 1, "NOT_AVAILABLE"],
  ["any other error", new Error("boom"), 1, "ERROR"],
];

describe("exit codes", () => {
  it.each(ROWS)("%s → %i", (_, error, exitCode, code) => {
    const out = describeError(error);
    expect(out.exitCode).toBe(exitCode);
    expect(out.error.code).toBe(code);
    expect(out.error.type).toBe(error.name);
  });

  it("covers every exit code of DESIGN §6", () => {
    expect(new Set(ROWS.map((r) => r[2]))).toEqual(
      new Set(Object.values(EXIT_CODES).filter(Boolean)),
    );
  });

  it("follows the cause chain (MantleAccount wraps a failed init)", () => {
    const cause = new SponsorBusyError();
    const wrapped = new Error(`Init failed; the account is DELEGATED; retry init: ${cause}`, {
      cause,
    });
    expect(describeError(wrapped)).toEqual({
      exitCode: 21,
      error: { code: "SPONSOR_BUSY", type: "SponsorBusyError", message: wrapped.message },
    });
  });

  it("a policy violation of one call is not a revocation", () => {
    const error = new PolicyViolationError({ reason: "Session is revoked", callIndex: 2 });
    expect(describeError(error).exitCode).toBe(10);
  });

  it("carries the SDK error's fields, bigints included", () => {
    const { error } = describeError(
      new LimitExceededError({ asset: TOKEN, remaining: 5n, requested: 6n }),
    );
    expect(error).toMatchObject({ asset: TOKEN, remaining: 5n, requested: 6n });
  });

  it("redacts URLs and keeps nothing of an unknown error but its message", () => {
    const error = new HttpRequestError({ url: "https://rpc.example/v1/secret-api-key", body: {} });
    const out = describeError(new Error(`wrapped: ${error.message}`, { cause: error }));
    expect(JSON.stringify(out)).not.toContain("secret-api-key");
    expect(Object.keys(out.error).sort()).toEqual(["code", "message", "type"]);
    expect(describeError(error).error.message).toBe("HTTP request failed.");
  });
});
