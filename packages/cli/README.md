# @mantle-aa/cli

The `mantle-aa` command (docs/DESIGN.md §6). Build with `pnpm build`; run `node packages/cli/dist/bin.js`
(the package's `bin` is `mantle-aa`). `mantle-aa --help` lists the commands.

## Settings

| Setting | Flag | Environment |
| --- | --- | --- |
| Chain RPC URL (no default network) | `--rpc-url` | `MANTLE_AA_RPC_URL` |
| Long-running sponsor | `--sponsor-url` | `MANTLE_AA_SPONSOR_URL` |
| Embedded sponsor (tests, local demos) | | `MANTLE_AA_EMBEDDED_RELAYER=1` and `MANTLE_AA_RELAYER_KEY` |
| Submission path (default `relayer`) | `--via relayer\|bundler` | |
| ERC-4337 bundler (`--via bundler`) | `--bundler-url` | `MANTLE_AA_BUNDLER_URL` |
| Embedded sponsor's paymaster signer (`--via bundler`) | | `MANTLE_AA_PAYMASTER_SIGNER_KEY` |
| Keystore password | interactive prompt | `MANTLE_AA_KEYSTORE_PASSWORD` |
| Key and profile directory | | `MANTLE_AA_HOME` (default `~/.mantle-aa`) |

A sponsor is reached only by commands that submit. With the embedded sponsor each such command
starts the sponsor in process, allowlisting the profile's account, with its ledger in
`<home>/embedded-sponsor.sqlite`, and stops it before exiting. Use a sponsor URL or the embedded
sponsor, not both.

`--via` chooses how every submitting command — `account init`, `account exec`, `account panic`
(without `--self-pay`), `session grant|update|revoke` and `agent exec` — reaches the chain. `relayer` (the default) sends
a signed batch to the sponsor's relayer. `bundler` sends an ERC-4337 UserOperation to the bundler,
with paymaster data from the sponsor's ERC-7677 service (`pm_*`, on the same sponsor URL);
`account init` carries the EIP-7702 authorization as the UserOp's `eip7702Auth`. With the embedded
sponsor, `--via bundler` also needs `MANTLE_AA_PAYMASTER_SIGNER_KEY`, the deployed
VerifyingPaymaster's signer key (the sponsor checks it on start); without it the command is a usage
error. Commands that only read accept `--via` and ignore it.

Private keys never go on the command line: `keys import` reads the key from stdin or a prompt.

## Panic

`account panic` is the emergency stop (docs/DESIGN.md §7.3). One transaction revokes every non-root
key that is registered on Calibur or active on the hook (Calibur `revoke` and the hook tombstone),
and resets every `(quote asset, trusted spender)` allowance their policies allow, each pair once.
Inventory is not released: the revoked keys' meme stays attributed and reserved (frozen) until the
root releases it with `account exec --release`.

- Without flags it goes through the `--via` path, like any root batch (the sponsor's management
  budget).
- `--self-pay`: the root EOA sends the transaction itself, calling its own `execute(BatchedCall)`.
  No sponsor is contacted, so it works with the sponsor down; the root must hold MNT for gas.
- `--undelegate` (needs `--self-pay`): once the revocation's receipt is confirmed, a second, type-4
  transaction from the root delegates the EOA to the zero address. The sponsor relays only
  delegations to CaliburEntry, so the root sends this one too. Account storage stays: the hook
  keeps the tombstones and the frozen inventory, which `account status` still shows, and a later
  `account init` delegates again with the revoked keys still revoked.

The result carries `revocation` (`status` `confirmed` or `nothing-to-revoke`, `hash`, `revokedKeys`,
`resetAllowances`), `undelegation` (`status`, `hash`; `null` without `--undelegate`) and `recovery`,
the root's next steps. A failure says which phase failed. "Revocation (phase 1) not confirmed" means
the revocation did not land; "Revocation (phase 1) confirmed in transaction … ; undelegation
(phase 2) failed" means every key is revoked and the account is still delegated. The exit code
comes from the underlying error.

Measured on a Mantle Sepolia fork at the §4.2.3 worst case (8 sessions × 16 distinct allowance
pairs: 8 revokes, 8 tombstones and 128 resets in one transaction): about 1.85 M gas through the
relayer and 1.62 M self-paid. The Mantle Sepolia block gas limit is 60 M
(`test/cli.panic.fork.test.ts`).

## Keys and profiles

`<home>/keys/<name>.json` are encrypted keystores; `<home>/profiles.json` maps a profile name to
`{ account, keyHash, keyfile, role }` (docs/DESIGN.md §5.3).

- `keys new` / `keys import --name <name>` create a root key and a root profile `<name>`. Root
  commands use `--root <name>`, or the only root profile.
- Every grant (`account init --grant`, `session grant`) creates a new session key and a new
  version of the agent's profile: `<agent>` names the new key and the key it named before stays
  reachable as `<agent>.v1`, `<agent>.v2`, ….

A policy file is the `setPolicy` struct as JSON, amounts as decimal strings; `maxValuePerCall` and
`mntLimit` default to zero, a `selector` may be a function signature and a `ruleKind` a name:

```json
{
  "quoteLimits": [{ "token": "0x…MockUSD", "totalCap": "1000000000", "periodCap": "500000000" }],
  "periodLength": 86400,
  "permissions": [
    { "target": "0x…MockUSD", "selector": "approve(address,uint256)", "ruleKind": "ERC20_APPROVE" },
    { "target": "0x…MockLaunchpad", "selector": "buy(address,uint256,uint256,uint256,address)", "ruleKind": "LAUNCHPAD_BUY" }
  ],
  "trustedSpenders": ["0x…MockLaunchpad"],
  "maxDeadlineWindow": 600
}
```

`--calls` is inline JSON: `[{ "to": "0x…", "value": "0", "data": "0x…" }]`.

## Output and exit codes

With `--json`, stdout carries one JSON object per command: `{ "ok": true, "command", "result" }`, or
`{ "ok": false, "command", "exitCode", "error": { "code", "type", "message", …fields } }`. bigints
are decimal strings. `sponsor serve` prints its object once listening and runs until SIGINT or
SIGTERM. The shapes are pinned by the snapshots in `test/__snapshots__/`.

| Exit | `error.code` | Raised by |
| --- | --- | --- |
| 0 | | success |
| 10 | `POLICY_VIOLATION` | `PolicyViolationError`, `DeadlineOutOfRangeError` |
| 11 | `LIMIT_EXCEEDED` | `LimitExceededError` |
| 12 | `INVENTORY_EXCEEDED` | `InventoryExceededError` |
| 13 | `KEY_EXPIRED_OR_REVOKED` | `KeyExpiredError`; a revoked session; the sponsor's `KEY_EXPIRED`, `KEY_INACTIVE`, `KEY_NOT_REGISTERED` |
| 20 | `SPONSOR_REJECTED` | any other `SponsorRejectedError` (`CANCELLED` included) |
| 21 | `SPONSOR_BUSY` | `SponsorBusyError` |
| 30 | `EXECUTION_REVERTED` | `ExecutionRevertedError` (in simulation, in the bundler's simulation, or a batch or UserOp that reverted on chain) |
| 1 | `USAGE`, `NOT_AVAILABLE`, `ERROR` | bad arguments or settings (`--via bundler` without a bundler URL, `account panic --undelegate` without `--self-pay`); anything else |

No output contains a private key or the password, and URLs in error messages are redacted.

In tests, call `run(argv, { env, stdout, stderr, stdin, signal })` from `@mantle-aa/cli` (its exit
code is the resolved value) or spawn the built binary.
