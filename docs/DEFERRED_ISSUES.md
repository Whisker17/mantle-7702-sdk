# Deferred issues registry

A living log of issues that were **surfaced during review but consciously not fixed**
in the PR that found them. This is not a bug tracker for open work — it is the record of
*known, accepted debt*: things we decided to defer, so a future change touching the same
area starts from knowledge instead of rediscovery.

## How to use this file

- **Add an entry** whenever a review turns up a real issue that a PR deliberately leaves
  unfixed (scope, risk, or priority). Record it here in the same PR that defers it.
- **Reference it** before working on the affected area — check whether the thing you are
  about to "discover" is already logged, and whether a listed fix is now in scope.
- **Close an entry** by moving it to *Resolved* (bottom) with the PR/commit that fixed
  it, rather than deleting — the history is useful.
- Keep entries short. Name the PR and the code symbol (no tracker ids — this file is pushed) so the
  entry stays findable as the code moves.

Severity is the reviewer's judgement at defer time: **High** (correctness/safety, fix
soon — anything weakening an invariant of `docs/DESIGN.md` §4.2.5 defaults to at least High), **Medium**
(operational/perf, fix when convenient), **Low** (nit/consistency).

## Entry format

```markdown
- **<one-line description of the defect>** (<Severity>, <PR>).
  `<file>::<symbol>` — what's wrong, why it was deferred, and what the fix would be.
```

---

## Open

- **Malformed 65-byte paymaster signature reverts instead of returning signature failure** (Low, #11;
  SR-01 in `docs/reviews/0.1.0.md`).
  `contracts/src/VerifyingPaymaster.sol::_validatePaymasterUserOp` — a 65-byte signature with an
  invalid recovery value or a noncanonical encoding reverts inside `ECDSA.recover` instead of
  returning `SIG_VALIDATION_FAILED`; validation still fails closed (no sponsorship is authorised),
  but gas-estimation and admission flows see a validation exception rather than a signature
  failure. Deferred because the paymaster is deployed and the hook binds its address immutably: a
  fix means redeploying the paymaster, re-funding its EntryPoint deposit, and re-mining and
  redeploying the hook. Fix: use `ECDSA.tryRecover` and return
  `_packValidationData(true, validUntil, validAfter)` on a recovery error or signer mismatch;
  update `test_rejectsMalformedTimestampsAndSignature` accordingly. Revisit before any mainnet
  deployment or whenever the paymaster is next redeployed, whichever comes first.
- **Invariant campaign does not independently catch removal of two hook guards** (Info, #11;
  SR-04 in `docs/reviews/0.1.0.md`).
  `contracts/src/AgentPolicyHook.sol` (the `to == hook` rejection and the `beforeExecute` entry
  lock check) / `contracts/test/invariant/AgentPolicyHook.invariant.t.sol` — removing either
  guard is caught by the deterministic matrix and attack tests but not by the invariant campaign,
  because the permission allowlist and the outer `afterExecute` `NotInExecution` failure mask the
  missing guard. Deferred as a verification limitation, not an exploit. Until strengthened, the
  deterministic matrix and attack tests (`TargetIsHook`, the exact inner `Reentrancy` error) must
  stay mandatory. Optional strengthening per the review: add a deliberately permitted
  hook-management attempt to the invariant handler and assert the specific nested re-entry
  rejection instead of relying only on final balance conservation.

The next nine entries were accepted at the 0.1.1 release review (candidate `55cff0c`). Both review
rounds judged them non-blocking for the testnet POC, and 0.1.1 shipped with them. None touches an
on-chain invariant of `docs/DESIGN.md` §4.2.5. All of them are in the off-chain sponsor, SDK, CLI,
tests or CI.

