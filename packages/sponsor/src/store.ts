import { DatabaseSync } from "node:sqlite";
import type { Address } from "viem";

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

const GLOBAL = "*";
const zero = (): Record<BudgetClass, Usage> => ({
  business: { gas: 0n, fee: 0n },
  management: { gas: 0n, fee: 0n },
});

/**
 * Persisted daily counters (SQLite, `node:sqlite`): per account and globally, per budget class.
 * Amounts are decimal TEXT because wei sums overflow SQLite's 64-bit integers.
 */
export class SponsorStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS daily_usage (
        day INTEGER NOT NULL,
        scope TEXT NOT NULL,
        class TEXT NOT NULL CHECK (class IN ('business', 'management')),
        gas TEXT NOT NULL,
        fee TEXT NOT NULL,
        PRIMARY KEY (day, scope, class)
      );
    `);
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
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
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }
}
