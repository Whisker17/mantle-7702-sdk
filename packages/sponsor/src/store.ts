import { DatabaseSync } from "node:sqlite";
import type { PaymasterDataResult, RelayResult, SponsorRejectCode } from "@mantle-aa/sdk";
import type { Address, Hex } from "viem";

/** Management requests (init / grant / revoke / panic) draw on a reserve business requests cannot. */
export type BudgetClass = "business" | "management";

export interface Usage {
  gas: bigint;
  /** Wei. */
  fee: bigint;
}

export interface DailyUsage {
  account: Record<BudgetClass, Usage>;
  global: Record<BudgetClass, Usage>;
}

/** The UTC day of a unix timestamp: budgets and caps reset when it changes. */
export const dayOf = (unixSeconds: number): number => Math.floor(unixSeconds / 86_400);

/**
 * A paid request's life (DESIGN §5.2): `reserved` (worst case counted against the caps) →
 * `submitted` (a relayer transaction holds its nonce, or the paymaster signature is issued) →
 * `settled` (charged from the receipt or `UserOperationEvent` that confirmed, the rest released),
 * or → `released` (nothing was mined for it; nothing charged).
 */
export type LedgerState = "reserved" | "submitted" | "settled" | "released";
export const OPEN_STATES: readonly LedgerState[] = ["reserved", "submitted"];

export interface LedgerEntry {
  /** The authenticated request digest. */
  digest: Hex;
  batchDigest: Hex;
  account: Address;
  budgetClass: BudgetClass;
  day: number;
  state: LedgerState;
  /** The relayer nonce, once submitted. */
  nonce: number | null;
  /** Still counted against the caps on top of `charged`; zero once settled or released. */
  reserved: Usage;
  charged: Usage;
  /** Once settled. */
  result: RelayResult | null;
  /** Once released: why nothing was mined. */
  error: { reason: SponsorRejectCode; detail: string } | null;
  /** A paymaster sponsorship (its `batchDigest` is the paymaster hash); null for a relayer request. */
  paymaster: PaymasterRecord | null;
}

/** A paymaster sponsorship: issued, then watched on chain until included or expired. */
export interface PaymasterRecord {
  /** The EntryPoint's hash of the sponsored UserOp: its `UserOperationEvent` topic. */
  userOpHash: Hex;
  /** Unix seconds: the sponsorship cannot be included in a block after it. */
  validUntil: number;
  /** Every block up to this one is known to hold no `UserOperationEvent` for `userOpHash`. */
  scannedTo: number;
  /** What every retry returns. */
  result: PaymasterDataResult;
  /** Once settled: the inclusion and what the paymaster deposit was charged. */
  included?: {
    transactionHash: Hex;
    blockNumber: number;
    success: boolean;
    /** Wei, decimal. */
    actualGasCost: string;
    actualGasUsed: string;
  };
}

/** One signed relayer transaction for an entry: its first submission, a bump or a cancel. */
export interface Attempt {
  hash: Hex;
  digest: Hex;
  relayer: Address;
  nonce: number;
  kind: "submit" | "bump" | "cancel";
  raw: Hex;
}

interface EntryRow {
  digest: Hex;
  batch_digest: Hex;
  account: Address;
  class: BudgetClass;
  day: number;
  state: LedgerState;
  nonce: number | null;
  reserved_gas: string;
  reserved_fee: string;
  charged_gas: string;
  charged_fee: string;
  result: string | null;
  error: string | null;
  paymaster: string | null;
}

const toEntry = (r: EntryRow): LedgerEntry => ({
  digest: r.digest,
  batchDigest: r.batch_digest,
  account: r.account,
  budgetClass: r.class,
  day: r.day,
  state: r.state,
  nonce: r.nonce,
  reserved: { gas: BigInt(r.reserved_gas), fee: BigInt(r.reserved_fee) },
  charged: { gas: BigInt(r.charged_gas), fee: BigInt(r.charged_fee) },
  result: r.result === null ? null : JSON.parse(r.result),
  error: r.error === null ? null : JSON.parse(r.error),
  paymaster: r.paymaster === null ? null : JSON.parse(r.paymaster),
});

