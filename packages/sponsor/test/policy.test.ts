import {
  agentPolicyHookAbi,
  caliburAbi,
  ERC20ETH,
  erc20Abi,
  SponsorRejectCode,
} from "@mantle-aa/sdk";
import { type Address, encodeFunctionData, type Hex, parseEther, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import type { SignedBatchedCall } from "../src/auth.js";
import { SponsorRejection } from "../src/auth.js";
import { checkAllowlist, checkBudget, classify } from "../src/policy.js";
import type { BudgetClass, DailyUsage } from "../src/store.js";
import { book, testConfig } from "./fixtures.js";

const SPENDER: Address = "0x0000000000000000000000000000000000000b0b";
const config = testConfig({ allowlist: ["0x00000000000000000000000000000000000000AA"] });
const mnt = (s: string) => parseEther(s);

const usage = (
  over: Partial<Record<"account" | "global", Partial<Record<BudgetClass, bigint>>>> = {},
  gas: Partial<Record<BudgetClass, bigint>> = {},
): DailyUsage => ({
  account: {
    business: { gas: gas.business ?? 0n, fee: over.account?.business ?? 0n },
    management: { gas: gas.management ?? 0n, fee: over.account?.management ?? 0n },
  },
  global: {
    business: { gas: 0n, fee: over.global?.business ?? 0n },
    management: { gas: 0n, fee: over.global?.management ?? 0n },
  },
});

const reason = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SponsorRejection);
    return (error as SponsorRejection).reason;
  }
};

const request = (budgetClass: BudgetClass, maxFee: string, gas = 100_000n) => ({
  budgetClass,
  gas,
  maxFee: mnt(maxFee),
});

describe("checkBudget", () => {
  it("accepts a request within every cap", () => {
    expect(reason(() => checkBudget(config, usage(), request("business", "0.01")))).toBeUndefined();
  });

  it("enforces the per-request fee cap on every class", () => {
    for (const c of ["business", "management"] as const) {
      expect(reason(() => checkBudget(config, usage(), request(c, "0.050000000000000001")))).toBe(
        SponsorRejectCode.REQUEST_FEE_CAP,
      );
      expect(reason(() => checkBudget(config, usage(), request(c, "0.05")))).toBeUndefined();
    }
  });

  it("enforces the per-account daily gas cap per class, so business traffic cannot block a revoke", () => {
    const busy = usage({}, { business: 4_950_000n });
    expect(reason(() => checkBudget(config, busy, request("business", "0.01", 50_000n)))).toBe(
      undefined,
    );
    expect(reason(() => checkBudget(config, busy, request("business", "0.01", 50_001n)))).toBe(
      SponsorRejectCode.ACCOUNT_GAS_CAP,
    );
    expect(
      reason(() => checkBudget(config, busy, request("management", "0.01", 1_000_000n))),
    ).toBeUndefined();
    const managed = usage({}, { management: 4_950_000n });
    expect(reason(() => checkBudget(config, managed, request("management", "0.01", 50_001n)))).toBe(
      SponsorRejectCode.ACCOUNT_GAS_CAP,
    );
  });

  it("keeps the unused management reserve out of reach of business requests", () => {
    // Budget 5, reserve 1: business may spend 4 while management has spent nothing.
    const nearly = usage({ global: { business: mnt("3.99") } });
    expect(reason(() => checkBudget(config, nearly, request("business", "0.01")))).toBeUndefined();
    expect(
      reason(() => checkBudget(config, nearly, request("business", "0.010000000000000001"))),
    ).toBe(SponsorRejectCode.DAILY_BUDGET);
    // Management can still spend the reserve when business has used its whole share.
    const exhausted = usage({ global: { business: mnt("4") } });
    expect(reason(() => checkBudget(config, exhausted, request("business", "0.000001")))).toBe(
      SponsorRejectCode.DAILY_BUDGET,
    );
    expect(reason(() => checkBudget(config, exhausted, request("management", "0.05")))).toBe(
      undefined,
    );
    // Reserve spent by management no longer holds anything back.
    const used = usage({ global: { business: mnt("3.5"), management: mnt("1") } });
    expect(reason(() => checkBudget(config, used, request("business", "0.05")))).toBeUndefined();
  });

  it("caps management requests at the global daily budget", () => {
    const full = usage({ global: { business: mnt("4"), management: mnt("0.96") } });
    expect(reason(() => checkBudget(config, full, request("management", "0.04")))).toBeUndefined();
    expect(
      reason(() => checkBudget(config, full, request("management", "0.040000000000000001"))),
    ).toBe(SponsorRejectCode.MANAGEMENT_BUDGET);
  });
});

describe("checkAllowlist", () => {
  it("sponsors only allowlisted accounts", () => {
    expect(reason(() => checkAllowlist(config, "0x00000000000000000000000000000000000000AA"))).toBe(
      undefined,
    );
    expect(reason(() => checkAllowlist(config, "0x00000000000000000000000000000000000000AB"))).toBe(
      SponsorRejectCode.NOT_ALLOWLISTED,
    );
  });
});

describe("classify", () => {
  const account = "0x00000000000000000000000000000000000000AA" as Address;
  const batch = (keyHash: Hex, calls: { to: Address; value?: bigint; data: Hex }[]) =>
    ({
      batchedCall: { calls: calls.map((c) => ({ value: 0n, ...c })), revertOnFailure: true },
      nonce: 0n,
      keyHash,
      executor: SPENDER,
      deadline: 0n,
    }) as SignedBatchedCall;
  const self = (data: Hex) => ({ to: account, data });
  const hook = (data: Hex) => ({ to: book.agentPolicyHook, data });
  const approve = (amount: bigint) => ({
    to: book.mockUsd,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, amount] }),
  });
  const revokeKey = encodeFunctionData({
    abi: caliburAbi,
    functionName: "revoke",
    args: [zeroHash],
  });

  it("puts root init, grant and revoke batches on the management budget", () => {
    const init = self(
      encodeFunctionData({ abi: caliburAbi, functionName: "approveNative", args: [ERC20ETH, 0n] }),
    );
    const hookRevoke = hook(
      encodeFunctionData({ abi: agentPolicyHookAbi, functionName: "revoke", args: [zeroHash] }),
    );
    expect(classify(batch(zeroHash, [init]), account, config)).toBe("management");
    expect(
      classify(batch(zeroHash, [self(revokeKey), hookRevoke, approve(0n)]), account, config),
    ).toBe("management");
  });

  it("puts everything else on the business budget", () => {
    const session = `0x${"ab".repeat(32)}` as Hex;
    expect(classify(batch(session, [self(revokeKey)]), account, config)).toBe("business");
    expect(classify(batch(zeroHash, [self(revokeKey), approve(1n)]), account, config)).toBe(
      "business",
    );
    expect(classify(batch(zeroHash, [{ ...self(revokeKey), value: 1n }]), account, config)).toBe(
      "business",
    );
    expect(classify(batch(zeroHash, [{ to: SPENDER, data: revokeKey }]), account, config)).toBe(
      "business",
    );
    expect(classify(batch(zeroHash, []), account, config)).toBe("business");
  });
});
