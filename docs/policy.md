# `policy.json`

A session key's policy, as the CLI reads it for `account init --grant`, `session grant` and
`session update`. It is the `setPolicy` struct of `AgentPolicyHook` (`docs/DESIGN.md` §4.2.2)
written as JSON; the CLI's parser is `packages/cli/src/input.ts::parsePolicy`. The hook enforces
the policy on chain on every call the session key makes, on every entry point; the SDK checks
the same rules before it signs, so a refused call costs nothing.

## Example

The policy of the quick start (`docs/DESIGN.md` §8), with the deployed Mantle Sepolia mocks:

```json
{
  "quoteLimits": [
    { "token": "0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526", "totalCap": "100000000", "periodCap": "50000000" }
  ],
  "periodLength": 86400,
  "permissions": [
    { "target": "0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526", "selector": "approve(address,uint256)", "ruleKind": "ERC20_APPROVE" },
    { "target": "0x63614eAb4365EcA8c674D649fF2d3beb1a1cC7E9", "selector": "buy(address,uint256,uint256,uint256,address)", "ruleKind": "LAUNCHPAD_BUY" },
    { "target": "0x63614eAb4365EcA8c674D649fF2d3beb1a1cC7E9", "selector": "sell(address,uint256,uint256,uint256,address)", "ruleKind": "LAUNCHPAD_SELL" }
  ],
  "trustedSpenders": ["0x63614eAb4365EcA8c674D649fF2d3beb1a1cC7E9"],
  "maxDeadlineWindow": 600
}
```

The agent may approve MockUSD to the launchpad and buy and sell there; it may spend at most
100 mUSD of the account's MockUSD over the key's life, and 50 mUSD in any 24-hour window; it moves
no MNT.

## Fields

