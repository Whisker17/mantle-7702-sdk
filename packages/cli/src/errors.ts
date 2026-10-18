import {
  DeadlineOutOfRangeError,
  ExecutionRevertedError,
  InventoryExceededError,
  KeyExpiredError,
  LimitExceededError,
  PolicyViolationError,
  SponsorBusyError,
  SponsorRejectedError,
} from "@mantle-aa/sdk";
import { BaseError } from "viem";

/** A malformed command line or a missing setting (RPC URL, sponsor, profile). */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** A command or option this version accepts but does not implement yet. */
export class NotAvailableError extends Error {
  override readonly name = "NotAvailableError";
}

/** The exit codes of docs/DESIGN.md §6, each with the `error.code` the `--json` output carries. */
export const EXIT_CODES = {
  OK: 0,
  POLICY_VIOLATION: 10,
  LIMIT_EXCEEDED: 11,
  INVENTORY_EXCEEDED: 12,
  KEY_EXPIRED_OR_REVOKED: 13,
  SPONSOR_REJECTED: 20,
  SPONSOR_BUSY: 21,
  EXECUTION_REVERTED: 30,
  ERROR: 1,
} as const;
export type ErrorCode = Exclude<keyof typeof EXIT_CODES, "OK"> | "USAGE" | "NOT_AVAILABLE";

/** The SDK's reasons for a session key that was revoked (Calibur key removed, or hook tombstone). */
// Depends on the SDK's exact reason strings (no structured revoked error); the fork test pins them.
const REVOKED_REASONS = new Set([
  "Session key is not registered on the account",
  "Session is revoked",
]);
/** Sponsor rejections that mean the session key itself is no longer usable. */
const SPONSOR_KEY_REASONS = new Set(["KEY_EXPIRED", "KEY_INACTIVE", "KEY_NOT_REGISTERED"]);

/**
 * The one table from error to exit code. The first error along the `cause` chain that the table
 * knows decides (MantleAccount wraps a failed init around its cause); anything else is `ERROR` (1).
 */
const TABLE: [(e: Error) => boolean, ErrorCode][] = [
  [(e) => e instanceof UsageError, "USAGE"],
  [(e) => e instanceof NotAvailableError, "NOT_AVAILABLE"],
  [(e) => e instanceof KeyExpiredError, "KEY_EXPIRED_OR_REVOKED"],
  [
    (e) =>
      e instanceof PolicyViolationError &&
      e.callIndex === undefined &&
      REVOKED_REASONS.has(e.reason),
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [(e) => e instanceof PolicyViolationError, "POLICY_VIOLATION"],
  [(e) => e instanceof DeadlineOutOfRangeError, "POLICY_VIOLATION"],
  [(e) => e instanceof LimitExceededError, "LIMIT_EXCEEDED"],
  [(e) => e instanceof InventoryExceededError, "INVENTORY_EXCEEDED"],
  [(e) => e instanceof SponsorBusyError, "SPONSOR_BUSY"],
  [
    (e) => e instanceof SponsorRejectedError && SPONSOR_KEY_REASONS.has(e.reason),
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [(e) => e instanceof SponsorRejectedError, "SPONSOR_REJECTED"],
  [(e) => e instanceof ExecutionRevertedError, "EXECUTION_REVERTED"],
];

const exitCodeOf = (code: ErrorCode): number =>
  code === "USAGE" || code === "NOT_AVAILABLE" ? EXIT_CODES.ERROR : EXIT_CODES[code];

/** Every URL becomes `<redacted-url>`: an RPC URL may carry an API key in its path or query. */
export const redact = (text: string): string =>
  text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, "<redacted-url>");

export interface ErrorOutput {
  exitCode: number;
  error: { code: ErrorCode; type: string; message: string } & Record<string, unknown>;
}

/** Classifies an error and builds its `--json` shape: the matched SDK error's own fields included. */
export function describeError(error: unknown): ErrorOutput {
  const top = error instanceof Error ? error : new Error(String(error));
  let matched: [Error, ErrorCode] | undefined;
  for (let e: unknown = top; e instanceof Error && !matched; e = e.cause) {
    const row = TABLE.find(([test]) => test(e as Error));
    if (row) matched = [e, row[1]];
  }
  const [source, code] = matched ?? [top, "ERROR" as const];
  // The SDK error's own fields (reason, callIndex, asset, remaining, …); none of an unknown error.
  const fields = matched
    ? Object.fromEntries(
        Object.entries(source).filter(([k]) => !["name", "message", "stack", "cause"].includes(k)),
      )
    : {};
  const message = top instanceof BaseError ? top.shortMessage : top.message;
  return {
    exitCode: exitCodeOf(code),
    error: { code, type: source.name, message: redact(message), ...fields },
  };
}
