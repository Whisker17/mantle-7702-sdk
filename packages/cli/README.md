# @mantle-aa/cli

The `mantle-aa` command (docs/DESIGN.md §6). Build with `pnpm build`; run `node packages/cli/dist/bin.js`
(the package's `bin` is `mantle-aa`). `mantle-aa --help` lists the commands.

## Settings

| Setting | Flag | Environment |
| --- | --- | --- |
| Chain RPC URL (no default network) | `--rpc-url` | `MANTLE_AA_RPC_URL` |
| Long-running sponsor | `--sponsor-url` | `MANTLE_AA_SPONSOR_URL` |
| Embedded sponsor (tests, local demos) | | `MANTLE_AA_EMBEDDED_RELAYER=1` and `MANTLE_AA_RELAYER_KEY` |
| Keystore password | interactive prompt | `MANTLE_AA_KEYSTORE_PASSWORD` |
| Key and profile directory | | `MANTLE_AA_HOME` (default `~/.mantle-aa`) |

A sponsor is reached only by commands that submit. With the embedded sponsor each such command
starts the sponsor in process, allowlisting the profile's account, with its ledger in
`<home>/embedded-sponsor.sqlite`, and stops it before exiting. Use a sponsor URL or the embedded
sponsor, not both.

Private keys never go on the command line: `keys import` reads the key from stdin or a prompt.

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
| 30 | `EXECUTION_REVERTED` | `ExecutionRevertedError` (in simulation, or a batch that reverted on chain) |
| 1 | `USAGE`, `NOT_AVAILABLE`, `ERROR` | bad arguments or settings; `account panic` and `agent exec --via bundler` (later versions); anything else |

No output contains a private key or the password, and URLs in error messages are redacted.

In tests, call `run(argv, { env, stdout, stderr, stdin, signal })` from `@mantle-aa/cli` (its exit
code is the resolved value) or spawn the built binary.
