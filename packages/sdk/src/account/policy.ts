import { type Address, getAddress, type Hex, toFunctionSelector } from "viem";

/** `RuleKind` of `IAgentPolicyHook.sol`. */
export const RuleKind = { NONE: 0, ERC20_APPROVE: 1, LAUNCHPAD_BUY: 2, LAUNCHPAD_SELL: 3 } as const;
export type RuleKind = (typeof RuleKind)[keyof typeof RuleKind];

export interface QuoteLimit {
  token: Address;
  totalCap: bigint;
  periodCap: bigint;
}

export interface CallPermission {
  target: Address;
  selector: Hex;
  ruleKind: number;
}

/** A session policy as `setPolicy` / `updatePolicy` take it (docs/DESIGN.md §4.2.2). */
export interface Policy {
  maxValuePerCall: bigint;
  /** MNT limit; `token` must be the zero address. */
  mntLimit: QuoteLimit;
  quoteLimits: readonly QuoteLimit[];
  periodLength: number;
  permissions: readonly CallPermission[];
  trustedSpenders: readonly Address[];
  maxDeadlineWindow: number;
}

export const SELECTORS = {
  approve: toFunctionSelector("approve(address,uint256)"),
  increaseAllowance: toFunctionSelector("increaseAllowance(address,uint256)"),
  buy: toFunctionSelector("buy(address,uint256,uint256,uint256,address)"),
  sell: toFunctionSelector("sell(address,uint256,uint256,uint256,address)"),
} as const;

const LIMITS = { quoteLimits: 4, trustedSpenders: 4, permissions: 16 } as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isQuote = (p: Policy, token: Address) => p.quoteLimits.some((q) => same(q.token, token));

/** I7: Calibur selects callbacks from the hook address's low five bits; all five must be set. */
export function assertHookFlags(hook: Address): void {
  if ((BigInt(hook) & 0x1fn) !== 0x1fn) {
    throw new Error(`Hook ${hook} does not have all five callback flags (low bits 0x1f)`);
  }
}

/**
 * The hook's chain-independent policy validity checks, run before anything is signed (fail
 * closed). The launchpad `quoteToken()` check and the inventory check stay on chain.
 */
export function validatePolicy(p: Policy): void {
  const fail = (reason: string) => {
    throw new Error(`Invalid policy: ${reason}`);
  };
  if (p.quoteLimits.length > LIMITS.quoteLimits) fail("more than 4 quote limits");
  if (p.trustedSpenders.length > LIMITS.trustedSpenders) fail("more than 4 trusted spenders");
  if (p.permissions.length > LIMITS.permissions) fail("more than 16 permissions");
  if (BigInt(p.mntLimit.token) !== 0n) fail("mntLimit.token must be the zero address");
  if (p.maxValuePerCall !== 0n && p.mntLimit.totalCap === 0n) {
    fail("maxValuePerCall > 0 needs an MNT limit");
  }
  p.quoteLimits.forEach((q, i) => {
    if (BigInt(q.token) === 0n) fail("quote asset is the zero address");
    if (p.quoteLimits.findIndex((o) => same(o.token, q.token)) !== i) {
      fail(`duplicate quote asset ${q.token}`);
    }
  });
  for (const perm of p.permissions) {
    const sel = perm.selector.toLowerCase();
    const expected =
      sel === SELECTORS.approve
        ? RuleKind.ERC20_APPROVE
        : sel === SELECTORS.buy
          ? RuleKind.LAUNCHPAD_BUY
          : sel === SELECTORS.sell
            ? RuleKind.LAUNCHPAD_SELL
            : RuleKind.NONE;
    if (sel === SELECTORS.increaseAllowance || perm.ruleKind !== expected) {
      fail(`rule kind ${perm.ruleKind} does not match selector ${sel} on ${perm.target}`);
    }
    const quote = isQuote(p, perm.target);
    if (expected === RuleKind.ERC20_APPROVE && !quote) {
      fail(`approve target ${perm.target} is not a quote asset`);
    }
    if (expected !== RuleKind.ERC20_APPROVE && quote) {
      fail(`the only permission allowed on quote asset ${perm.target} is approve`);
    }
  }
}

/** `updatePolicy`'s monotonicity rules: same period, no quote asset removed, no cap raised. */
export function validatePolicyUpdate(old: Policy, next: Policy): void {
  validatePolicy(next);
  const fail = (reason: string) => {
    throw new Error(`Invalid policy update: ${reason}`);
  };
  if (next.periodLength !== old.periodLength) fail("periodLength cannot change");
  const raised = (o: QuoteLimit, n: QuoteLimit) =>
    n.totalCap > o.totalCap || n.periodCap > o.periodCap;
  if (raised(old.mntLimit, next.mntLimit)) fail("MNT cap raised");
  for (const o of old.quoteLimits) {
    const n = next.quoteLimits.find((q) => same(q.token, o.token));
    if (!n) fail(`quote asset ${o.token} removed`);
    else if (raised(o, n)) fail(`cap of ${o.token} raised`);
  }
}

export interface AllowancePair {
  token: Address;
  spender: Address;
}

/** Every ERC20 allowance a policy lets a session create: quote asset × trusted spender. */
export function allowancePairs(p: Policy): AllowancePair[] {
  return p.quoteLimits.flatMap((q) =>
    p.trustedSpenders.map((s) => ({ token: getAddress(q.token), spender: getAddress(s) })),
  );
}

/** Pairs of `old` absent from `next`: the allowances an update must reset to 0. */
export function removedAllowancePairs(old: Policy, next: Policy): AllowancePair[] {
  const kept = new Set(allowancePairs(next).map((x) => `${x.token}:${x.spender}`));
  return allowancePairs(old).filter((x) => !kept.has(`${x.token}:${x.spender}`));
}
