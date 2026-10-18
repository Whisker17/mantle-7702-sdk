import { setTimeout as sleep } from "node:timers/promises";
import { type RelayResult, SponsorRejectCode } from "@mantle-aa/sdk";
import { type Address, BaseError, type Client, type Hex, parseTransaction } from "viem";
import type { LocalAccount } from "viem/accounts";
import { estimateFeesPerGas } from "viem/actions";
import { reject, SponsorRejection } from "./auth.js";
import type { SponsorConfig } from "./config.js";
import {
  getRawReceipt,
  type RawReceipt,
  type RelayerTransaction,
  receiptCost,
  relayerFeeBound,
} from "./fees.js";
import { checkBudget, type SponsoredTransaction } from "./policy.js";
import { broadcast, relayerNonces, signRelayerTransaction } from "./relayer.js";
import {
  type Attempt,
  type BudgetClass,
  type LedgerEntry,
  type LedgerState,
  OPEN_STATES,
  type SponsorStore,
} from "./store.js";

/** What the ledger needs of an accepted request; a `RelayDecision` is one. */
export interface PaidRequest {
  /** The authenticated request digest: the idempotency key. */
  digest: Hex;
  /** The SignedBatchedCall's EIP-712 digest: one batch is paid at most once. */
  batchDigest: Hex;
  sender: Address;
  budgetClass: BudgetClass;
  day: number;
  tx: SponsoredTransaction;
}

export interface LedgerOptions {
  config: SponsorConfig;
  client: Client;
  store: SponsorStore;
  /** The relayer: signs and pays for every transaction. */
  account: LocalAccount;
  /** How often unsettled transactions are checked; default 1000 ms. */
  pollIntervalMs?: number;
}

/** A relayer transaction of `status`, with the fees it was signed with. */
export interface AttemptStatus extends Omit<Attempt, "raw"> {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface RelayerStatus {
  relayer: Address;
  /** The chain's mined transaction count of the relayer. */
  latest: number;
  /** Mined plus queued at the node. */
  pending: number;
  /** The nonce the next submission takes: `max(pending, highest nonce signed + 1)`. */
  nextNonce: number;
  /** Relayer requests not settled yet, oldest first, with every transaction signed for them. */
  open: (LedgerEntry & { attempts: AttemptStatus[] })[];
}

export interface ReplaceOptions {
  /** The pending transaction to replace; default the lowest pending nonce. */
  nonce?: number;
  /** Default: the larger of +20 % over the latest attempt and the current network estimate. */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/** Polls a consumed nonce may show none of its transactions mined before the entry is released. */
const DROP_AFTER_POLLS = 3;
const ZERO = { gas: 0n, fee: 0n };
const raise = (x: bigint) => x + x / 5n + 1n;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
/** A node's own words about a refusal, never a URL (viem's full messages carry it). */
const detailOf = (error: unknown) =>
  error instanceof BaseError ? error.details.slice(0, 200) : "unknown error";

/**
 * The sponsor's ledger and relayer submission (DESIGN §5.2): reserve the worst case in one SQLite
 * transaction → submit with a persisted nonce → settle from the receipt that confirmed (failed
 * transactions are charged) → release the rest. At most one request per account is in flight, a
 * request digest or batch digest seen before returns its recorded result, and `start` reconciles
 * what a previous process left unsettled with the chain.
 */
export class Ledger {
  readonly relayer: Address;
  readonly #config: SponsorConfig;
  readonly #client: Client;
  readonly #store: SponsorStore;
  readonly #account: LocalAccount;
  readonly #pollIntervalMs: number;
  readonly #stop = new AbortController();
  readonly #waiters = new Map<Hex, Set<() => void>>();
  readonly #strikes = new Map<Hex, number>();
  #nonceLock: Promise<unknown> = Promise.resolve();
  #loop: Promise<void> | undefined;

