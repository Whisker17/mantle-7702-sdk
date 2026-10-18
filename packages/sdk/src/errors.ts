import type { Address, Hex } from "viem";

/** The SDK's structured rejections (docs/DESIGN.md §5.1, Error model). */

/** A call the policy (or Calibur) forbids; `callIndex` names the offending call of the batch. */
export class PolicyViolationError extends Error {
  override readonly name = "PolicyViolationError";
  readonly reason: string;
  readonly callIndex: number | undefined;

  constructor(params: { reason: string; callIndex?: number }) {
    super(
      params.callIndex === undefined ? params.reason : `Call ${params.callIndex}: ${params.reason}`,
    );
    this.reason = params.reason;
    this.callIndex = params.callIndex;
  }
}

/** Spending over a cap. `asset` is the quote asset, or the zero address for MNT. */
export class LimitExceededError extends Error {
  override readonly name = "LimitExceededError";
  readonly asset: string;
  readonly remaining: bigint;
  readonly requested: bigint | undefined;

  constructor(params: { asset: string; remaining: bigint; requested?: bigint }) {
    super(
      `Limit of ${params.asset} exceeded: ${params.requested ?? "more"} requested, ${params.remaining} remaining`,
    );
    this.asset = params.asset;
    this.remaining = params.remaining;
    this.requested = params.requested;
  }
}

/** A SELL of more than the inventory attributed to this session key. */
export class InventoryExceededError extends Error {
  override readonly name = "InventoryExceededError";
  readonly token: Address;
  readonly held: bigint;
  readonly requested: bigint | undefined;

  constructor(params: { token: Address; held: bigint; requested?: bigint }) {
    super(
      `Inventory of ${params.token} exceeded: ${params.requested ?? "more"} requested, ${params.held} held`,
    );
    this.token = params.token;
    this.held = params.held;
    this.requested = params.requested;
  }
}

/** The session key's Calibur expiry has passed. */
export class KeyExpiredError extends Error {
  override readonly name = "KeyExpiredError";
  readonly keyHash: Hex;
  readonly expiry: number;

  constructor(params: { keyHash: Hex; expiry: number }) {
    super(`Session key ${params.keyHash} expired at ${params.expiry}`);
    this.keyHash = params.keyHash;
    this.expiry = params.expiry;
  }
}

/** A launchpad deadline outside `[now, now + maxDeadlineWindow]`. */
export class DeadlineOutOfRangeError extends Error {
  override readonly name = "DeadlineOutOfRangeError";
  readonly deadline: number;
  readonly minDeadline: number | undefined;
  readonly maxDeadline: number | undefined;

  constructor(params: { deadline: number; minDeadline?: number; maxDeadline?: number }) {
    super(
      `Deadline ${params.deadline} is outside [${params.minDeadline ?? "?"}, ${params.maxDeadline ?? "?"}]`,
    );
    this.deadline = params.deadline;
    this.minDeadline = params.minDeadline;
    this.maxDeadline = params.maxDeadline;
  }
}

/** The sponsor refused the request. */
export class SponsorRejectedError extends Error {
  override readonly name = "SponsorRejectedError";
  readonly reason: string;

  constructor(params: { reason: string }) {
    super(`Sponsor rejected the request: ${params.reason}`);
    this.reason = params.reason;
  }
}

/** The sponsor already has a pending transaction for this account; retry later. */
export class SponsorBusyError extends Error {
  override readonly name = "SponsorBusyError";

  constructor() {
    super("Sponsor is busy with this account's pending transaction; retry later");
  }
}

/** The batch reverted in simulation or on chain. `data` is the raw revert data when known. */
export class ExecutionRevertedError extends Error {
  override readonly name = "ExecutionRevertedError";
  readonly data: Hex | undefined;
  readonly reason: string | undefined;

  constructor(params: { data?: Hex; reason?: string } = {}) {
    super(`Execution reverted${params.reason ? `: ${params.reason}` : ""}`);
    this.data = params.data;
    this.reason = params.reason;
  }
}