No other key is accepted (an unknown key is a usage error, exit 1). Amounts are integers in the
token's smallest unit (MockUSD has 6 decimals, MNT 18), as decimal strings; a JSON number is
accepted only up to 2^53 − 1, so use strings.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `quoteLimits` | array of limits, at most 4 | yes | The ERC20 quote assets the session may spend, each with its caps. A token not listed here cannot be spent at all |
| `quoteLimits[].token` | address | | The quote asset; not the zero address, no duplicates |
| `quoteLimits[].totalCap` | amount | | The most the session may spend of it, ever |
| `quoteLimits[].periodCap` | amount | | The most it may spend in one period (ignored when `periodLength` is 0) |
| `periodLength` | integer, seconds | yes | The window of `periodCap`; 0 = total caps only |
| `permissions` | array, at most 16 | yes | The calls the session may make: anything else is refused |
| `permissions[].target` | address | | The contract called |
| `permissions[].selector` | function signature or 4-byte hex | | `"approve(address,uint256)"` or `"0x095ea7b3"`. A call with less than 4 bytes of data (a plain MNT transfer) has selector `0x00000000` |
| `permissions[].ruleKind` | `NONE`, `ERC20_APPROVE`, `LAUNCHPAD_BUY`, `LAUNCHPAD_SELL` (or 0–3) | | The parameter rule for that call, below. It must match the selector |
| `trustedSpenders` | array of addresses, at most 4 | yes | The only spenders an `approve` may name. Each must meet the launchpad contract (`docs/usage.md`, [For launchpad builders](usage.md#for-launchpad-builders)) |
| `maxDeadlineWindow` | integer, seconds | yes | A buy or sell `deadline` must lie in `[now, now + maxDeadlineWindow]` |
| `maxValuePerCall` | amount (wei) | no, default `"0"` | The most MNT one call may carry |
| `mntLimit` | limit with `token` = the zero address | no, default all zero | The MNT caps: `{ "token": "0x0000000000000000000000000000000000000000", "totalCap": "…", "periodCap": "…" }` |

The session key's expiry is not part of the policy: every grant from the CLI is valid for 24
hours (the SDK's `grantSession` takes an `expiry`).

## Rule kinds

`ruleKind` is bound to the selector: `ERC20_APPROVE` only with `approve(address,uint256)`,
`LAUNCHPAD_BUY` only with `buy(address,uint256,uint256,uint256,address)`, `LAUNCHPAD_SELL` only
with `sell(address,uint256,uint256,uint256,address)`, and `NONE` with every other selector.
`increaseAllowance` is always refused.

| `ruleKind` | Allowed on | What the hook checks on each call |
| --- | --- | --- |
| `ERC20_APPROVE` | a token in `quoteLimits` | `approve(spender, amount)`: `spender` is in `trustedSpenders`, and `amount` is at most what is left of that asset's caps (the smaller of total and period) |
| `LAUNCHPAD_BUY` | a launchpad whose `quoteToken()` is in `quoteLimits` | `buy(token, amountIn, minOut, deadline, recipient)`: `recipient` is the account, the deadline is in the window, `token` is not a quote asset. The meme the call brings in is added to this session's inventory |
| `LAUNCHPAD_SELL` | a launchpad | `sell(token, amount, minOut, deadline, recipient)`: as for buy, plus `amount` ≤ this session's inventory of `token`, the account holds at least what all sessions together have been attributed, and exactly `amount` leaves the account (no partial fills) |
| `NONE` | any target except a quote asset and the hook | Nothing beyond the call being listed, and the MNT checks below |

The only permission allowed on a quote asset is `ERC20_APPROVE`: `transfer`, `transferFrom` and
any other selector on a token in `quoteLimits` makes the whole policy invalid.

## How spending is metered

- **Quote assets** are metered by the account's balance decrease over each call; an inflow
  never restores past spending. A buy is charged when the
  launchpad pulls the quote asset, not when it is approved; the approve is only bounded by the
  remaining limit.
- **MNT** is metered by the `value` of each call, against `maxValuePerCall` and `mntLimit`. MNT
  that comes back is not credited. With `maxValuePerCall` above 0, `mntLimit.totalCap` must be
  above 0 too.
- **Periods** are fixed windows from the moment the policy was set: window `n` covers
  `[anchor + n × periodLength, anchor + (n + 1) × periodLength)`. The period counter resets when a
  new window starts; the total never does. Up to twice `periodCap` can be spent in a short span
  across a window boundary.
- **Inventory**: a session can sell only what it bought itself. Meme the human held before, an
  airdrop, or another session's purchase is never attributed to it. After a revoke, the key's
  inventory stays attributed and frozen until the human releases it.
- Gas is paid by the sponsor and is not counted against any cap.

What `account status` reports as remaining is the smaller of the total and the period allowance
left, per asset.

## Size limits and validity

The hook refuses a policy (on `setPolicy` and `updatePolicy`, so the grant transaction reverts)
when any of these fails. The SDK checks the rules of a single policy before signing, except the
launchpad's `quoteToken()`; the session count is checked on chain only.

- At most 4 `quoteLimits`, 4 `trustedSpenders`, 16 `permissions`; at most 8 active sessions per
  account.
- No zero-address or duplicate quote asset; `mntLimit.token` is the zero address.
- Each `ruleKind` matches its selector, as above.
- `ERC20_APPROVE` targets only quote assets; a quote asset has no permission other than approve.
- The `quoteToken()` of every `LAUNCHPAD_BUY` target is in `quoteLimits`.
- `maxValuePerCall` > 0 needs an `mntLimit`.

## Updating a policy

`mantle-aa session update --agent <name> --policy <file>` replaces the policy of the agent's
current key without a new key, and can only tighten it:

- `periodLength` cannot change, and the window anchor and every counter are kept;
- every existing quote asset stays, and no cap (quote or MNT) may rise;
- a cap set below what was already spent blocks further spending of that asset.

Allowances to `(quote asset, spender)` pairs the new policy no longer allows are reset to 0 in the
same transaction. To loosen a policy, grant a new session (`session grant`, a new key with new
limits) and revoke the old one.

## A policy that pays MNT

The acceptance run's value case: the session may send at most 0.005 MNT per call and 0.008 MNT in
total to one address (a plain transfer, so the selector is `0x00000000` and the rule `NONE`).

```json
{
  "maxValuePerCall": "5000000000000000",
  "mntLimit": { "token": "0x0000000000000000000000000000000000000000", "totalCap": "8000000000000000", "periodCap": "8000000000000000" },
  "quoteLimits": [],
  "periodLength": 86400,
  "permissions": [
    { "target": "0x…payee", "selector": "0x00000000", "ruleKind": "NONE" }
  ],
  "trustedSpenders": [],
  "maxDeadlineWindow": 600
}
```

The account must hold the MNT it pays; the sponsor pays only gas.