  constructor(options: LedgerOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#store = options.store;
    this.#account = options.account;
    this.relayer = options.account.address;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /**
   * Reconciles with the chain: a request reserved but never signed is released; a submitted one is
   * settled from its receipt, or sent again if the node no longer holds it. Then keeps settling in
   * the background until `close`. Only the process that submits calls this.
   */
  async start(): Promise<void> {
    const foreign = this.#store
      .entries(["submitted"])
      .flatMap((e) => this.#store.attempts(e.digest))
      .find((a) => a.relayer !== this.relayer);
    if (foreign) {
      throw new Error(`relayer ${foreign.relayer} has unsettled transactions in this database`);
    }
    for (const e of this.#store.entries(["reserved"])) {
      this.#release(e.digest, "the sponsor stopped before submitting it");
    }
    await this.reconcile();
    this.#loop = this.#run();
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await this.#loop;
    for (const digest of this.#waiters.keys()) this.#notify(digest);
  }

  /** The result of a request already issued, or undefined if the digest is new. */
  find(digest: Hex): Promise<RelayResult> | undefined {
    return this.#store.entry(digest) ? this.#outcome(digest) : undefined;
  }

  /**
   * Pays for an accepted request: reserves its worst-case fee (rejecting `SPONSOR_BUSY` while the
   * account has a request in flight, or a cap the reservation would break), submits it, and waits
   * up to `settleTimeoutSeconds` for its settlement.
   */
  async relay(request: PaidRequest): Promise<RelayResult> {
    const known = this.#reserve(request);
    if (known) return this.#outcome(known.digest);
    await this.#submit(request);
    return this.#outcome(request.digest);
  }

  /** The relayer's chain nonces, the next nonce, and every unsettled request. */
  async status(): Promise<RelayerStatus> {
    const { latest, pending } = await relayerNonces(this.#client, this.relayer);
    return {
      relayer: this.relayer,
      latest,
      pending,
      nextNonce: this.#nextNonce(pending),
      open: this.#relayed(OPEN_STATES).map((e) => ({
        ...e,
        attempts: this.#store.attempts(e.digest).map(({ raw, ...a }) => {
          const { maxFeePerGas = 0n, maxPriorityFeePerGas = 0n } = parseTransaction(raw);
          return { ...a, maxFeePerGas, maxPriorityFeePerGas };
        }),
      })),
    };
  }

  /**
   * Re-sends a pending request's transaction with higher fees at the same nonce. The extra
   * worst-case fee is reserved first, against the daily budget. Resolves to the new hash.
   */
  async bump(options: ReplaceOptions = {}): Promise<Hex> {
    const entry = this.#pending(options.nonce);
    const attempts = this.#store.attempts(entry.digest);
    const batch = parseTransaction((attempts.findLast((a) => a.kind !== "cancel") as Attempt).raw);
    const tx: RelayerTransaction = {
      to: batch.to as Address,
      data: batch.data as Hex,
      gas: batch.gas as bigint,
      ...(batch.authorizationList ? { authorizationList: [...batch.authorizationList] } : {}),
      ...(await this.#replacementFees(attempts, options)),
    };
    return this.#replace(entry, tx, "bump");
  }

  /**
   * Replaces a pending request's transaction with a 0-value self-transfer at the same nonce. The
   * original can still win; the request settles by whichever transaction confirms (`cancelled`
   * if the cancel did, and its cost is charged). Resolves to the cancel's hash.
   */
  async cancel(options: ReplaceOptions = {}): Promise<Hex> {
    const entry = this.#pending(options.nonce);
    const attempts = this.#store.attempts(entry.digest);
    const tx: RelayerTransaction = {
      to: this.relayer,
      data: "0x",
      value: 0n,
      gas: 21_000n,
      ...(await this.#replacementFees(attempts, options)),
    };
    return this.#replace(entry, tx, "cancel");
  }

  /** One pass over the submitted requests: settle the mined, re-send the lost, release the dropped. */
  async reconcile(): Promise<void> {
    const open = this.#relayed(["submitted"]);
    if (!open.length) return;
    const { latest, pending } = await relayerNonces(this.#client, this.relayer);
    for (const entry of open) {
      const attempts = this.#store.attempts(entry.digest);
      let mined: [Attempt, RawReceipt] | undefined;
      for (const attempt of attempts) {
        const receipt = await getRawReceipt(this.#client, attempt.hash);
        if (receipt) {
          mined = [attempt, receipt];
          break;
        }
      }
      const nonce = entry.nonce as number;
      if (mined) {
        this.#settle(entry.digest, ...mined);
      } else if (nonce < latest) {
        // Mined, but none of ours: count polls first, in case receipts lag behind the nonce.
        const strikes = (this.#strikes.get(entry.digest) ?? 0) + 1;
        this.#strikes.set(entry.digest, strikes);
        if (strikes >= DROP_AFTER_POLLS) {
          this.#release(entry.digest, `relayer nonce ${nonce} was used by another transaction`);
        }
      } else if (nonce >= pending) {
        // The node holds none of them (a restart, or a broadcast that never arrived).
        await broadcast(this.#client, (attempts.at(-1) as Attempt).raw).catch(() => undefined);
      }
    }
  }

  // ---- internals ------------------------------------------------------------------------------

  /** Relayer requests in these states: paymaster sponsorships settle in `PaymasterLedger`. */
  #relayed(states: readonly LedgerState[]): LedgerEntry[] {
    return this.#store.entries(states).filter((e) => !e.paymaster);
  }

  async #run(): Promise<void> {
    for (;;) {
      try {
        await sleep(this.#pollIntervalMs, undefined, { signal: this.#stop.signal });
      } catch {
        return;
      }
      // Never log the error itself: viem messages carry the RPC URL.
      await this.reconcile().catch(() => console.error("sponsor: reconciliation failed"));
    }
  }

  /** In one SQLite transaction: an issued result, else busy, else the caps, else the reservation. */
  #reserve(request: PaidRequest): LedgerEntry | undefined {
    const { digest, batchDigest, sender, budgetClass, day, tx } = request;
    return this.#store.transaction(() => {
      const known = this.#store.entry(digest) ?? this.#store.entryByBatch(batchDigest);
      if (known) return known;
      if (this.#store.openEntry(sender)) {
        reject(SponsorRejectCode.SPONSOR_BUSY, `${sender} has a request in flight`);
      }
      checkBudget(this.#config, this.#store.usage(day, sender), {
        budgetClass,
        gas: tx.gas,
        maxFee: tx.maxFee,
      });
      const reserved = { gas: tx.gas, fee: tx.maxFee };
      this.#store.insertEntry({
        digest,
        batchDigest,
        account: sender,
        budgetClass,
        day,
        state: "reserved",
        reserved,
      });
      this.#store.add(day, sender, budgetClass, reserved);
      return undefined;
    });
  }