- **Sponsor settles from the first receipt it sees, with no confirmation depth** (Medium, #21).
  `packages/sponsor/src/ledger.ts::Ledger.reconcile` / `Ledger#settle`: the first attempt of a
  request that has a receipt at the node is settled at once. The entry becomes `settled`, the
  receipt cost is charged, the rest of the reservation is released and the result (`success`,
  `reverted` or `cancelled` plus the hash) is final. A reorg that drops or replaces that
  transaction afterwards is never seen. The request would keep a result for a transaction that is
  not on chain, and the counters would keep a charge for it. Accepted because reorgs of the
  Mantle Sepolia head are rare and only sponsor accounting is affected (nothing on chain).
  Fix: settle only after N confirmations, and keep the entry open until then. Revisit before
  mainnet, or when a sponsor runs against a chain or node whose head reorgs.
- **The actual L1 fee can exceed the reservation if the oracle parameters move** (Medium, #21).
  `packages/sponsor/src/fees.ts::relayerFeeBound` reads the GasPriceOracle scalars
  (`operatorFeeScalar`, `operatorFeeConstant`, `tokenRatio`, `getL1FeeUpperBound`) once, when the
  request is priced (`policy.ts`) or bumped/cancelled (`Ledger#replace`). `Ledger#settle` charges
  `fees.ts::receiptCost` without comparing it to the reservation. If the system-configured
  parameters change between reservation and inclusion, the charge can exceed what was reserved, so
  the per-account and daily counters can pass `maxFeePerRequestMnt` / `dailyBudgetMnt` by that
  difference. Accepted because the counters still record the real cost, the scalars change only
  through system configuration, and this is testnet money. Fix: add a margin to the reservation,
  or refuse new requests while the oracle values differ from the ones the open reservations
  used. Revisit when the oracle parameters are changed operationally, or before mainnet budgets.
- **A request the sponsor refused before sending stays refused** (Low, #21).
  `packages/sponsor/src/ledger.ts::Ledger#submit` / `Ledger#release` / `Ledger#reserve`: when the
  relayer cannot prepare the transaction, the node refuses the broadcast, or a restart finds the
  request only reserved, the entry is released with `SUBMISSION_UNAVAILABLE`. That result is
  recorded for the request digest **and** the batch digest (`SponsorStore.entryByBatch`). Re-posting
  the same request, or a new request for the same SignedBatchedCall, returns the same rejection, so
  the client must sign a new batch. `RelayerExecutor.submit` signs again on every call, with a
  clock-derived `deadline`, so a retry in a later second gets a new batch digest. A retry in the
  same second with the same calls reproduces the refused digest. Accepted as the idempotency
  protocol (one batch digest, one recorded outcome). Revisit if clients need a retry that does not
  sign again.
- **`CANCELLED` is a pseudo reject reason, and `SponsorRejectedError` has no `detail` field**
  (Low, #22). `packages/sdk/src/executors/relayer.ts::RelayerExecutor.submit` throws
  `SponsorRejectedError({ reason: "CANCELLED" })` for a `cancelled` relay, and `CANCELLED` is not a
  member of `SponsorRejectCode` (`packages/sdk/src/sponsor/request.ts`).
  `packages/sdk/src/errors.ts::SponsorRejectedError` (#18) has only `reason: string`, and the
  rejection's `detail` from `relayer.ts::rpcError` is appended to `message`, so callers can match
  `reason` but must parse the message for the detail. Accepted because the SDK and CLI map it
  consistently (CLI exit 20, `SPONSOR_REJECTED`). Fix: a typed reason union that includes
  `CANCELLED` (or a separate `RelayCancelledError`), plus a `detail?: string` field. Revisit with
  the next change to the SDK error model, or when a consumer branches on the cancel or the detail.
- **An expired `RelayerExecutor` deadline during a pending re-post loses the transaction hash**
  (Low, #22). `packages/sdk/src/executors/relayer.ts::RelayerExecutor.submit` / `#fetch`: one
  deadline bounds the whole submit. If it expires during the re-post that follows a `pending`
  answer, `#fetch` throws `Sponsor did not answer within … ms`, and the hash from the earlier
  `pending` answers is dropped. The `still pending after … ms (transaction 0x…)` message, which
  carries it, is used only when the deadline expires between polls. Accepted as a usability defect:
  the sponsor still tracks and settles the transaction, and its operator can see the hash with
  `mantle-aa sponsor relayer status`. The SDK caller cannot re-post, because the signed request
  stays inside `submit`. Fix: keep the last `pending` result and attach its hash to the timeout
  error. Revisit when a caller needs the hash after a timeout (e.g. for
  `sponsor relayer bump/cancel`).
- **CLI revoked-key detection matches SDK reason strings** (Low, #24).
  `packages/cli/src/errors.ts::REVOKED_REASONS` copies the `PolicyViolationError.reason` strings
  thrown by `packages/sdk/src/session/session.ts` ("Session key is not registered on the account",
  "Session is revoked") to map them to exit 13 (`KEY_EXPIRED_OR_REVOKED`). The SDK has no
  structured revoked error. Rewording either string in the SDK silently moves revoked keys to exit
  10. `packages/cli/test/errors.test.ts` checks only the CLI's own copy. The real strings are
  checked end to end by the fork tests (`packages/cli/test/cli.fork.test.ts` "session revoke …
  (13)", and `e2e/relayer/relayer.test.ts`). Accepted because those fork tests fail on a
  mismatch. Fix: a structured SDK signal (a `KeyRevokedError` or a reason code) used by both
  packages. Revisit with the next change to the SDK error model or to those messages.
- **The relayer E2E "long-running sponsor" run starts the service inside the test process** (Low,
  #26). `e2e/relayer/relayer.test.ts` (`relayerRun("service")`) starts
  `sponsor serve` through the CLI's `run` imported from `packages/cli/src/index.ts`, in the test's
  own Node process. The HTTP boundary (`sponsor_relay`, `GET /health`) is exercised, but the
  separate OS process is not: process start-up, signal handling and a sponsor restart against the
  same database. Accepted because the HTTP contract is what the SDK depends on, and restart
  reconciliation is covered by the ledger fork tests. Fix: start the built `mantle-aa` binary as a
  child process (with a bounded start-up wait and kill on teardown). Revisit with a sponsor
  deployment or process-lifecycle change.
- **The CI `typescript` job uses most of its 20-minute timeout** (Medium, #20, #26, #41).
  `.github/workflows/ci.yml` job `typescript` (`timeout-minutes: 20`) runs every fork suite
  against the public `https://rpc.sepolia.mantle.xyz`. Measured: 15m04s on `ed2b043`, 12m51s on
  `55cff0c` and 12m40s on `2ffe201`. Public-RPC latency can push it over the limit and make the
  gate flaky. Accepted because every run so far has passed. The bundler-path E2E adds more fork
  time. Fix: raise the timeout, or split the fork suites into their own job. Either is a
  `.github/workflows/` change, which is repo-wide governance, so it goes in a separate PR to
  `dev`. Revisit before the bundler E2E lands, or when the job passes ~17 minutes.
  Update at the 0.1.2 release review: #32 moved the `e2e/` suites into their own `e2e` job
  (`timeout-minutes: 30`), but the `typescript` job still runs every other fork suite, and after
  the bundler suites landed it took 11.6–14.0 min on three runs of one commit and 14.8 min on the
  0.1.2 candidate (`docs/infra.md` §10.6). Accepted again because those runs passed. A fix that
  needs no workflow change: the SDK suites' shared fork helper
  `packages/sdk/test/account/fork.ts::startFork` starts anvil with `--hardfork prague` and does
  not zero the EIP-2935/EIP-4788 ring buffers, so on anvil 1.8.5 (CI's) every block it mines
  first reads three storage slots from the public RPC. #41 removed exactly that cost from the
  bundler harness (`e2e/bundler/harness.ts::localSystemRings`). Applying it to `startFork` would
  give margin; it carries the test-fidelity caveat of the harness entry below. Revisit when the
  job passes ~17 minutes again, or with the next change to `fork.ts`.
- **The fee-bound test does not record where its oracle values come from** (Low, #27).
  `packages/sponsor/test/fees.test.ts::SPIKE`: the `oracle.l1FeeUpperBound` values for sizes
  2076 (type-4 grant, 79 885) and 860 (session call, 33 812) were not measured by the 0.1.0
  spike. They were re-queried from the Mantle Sepolia GasPriceOracle at blocks 45377548 /
  45377563 when #27 increased the sized nonce (the same query returns the old 2075 → 79 847 and
  859 → 33 774 exactly). The file only says "at block N-1", and `docs/infra.md` §5 lists neither
  value. Without the block numbers, a later change cannot tell an oracle-parameter update from a
  size change. Fix: one comment next to `SPIKE` naming both blocks and the query. Revisit the next
  time `fees.test.ts` or `relayerFeeBound` changes.

The next nine entries were accepted at the 0.1.2 release review (candidate `bd19e2d`). Both review
rounds judged them non-blocking for the testnet POC, and 0.1.2 shipped with them. The tenth item
of that review, the CI `typescript` job's margin, is the update to the CI entry above. Cross-lane
nonce consumption, also accepted there, is a known Calibur limitation already recorded in
`docs/DESIGN.md` §4.1 and `e2e/README.md` (`bundler/`, cross-lane consumption), so it has no
entry here. None of the nine weakens an on-chain invariant of `docs/DESIGN.md` §4.2.5.

- **A sponsorship issued for one session key can be used by another key of the same account**
  (Medium, #34). `packages/sponsor/src/paymaster.ts::paymasterHash` /
  `contracts/src/VerifyingPaymaster.sol::getHash`: the paymaster signature covers the UserOp's
  fields (nonce, callData, gas, fees, validity) but not the account signature, because under
  ERC-7677 the account signs after sponsorship (`docs/DESIGN.md` §4.3). The sponsor authenticates
  the request with key A and checks A's lane (`decodeUserOp`, `auth.ts::checkLane`), but on chain
  Calibur binds neither the nonce lane nor the paymaster data to the signing key. Another key B
  registered on the account can sign the same sponsored op as `abi.encode(B's keyHash, sig, …)`
  and send it. B's own hook policy applies in validation and execution: calls B may not make
  revert (the sponsor pays for a reverted execution), calls B may make were open to B anyway. The
  cost stays within A's reservation and is charged to it (`PaymasterLedger#settle`: A's request,
  account and budget class), and A's op then fails on the consumed nonce. Accepted because the
  sponsor is not a security boundary (`docs/DESIGN.md` §4.0), the on-chain policy still holds,
  and only attribution and one sponsored fee are at stake. A fix needs the paymaster to bind the
  key, e.g. the keyHash in the paymaster data and a paymaster check of the signature's key, which
  means redeploying the paymaster and the hook bound to it. Revisit before mainnet, or if
  per-key sponsorship budgets are introduced.
- **An unsent sponsorship holds the account's single in-flight slot until its `validUntil`**
  (Low, #34). `packages/sponsor/src/paymaster.ts::PaymasterLedger.sponsor` reserves when it signs;
  `PaymasterLedger.reconcile` releases an entry only once a searched block's timestamp is past
  its `validUntil`, and `sponsorUserOp` refuses every other request of the account with
  `SPONSOR_BUSY` until then (the on-demand reconcile from #37 does not help, because the op could
  still be included). A client that obtains paymaster data and never sends the op, or whose send
  the bundler refuses, blocks the account for the rest of the window: 60 s from the SDK
  (`packages/sdk/src/executors/bundler.ts::BundlerExecutorOptions.validitySeconds`), up to
  `maxRequestValiditySeconds` (default 300 s) for another client. Accepted because the window is
  short and bounded, and releasing earlier would let the sponsor pay for an op it no longer
  tracks. Fix: a request-signed cancel that releases a reservation whose op the bundler never
  accepted, or a shorter sponsor-side cap on the window. Revisit if clients see `SPONSOR_BUSY`
  after abandoned sends.
- **Paymaster settlement takes the first `UserOperationEvent`, with no confirmation depth**
  (Medium, #34). `packages/sponsor/src/paymaster.ts::PaymasterLedger.reconcile` /
  `PaymasterLedger#settle`: the first `UserOperationEvent` found for the op's userOpHash settles
  the entry at once, with its `actualGasCost`, and the result is final; a reorg that drops or
  replaces that bundle afterwards is never seen. Same defect, reason and revisit condition as
  the relayer entry above (`Ledger.reconcile`); fix both together: settle only after N
  confirmations.
- **`DeployPaymaster.verify` checks the paymaster's configuration, not its bytecode or exact
  owner** (Low, #7). `contracts/script/DeployPaymaster.s.sol::verify` checks code presence, the
  EntryPoint, `verifyingSigner`, `CALIBUR_ENTRY`, owner ≠ signer and the minimum deposit. It does
  not compare the runtime code hash with `deployments/mantle-sepolia.json`
  (`VerifyingPaymaster.runtimeCodeHash`) or the owner with the recorded `owner`, so a different
  contract exposing the same getters would pass. `DeployHook.s.sol` already checks its recorded
  `runtimeCodeHash`. Raised at the 0.1.0 release review; accepted because the deployed
  paymaster's runtime hash and owner were checked against the book independently then, and no
  contract changed since. Fix: add both checks against the address book, as `DeployHook.s.sol`
  does. Revisit at the next paymaster deployment, or before mainnet.
- **The documented example per-request fee cap is below the init + first grant worst case** (Medium,
  #19, #23). `packages/sponsor/src/config.ts` (the config example in the module comment) gives
  `maxFeePerRequestMnt: "0.05"`, and `policy.maxFeePerRequestMnt` is required, with no default.
  The root's init with the first grant bounds at about 0.055 MNT on Mantle Sepolia
  (`packages/sponsor/src/embedded.ts::EMBEDDED_POLICY_DEFAULTS`, whose cap is 0.5), so a
  sponsor configured from the example refuses that request on both paths. The fork tests raise
  the cap (`relayer-executor.fork.test.ts`, `bundler-executor.fork.test.ts`,
  `cli.bundler.fork.test.ts`). Accepted because every tested configuration sets a larger cap and
  the refusal is a structured rejection, not a loss; the review called it a real usability
  risk for deployments that copy the example. Fix: raise the example to cover init + grant with
  margin (e.g. `"0.1"`), or say next to it that init + grant needs more than 0.05. Revisit before
  a sponsor is deployed from the documented config.
- **The self-hosted bundler's executor loses about 20 % per bundle on Mantle** (Low, #33).
  `docs/infra.md` §10.4: the EntryPoint refunds the bundle executor the op's `actualGasCost`,
  which does not include Mantle's operator fee, and Alto 0.0.21 bids
  `maxPriorityFeePerGas = maxFeePerGas`; the measured Sepolia bundle cost the executor 19.9 % more
  than it was refunded (−0.002378829 MNT). Closing it would take PVG at about 1.58× Alto's
  estimate. Accepted because one
  operator funds both the executor and the paymaster deposit, so raising PVG would only move the
  same MNT, and would add a PVG formula the paymaster signer must also price. Revisit before a
  mainnet or third-party bundler.
- **Alto 0.0.21 never drops an op that fails its pre-bundle re-validation, which can throttle
  the unstaked paymaster** (Medium, #40, #41). Upstream `Mempool.shouldSkip` (`docs/infra.md`
  §10.6, mechanism 2) re-queues such an op forever; every pass lowers the sender's and the
  paymaster's reputation, until Alto refuses ops naming the deployed VerifyingPaymaster with
  `-32505 … is unstaked`, and with it every account the sponsor serves, until Alto restarts. A
  sponsorship window that lapses while the op waits is enough to trigger it. Accepted because the
  fork harness removed the slowness that let windows lapse (`e2e/bundler/harness.ts`), a stalled
  suite fails at its bounded receipt wait with Alto's log, and the fix is upstream (draft report
  in `docs/infra.md` §10.6). It is an operational risk for the Mantle Sepolia acceptance run.
  Options: stake the paymaster, run a bundler with the fix, watch for `2nd Validation error` in
  its log. Revisit before the Sepolia acceptance, or when Alto releases a fix.
- **After a late bundler refusal, `BundlerExecutor.submit` waits out its whole receipt bound**
  (Low, #35). `packages/sdk/src/executors/bundler.ts::BundlerExecutor.submit` sets
  `validUntil = min(now + validitySeconds (60 s), request.deadline)` when `submit` starts, so the
  sponsor and bundler round trips before the send use up part of the window. If the bundler
  accepts the op and its re-validation then fails because the window passed (the Alto loop
  above), the op can never be included and has no rejected status, but the receipt loop keeps
  polling until `timeoutMs` (default 120 s) and then throws `not included after …`. Accepted
  because the wait is bounded and the error names the userOpHash. Fix: stop polling once the
  chain's time passes `validUntil`, and/or start the window at `pm_getPaymasterData`. Revisit
  with the next change to `BundlerExecutor`, or if callers hit the 120 s wait.
- **The bundler fork harness differs from a live chain in three ways the suites do not cover**
  (Low, #41). `e2e/bundler/harness.ts::localSystemRings` zeroes the EIP-2935 block-hash and
  EIP-4788 beacon-root ring buffers on the fork, so a read of either system contract for a block
  before the fork returns zero; `startFork` mines a block every second besides one per
  transaction (`--block-time 1 --mixed-mining`), and `startBundlerStack` gives Alto three
  executors (`EXECUTORS`), which hides Alto's wait for a free executor wallet (`docs/infra.md`
  §10.6, mechanism 1) that a one-executor bundler such as `e2e/bundler/sepolia.sh` still has.
  Accepted because no account, hook, EntryPoint or paymaster path reads historical block hashes
  or beacon roots, each block writes its real values, and the changes made the suites
  deterministic. Revisit if a contract or test starts reading historical system-contract values,
  or when an operated bundler with a single executor is used.

---

## Resolved

_(none yet)_
