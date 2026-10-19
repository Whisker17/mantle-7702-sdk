# e2e

End-to-end suites: an anvil fork of Mantle Sepolia (with a strict-mode Alto bundler for the bundler
path), and the Mantle Sepolia acceptance script (`docs/DESIGN.md` §8, §9). Vitest collects every
`e2e/**/*.test.ts`; like the `*.fork.test.ts` suites they skip without `MANTLE_SEPOLIA_RPC_URL`,
and CI fails when one of them skips or passes nothing.

## `relayer/` — the relayer path

`relayer/relayer.test.ts` runs §8 steps 1–6 through the `mantle-aa` CLI on an anvil fork, twice:
(a) against a long-running sponsor (`mantle-aa sponsor serve`, started by the suite) and (b) in
embedded mode (`MANTLE_AA_EMBEDDED_RELAYER=1`, no service). Each run has its own fork, temporary
`MANTLE_AA_HOME` and sponsor database.

- Fixture: MockUSD minted to the account, MockLaunchpad and its MemeToken; the human holds meme
  before any session exists (bought for them by a third party). Policy: approve / buy / sell on the
  mocks, MockUSD total 100 / period 50 mUSD, the launchpad as the only trusted spender, 24 h expiry.
- Every overreach is refused three times: by `agent exec` (the SDK's local pre-check; nothing is
  sent), by the sponsor's own checks for a request built without that pre-check, and on chain,
  where the batch is signed with the session key and sent straight to the account by a funded
  third-party EOA; the test asserts the revert reason comes from `AgentPolicyHook` or Calibur.
- Covered: a target outside the allowlist, an over-limit approve and buy, selling more than the
  session's inventory while the human's meme covers the balance, a call to the hook, an ERC-1271
  signature by the session key (on chain only: no CLI or sponsor path signs one), an expired key,
  a deadline out of range, `recipient ≠ self`; after `session revoke`, old and new signatures, the
  re-grant of the same key and a Calibur-only re-registration of it.
- Not covered here: a wrong paymaster (bundler path, `bundler/path.test.ts`), the MNT value
  case, panic and the entry-point matrix (later suites and the contract tests).

```bash
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz pnpm exec vitest run e2e
```

## `bundler/` — the strict-mode bundler

The settled setup is in `docs/infra.md` §10: Alto 0.0.21 in safe mode against EntryPoint v0.8,
with `alto/safe-validator.patch`. Alto's whole dependency tree is pinned by
`alto/package-lock.json` and installed with `npm ci` outside the pnpm workspace.

- `harness.ts`: what a fork suite starts and stops itself. `startBundlerStack(upstreamRpcUrl)`
  starts an anvil fork and Alto on it, with three random executor keys funded on the fork. It
  returns `{ rpcUrl, client, bundler: { url, entryPoint, executors, timeline, traced }, stop }`.
  `timeline(since)` is Alto's log since a time, for failure messages; `traced(sender, since)`
  waits until Alto has logged the ERC-7562 trace of a UserOp of `sender` validated since then, the
  per-op proof that safe-mode validation ran. `startFork` and `startAlto({ rpcUrl, executorKeys })`
  are its two halves. `setPaymasterSigner` swaps the deployed VerifyingPaymaster's signer on a fork
  for a key the test holds. Ports are random, every wait is bounded, and `stop()` kills every
  process. What the harness does against Alto's stalls and the fork's per-block upstream reads,
  measured: `docs/infra.md` §10.6. In short: the fork mines a block per transaction and one every
  second besides, because Alto (and viem's receipt waits) notice an inclusion only on a later
  block; Alto gets several executors, because every validation needs a free one and a bundle
  holds its own until then; and the Prague system contracts' ring buffers are zeroed on the fork,
  because otherwise anvil reads three storage slots from the upstream RPC for every block.
- `userop.ts`: `sendSponsoredUserOp` builds, sizes, sponsors (paymaster data signed directly with
  the signer key), signs, sends and awaits one UserOp for a Calibur account.
- `bundler.test.ts`: the smoke suite. A fresh EOA's root init UserOp with `eip7702Auth`,
  sponsored by the deployed paymaster, lands as a type-4 bundle. With mining stopped, a second
  op is validated and bundled while the first op's bundle is still unmined.
- `path.test.ts`: §8 steps 1–6 through the bundler path (`--via bundler`), twice like the relayer
  suite: (a) against `mantle-aa sponsor serve` with a paymaster signer key, (b) in embedded mode
  (`MANTLE_AA_EMBEDDED_RELAYER=1` + `MANTLE_AA_PAYMASTER_SIGNER_KEY`). Each run starts its own fork
  and Alto and swaps the deployed VerifyingPaymaster's signer for the sponsor's key, so the root's
  init UserOp (2-byte `0x7702` initCode) and every session UserOp land through the deployed
  paymaster code. Same fixture, policy and 0-MNT assertions as the relayer suite; the account's
  EntryPoint deposit also stays 0. Every bundled op must also show that Alto traced its validation
  in safe mode.
  - Every overreach is refused three times: by `agent exec` (nothing reaches the bundler), by the
    sponsor's paymaster service for a request built without the pre-check, and on chain: the test
    signs the session UserOp with the session key, signs its paymaster data itself with the swapped
    signer key (a paymaster that would sponsor anything), and a funded third-party EOA calls
    `EntryPoint.handleOps`. The hook stops the op in execution (`UserOperationEvent` success false,
    the hook's error in `UserOperationRevertReason`) and the account's balances, allowance, limits
    and inventory are unchanged. Covered as in the relayer suite, plus: a sponsorship window that
    has passed (`AA32`, on chain only: the SDK never asks with one and the sponsor's
    `REQUEST_EXPIRED` is unit-tested), an expired key (`AA22`), and after revoke `AA24` (Calibur no
    longer knows the key) or, once the key is re-registered on Calibur alone, `AA23 SessionInactive`
    from the hook.
  - I10: a session UserOp with no paymaster, or with another working, funded paymaster (a copy of
    the deployed one), fails validation with `AA23 WrongPaymaster` from the hook's
    `afterValidateUserOp`, even when the account could pay the prefund; strict Alto refuses it
    too, and no balance or deposit changes. A root UserOp may use the other paymaster. The CLI and
    the sponsor have no path to it: the sponsor only signs for its own paymaster, and the SDK
    refuses a sponsor answer naming another.
  - Cross-path replay: a session's SignedBatchedCall does not validate as a UserOp (`AA24`) and runs
    once (`InvalidNonce`); a UserOp does not validate as a SignedBatchedCall (`InvalidSignature`)
    and runs once (`AA25`). The two nonce systems are independent, so the same intent signed again
    for the other path does run again: it is not idempotent across paths (`docs/DESIGN.md` §4.1).
  - Cross-lane consumption, a known limitation: on chain nothing binds a nonce lane to the signing
    key, so a session key's UserOp on another key's lane or on the root lane 0, and its
    SignedBatchedCall on another key's Calibur lane, execute and advance that lane (a DoS of what
    that key had signed; it still executes on the next sequence). The sponsor refuses such
    requests on both paths (`WRONG_LANE`, `ROOT_LANE_MISUSE`); the CLI always signs on the key's
    own lane.
- `sepolia.sh`, `trace-proxy.mjs`, `land-sepolia.ts`: the same Alto against the real chain, with
  `debug_*` traced on a local anvil fork, and the script that landed the UserOp in
  `docs/infra.md` §10.3.

`spike/userop.sh` is the 0.1.0 spike's UserOp builder. It signs in SpikePaymaster's layout, so it
does not work with the deployed paymaster.