  /** Nonce, signature, persistence and broadcast, one request at a time. */
  #submit(request: PaidRequest): Promise<void> {
    const run = this.#nonceLock.then(async () => {
      let attempt: Attempt;
      try {
        const { pending } = await relayerNonces(this.#client, this.relayer);
        const nonce = this.#nextNonce(pending);
        const { to, data, authorizationList, gas, maxFeePerGas, maxPriorityFeePerGas } = request.tx;
        const signed = await signRelayerTransaction(this.#account, this.#config.chainId, {
          to,
          data,
          ...(authorizationList ? { authorizationList } : {}),
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        });
        attempt = {
          ...signed,
          digest: request.digest,
          relayer: this.relayer,
          nonce,
          kind: "submit",
        };
      } catch {
        return this.#release(request.digest, "the relayer could not prepare the transaction");
      }
      // Persisted before it is sent, so a restart finds every nonce this relayer may have used.
      this.#store.transaction(() => {
        this.#store.insertAttempt(attempt);
        this.#store.updateEntry(request.digest, { state: "submitted", nonce: attempt.nonce });
      });
      try {
        await broadcast(this.#client, attempt.raw);
      } catch (error) {
        // Refused, so never broadcast: the nonce is free again and nothing is charged.
        this.#store.transaction(() => {
          this.#store.deleteAttempt(attempt.hash);
          this.#release(request.digest, `the node refused the transaction: ${detailOf(error)}`);
        });
      }
    });
    this.#nonceLock = run.catch(() => undefined);
    return run;
  }

  #nextNonce(pending: number): number {
    return Math.max(pending, (this.#store.maxNonce(this.relayer) ?? -1) + 1);
  }

  /** Charges what the receipt says this transaction cost and releases the rest of the reservation. */
  #settle(digest: Hex, attempt: Attempt, receipt: RawReceipt): void {
    const charged = { gas: BigInt(receipt.gasUsed), fee: receiptCost(receipt) };
    this.#store.transaction(() => {
      const entry = this.#store.entry(digest);
      if (entry?.state !== "submitted") return;
      this.#store.add(entry.day, entry.account, entry.budgetClass, {
        gas: charged.gas - entry.reserved.gas,
        fee: charged.fee - entry.reserved.fee,
      });
      const status =
        attempt.kind === "cancel" ? "cancelled" : receipt.status === "0x1" ? "success" : "reverted";
      this.#store.updateEntry(digest, {
        state: "settled",
        reserved: ZERO,
        charged,
        result: {
          status,
          hash: attempt.hash,
          batchDigest: entry.batchDigest,
          fee: String(charged.fee),
        },
      });
    });
    this.#strikes.delete(digest);
    this.#notify(digest);
  }

  /** Ends an open entry that nothing was mined for: its whole reservation is released. */
  #release(digest: Hex, detail: string): void {
    this.#store.transaction(() => {
      const entry = this.#store.entry(digest);
      if (!entry || !OPEN_STATES.includes(entry.state)) return;
      this.#store.add(entry.day, entry.account, entry.budgetClass, {
        gas: -entry.reserved.gas,
        fee: -entry.reserved.fee,
      });
      this.#store.updateEntry(digest, {
        state: "released",
        reserved: ZERO,
        error: { reason: SponsorRejectCode.SUBMISSION_UNAVAILABLE, detail },
      });
    });
    this.#strikes.delete(digest);
    this.#notify(digest);
  }

  /** The recorded result, after waiting for an open entry to settle (up to the configured time). */
  async #outcome(digest: Hex): Promise<RelayResult> {
    let entry = this.#store.entry(digest) as LedgerEntry;
    if (OPEN_STATES.includes(entry.state)) {
      await this.#wait(digest, this.#config.settleTimeoutSeconds * 1000);
      entry = this.#store.entry(digest) as LedgerEntry;
    }
    if (entry.result) return entry.result;
    if (entry.error) throw new SponsorRejection(entry.error.reason, entry.error.detail);
    const last = this.#store.attempts(digest).at(-1);
    return { status: "pending", batchDigest: entry.batchDigest, ...(last && { hash: last.hash }) };
  }

  #wait(digest: Hex, ms: number): Promise<void> {
    if (this.#stop.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(digest) ?? new Set();
      this.#waiters.set(digest, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size) this.#waiters.delete(digest);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  #notify(digest: Hex): void {
    for (const done of [...(this.#waiters.get(digest) ?? [])]) done();
  }

  #pending(nonce?: number): LedgerEntry {
    const open = this.#relayed(["submitted"]).sort(
      (a, b) => (a.nonce as number) - (b.nonce as number),
    );
    const entry = nonce === undefined ? open[0] : open.find((e) => e.nonce === nonce);
    if (!entry) {
      throw new Error(
        nonce === undefined ? "no relayer transaction is pending" : `nonce ${nonce} is not pending`,
      );
    }
    return entry;
  }

  async #replacementFees(attempts: Attempt[], options: ReplaceOptions) {
    const last = parseTransaction((attempts.at(-1) as Attempt).raw);
    const network = await estimateFeesPerGas(this.#client);
    return {
      maxFeePerGas:
        options.maxFeePerGas ?? max(raise(last.maxFeePerGas as bigint), network.maxFeePerGas),
      maxPriorityFeePerGas:
        options.maxPriorityFeePerGas ??
        max(raise(last.maxPriorityFeePerGas as bigint), network.maxPriorityFeePerGas),
    };
  }

  /** Reserves what the replacement's worst case adds, then signs, records and sends it. */
  async #replace(entry: LedgerEntry, tx: RelayerTransaction, kind: Attempt["kind"]): Promise<Hex> {
    const bound = await relayerFeeBound(this.#client, this.#config.chainId, tx);
    const nonce = entry.nonce as number;
    const extra = this.#store.transaction(() => {
      const now = this.#store.entry(entry.digest);
      if (now?.state !== "submitted") throw new Error(`nonce ${nonce} is no longer pending`);
      // Whichever transaction confirms, the reservation covers it.
      const extra = bound > now.reserved.fee ? bound - now.reserved.fee : 0n;
      if (extra) {
        checkBudget(this.#config, this.#store.usage(now.day, now.account), {
          budgetClass: now.budgetClass,
          gas: 0n,
          maxFee: extra,
        });
        this.#reserveMore(now, extra);
      }
      return extra;
    });
    let attempt: Attempt | undefined;
    try {
      const signed = await signRelayerTransaction(this.#account, this.#config.chainId, {
        ...tx,
        nonce,
      });
      attempt = { ...signed, digest: entry.digest, relayer: this.relayer, nonce, kind };
      this.#store.insertAttempt(attempt);
      await broadcast(this.#client, attempt.raw);
      return attempt.hash;
    } catch (error) {
      this.#store.transaction(() => {
        if (attempt) this.#store.deleteAttempt(attempt.hash);
        const now = this.#store.entry(entry.digest);
        if (extra && now?.state === "submitted") this.#reserveMore(now, -extra);
      });
      throw new Error(`the ${kind} of nonce ${nonce} failed: ${detailOf(error)}`);
    }
  }

  #reserveMore(entry: LedgerEntry, fee: bigint): void {
    this.#store.add(entry.day, entry.account, entry.budgetClass, { gas: 0n, fee });
    this.#store.updateEntry(entry.digest, {
      reserved: { gas: entry.reserved.gas, fee: entry.reserved.fee + fee },
    });
  }
}