const GLOBAL = "*";
const zero = (): Record<BudgetClass, Usage> => ({
  business: { gas: 0n, fee: 0n },
  management: { gas: 0n, fee: 0n },
});

/**
 * Persisted daily counters (SQLite, `node:sqlite`): per account and globally, per budget class;
 * they hold what is charged plus what is still reserved. Beside them, the ledger of paid requests
 * and every relayer transaction signed for them. Amounts are decimal TEXT because wei sums overflow
 * SQLite's 64-bit integers.
 */
export class SponsorStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS daily_usage (
        day INTEGER NOT NULL,
        scope TEXT NOT NULL,
        class TEXT NOT NULL CHECK (class IN ('business', 'management')),
        gas TEXT NOT NULL,
        fee TEXT NOT NULL,
        PRIMARY KEY (day, scope, class)
      );
      CREATE TABLE IF NOT EXISTS ledger (
        digest TEXT PRIMARY KEY,
        batch_digest TEXT NOT NULL UNIQUE,
        account TEXT NOT NULL,
        class TEXT NOT NULL CHECK (class IN ('business', 'management')),
        day INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'submitted', 'settled', 'released')),
        nonce INTEGER,
        reserved_gas TEXT NOT NULL,
        reserved_fee TEXT NOT NULL,
        charged_gas TEXT NOT NULL DEFAULT '0',
        charged_fee TEXT NOT NULL DEFAULT '0',
        result TEXT,
        error TEXT,
        paymaster TEXT
      );
      -- At most one request in flight per account, whatever the code above it does.
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_open_per_account
        ON ledger (account) WHERE state IN ('reserved', 'submitted');
      CREATE TABLE IF NOT EXISTS attempts (
        hash TEXT PRIMARY KEY,
        digest TEXT NOT NULL REFERENCES ledger (digest),
        relayer TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('submit', 'bump', 'cancel')),
        raw TEXT NOT NULL
      );
    `);
    // A database from before the paymaster methods lacks the column.
    const columns = this.#db.prepare("PRAGMA table_info(ledger)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "paymaster")) {
      this.#db.exec("ALTER TABLE ledger ADD COLUMN paymaster TEXT");
    }
  }

  /** Runs `fn` in one write transaction (`BEGIN IMMEDIATE`), rolled back if it throws; nests. */
  transaction<T>(fn: () => T): T {
    if (this.#db.isTransaction) return fn();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  entry(digest: Hex): LedgerEntry | undefined {
    const row = this.#db.prepare("SELECT * FROM ledger WHERE digest = ?").get(digest);
    return row && toEntry(row as unknown as EntryRow);
  }

  entryByBatch(batchDigest: Hex): LedgerEntry | undefined {
    const row = this.#db.prepare("SELECT * FROM ledger WHERE batch_digest = ?").get(batchDigest);
    return row && toEntry(row as unknown as EntryRow);
  }

  /** Entries in the given states (all without), oldest first. */
  entries(states?: readonly LedgerState[]): LedgerEntry[] {
    const rows = states
      ? this.#db
          .prepare(
            `SELECT * FROM ledger WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY rowid`,
          )
          .all(...states)
      : this.#db.prepare("SELECT * FROM ledger ORDER BY rowid").all();
    return (rows as unknown as EntryRow[]).map(toEntry);
  }

  openEntry(account: Address): LedgerEntry | undefined {
    const row = this.#db
      .prepare("SELECT * FROM ledger WHERE account = ? AND state IN ('reserved', 'submitted')")
      .get(account);
    return row && toEntry(row as unknown as EntryRow);
  }

  insertEntry(
    e: Omit<LedgerEntry, "charged" | "result" | "error" | "nonce" | "paymaster"> &
      Partial<Pick<LedgerEntry, "paymaster">>,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO ledger (digest, batch_digest, account, class, day, state, reserved_gas, reserved_fee, paymaster)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.digest,
        e.batchDigest,
        e.account,
        e.budgetClass,
        e.day,
        e.state,
        String(e.reserved.gas),
        String(e.reserved.fee),
        e.paymaster ? JSON.stringify(e.paymaster) : null,
      );
  }

  updateEntry(
    digest: Hex,
    patch: Partial<
      Pick<
        LedgerEntry,
        "state" | "nonce" | "reserved" | "charged" | "result" | "error" | "paymaster"
      >
    >,
  ): void {
    const columns: [string, string | number | null][] = [];
    if (patch.state !== undefined) columns.push(["state", patch.state]);
    if (patch.nonce !== undefined) columns.push(["nonce", patch.nonce]);
    if (patch.reserved) {
      columns.push(["reserved_gas", String(patch.reserved.gas)]);
      columns.push(["reserved_fee", String(patch.reserved.fee)]);
    }
    if (patch.charged) {
      columns.push(["charged_gas", String(patch.charged.gas)]);
      columns.push(["charged_fee", String(patch.charged.fee)]);
    }
    if (patch.result !== undefined) columns.push(["result", JSON.stringify(patch.result)]);
    if (patch.error !== undefined) columns.push(["error", JSON.stringify(patch.error)]);
    if (patch.paymaster !== undefined) {
      columns.push(["paymaster", JSON.stringify(patch.paymaster)]);
    }
    this.#db
      .prepare(`UPDATE ledger SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE digest = ?`)
      .run(...columns.map(([, v]) => v), digest);
  }

  /** The entry's relayer transactions, in signing order. */
  attempts(digest: Hex): Attempt[] {
    return this.#db
      .prepare(
        "SELECT hash, digest, relayer, nonce, kind, raw FROM attempts WHERE digest = ? ORDER BY rowid",
      )
      .all(digest) as unknown as Attempt[];
  }

  insertAttempt(a: Attempt): void {
    this.#db
      .prepare(
        "INSERT INTO attempts (hash, digest, relayer, nonce, kind, raw) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(a.hash, a.digest, a.relayer, a.nonce, a.kind, a.raw);
  }

  deleteAttempt(hash: Hex): void {
    this.#db.prepare("DELETE FROM attempts WHERE hash = ?").run(hash);
  }

  /** The highest nonce `relayer` has signed a transaction with, if any. */
  maxNonce(relayer: Address): number | undefined {
    const row = this.#db
      .prepare("SELECT MAX(nonce) AS nonce FROM attempts WHERE relayer = ?")
      .get(relayer) as { nonce: number | null };
    return row.nonce ?? undefined;
  }

  usage(day: number, account: Address): DailyUsage {
    const usage: DailyUsage = { account: zero(), global: zero() };
    const rows = this.#db
      .prepare("SELECT scope, class, gas, fee FROM daily_usage WHERE day = ? AND scope IN (?, ?)")
      .all(day, account.toLowerCase(), GLOBAL) as {
      scope: string;
      class: BudgetClass;
      gas: string;
      fee: string;
    }[];
    for (const row of rows) {
      usage[row.scope === GLOBAL ? "global" : "account"][row.class] = {
        gas: BigInt(row.gas),
        fee: BigInt(row.fee),
      };
    }
    return usage;
  }

  /** Adds `delta` (negative to release) to the account's and the global counters atomically. */
  add(day: number, account: Address, budgetClass: BudgetClass, delta: Usage): void {
    const upsert = this.#db.prepare(
      `INSERT INTO daily_usage (day, scope, class, gas, fee) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (day, scope, class) DO UPDATE SET gas = excluded.gas, fee = excluded.fee`,
    );
    this.transaction(() => {
      const before = this.usage(day, account);
      for (const [scope, current] of [
        [account.toLowerCase(), before.account[budgetClass]],
        [GLOBAL, before.global[budgetClass]],
      ] as const) {
        upsert.run(
          day,
          scope,
          budgetClass,
          String(current.gas + delta.gas),
          String(current.fee + delta.fee),
        );
      }
    });
  }

  close(): void {
    this.#db.close();
  }
}
