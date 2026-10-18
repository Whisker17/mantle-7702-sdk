import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dayOf, SponsorStore } from "../src/store.js";

const A = "0x00000000000000000000000000000000000000AA";
const B = "0x00000000000000000000000000000000000000BB";

describe("SponsorStore", () => {
  it("persists per-account and global counters per day and class across a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sponsor-store-")), "sponsor.sqlite");
    const day = dayOf(1_800_000_000);
    let store = new SponsorStore(path);
    store.add(day, A, "business", { gas: 100n, fee: 10n ** 19n });
    store.add(day, A, "business", { gas: 50n, fee: 10n ** 19n });
    store.add(day, B, "management", { gas: 7n, fee: 3n });
    store.add(day + 1, A, "business", { gas: 1n, fee: 1n });
    store.close();

    store = new SponsorStore(path);
    expect(store.usage(day, A)).toEqual({
      account: { business: { gas: 150n, fee: 2n * 10n ** 19n }, management: { gas: 0n, fee: 0n } },
      global: { business: { gas: 150n, fee: 2n * 10n ** 19n }, management: { gas: 7n, fee: 3n } },
    });
    expect(store.usage(day, B).account.management).toEqual({ gas: 7n, fee: 3n });
    // A release (negative delta) lowers both counters.
    store.add(day, A, "business", { gas: -50n, fee: -(10n ** 19n) });
    expect(store.usage(day, A).global.business).toEqual({ gas: 100n, fee: 10n ** 19n });
    expect(store.usage(day + 1, A).account.business).toEqual({ gas: 1n, fee: 1n });
    store.close();
  });

  it("starts a new day at UTC midnight", () => {
    expect(dayOf(86_399)).toBe(0);
    expect(dayOf(86_400)).toBe(1);
  });
});
