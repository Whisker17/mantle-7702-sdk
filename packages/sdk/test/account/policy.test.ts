import { getAddress, zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  allowancePairs,
  assertHookFlags,
  loadDeployments,
  type Policy,
  PrivateKeySigner,
  RuleKind,
  removedAllowancePairs,
  SELECTORS,
  signBatchedCall,
  validatePolicy,
  validatePolicyUpdate,
} from "../../src/index.js";

const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const OTHER = getAddress("0x00000000000000000000000000000000000000b0");

const policy = (over: Partial<Policy> = {}): Policy => ({
  maxValuePerCall: 0n,
  mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
  quoteLimits: [{ token: USD, totalCap: 1000n, periodCap: 500n }],
  periodLength: 3600,
  permissions: [
    { target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE },
    { target: PAD, selector: SELECTORS.buy, ruleKind: RuleKind.LAUNCHPAD_BUY },
    { target: PAD, selector: SELECTORS.sell, ruleKind: RuleKind.LAUNCHPAD_SELL },
  ],
  trustedSpenders: [PAD, OTHER],
  maxDeadlineWindow: 600,
  ...over,
});

describe("policy guards", () => {
  it("accepts the acceptance policy", () => {
    expect(() => validatePolicy(policy())).not.toThrow();
  });

  it("allows only approve on a quote asset", () => {
    const transfer = { target: USD, selector: "0xa9059cbb" as const, ruleKind: RuleKind.NONE };
    expect(() => validatePolicy(policy({ permissions: [transfer] }))).toThrow(/only permission/);
    const inc = {
      target: USD,
      selector: SELECTORS.increaseAllowance,
      ruleKind: RuleKind.NONE,
    };
    expect(() => validatePolicy(policy({ permissions: [inc] }))).toThrow(/does not match/);
    const approveNonQuote = {
      target: OTHER,
      selector: SELECTORS.approve,
      ruleKind: RuleKind.ERC20_APPROVE,
    };
    expect(() => validatePolicy(policy({ permissions: [approveNonQuote] }))).toThrow(
      /not a quote asset/,
    );
  });

  it("rejects mismatched rule kinds, oversize lists, duplicates and a missing MNT limit", () => {
    const wrongKind = { target: PAD, selector: SELECTORS.buy, ruleKind: RuleKind.NONE };
    expect(() => validatePolicy(policy({ permissions: [wrongKind] }))).toThrow(/does not match/);
    expect(() => validatePolicy(policy({ trustedSpenders: Array(5).fill(PAD) }))).toThrow(/4/);
    const dup = { token: USD, totalCap: 1n, periodCap: 1n };
    expect(() => validatePolicy(policy({ quoteLimits: [dup, dup] }))).toThrow(/duplicate/);
    expect(() => validatePolicy(policy({ maxValuePerCall: 1n }))).toThrow(/MNT limit/);
    expect(() =>
      validatePolicy(policy({ mntLimit: { token: USD, totalCap: 1n, periodCap: 0n } })),
    ).toThrow(/zero address/);
  });

  it("I7: requires all five hook flag bits", () => {
    expect(() => assertHookFlags(book.agentPolicyHook)).not.toThrow();
    expect(() => assertHookFlags("0x000000000000000000000000000000000000001e")).toThrow(/0x1f/);
  });
});

describe("policy updates", () => {
  it("allows lowering caps and dropping spenders, refuses raising, removing or re-windowing", () => {
    const old = policy();
    const lowered = policy({ quoteLimits: [{ token: USD, totalCap: 900n, periodCap: 100n }] });
    expect(() => validatePolicyUpdate(old, lowered)).not.toThrow();
    const raised = policy({ quoteLimits: [{ token: USD, totalCap: 1001n, periodCap: 1n }] });
    expect(() => validatePolicyUpdate(old, raised)).toThrow(/raised/);
    expect(() => validatePolicyUpdate(old, policy({ quoteLimits: [], permissions: [] }))).toThrow(
      /removed/,
    );
    expect(() => validatePolicyUpdate(old, policy({ periodLength: 60 }))).toThrow(/periodLength/);
  });

  it("resets exactly the (token, spender) pairs the new policy no longer allows", () => {
    expect(allowancePairs(policy())).toEqual([
      { token: USD, spender: PAD },
      { token: USD, spender: OTHER },
    ]);
    expect(removedAllowancePairs(policy(), policy({ trustedSpenders: [PAD] }))).toEqual([
      { token: USD, spender: OTHER },
    ]);
    expect(removedAllowancePairs(policy(), policy({ trustedSpenders: [OTHER, PAD] }))).toEqual([]);
  });
});

describe("signBatchedCall", () => {
  it("refuses a root batch any executor could relay", async () => {
    const signer = new PrivateKeySigner(generatePrivateKey());
    await expect(
      signBatchedCall({} as never, {
        account: signer.address,
        implementation: book.caliburEntry,
        chainId: 5003,
        signer,
        keyHash: `0x${"00".repeat(32)}`,
        calls: [],
        nonce: 0n,
        executor: zeroAddress,
        deadline: 1n,
      }),
    ).rejects.toThrow(/without an executor/);
  });
});
