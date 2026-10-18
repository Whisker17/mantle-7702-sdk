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
- **The CI `typescript` job uses most of its 20-minute timeout** (Medium, #20, #26).
  `.github/workflows/ci.yml` job `typescript` (`timeout-minutes: 20`) runs every fork suite
  against the public `https://rpc.sepolia.mantle.xyz`. Measured: 15m04s on `ed2b043`, 12m51s on
  `55cff0c` and 12m40s on `2ffe201`. Public-RPC latency can push it over the limit and make the
  gate flaky. Accepted because every run so far has passed. The bundler-path E2E adds more fork
  time. Fix: raise the timeout, or split the fork suites into their own job. Either is a
  `.github/workflows/` change, which is repo-wide governance, so it goes in a separate PR to
  `dev`. Revisit before the bundler E2E lands, or when the job passes ~17 minutes.
- **The fee-bound test does not record where its oracle values come from** (Low, #27).
  `packages/sponsor/test/fees.test.ts::SPIKE`: the `oracle.l1FeeUpperBound` values for sizes
  2076 (type-4 grant, 79 885) and 860 (session call, 33 812) were not measured by the 0.1.0
  spike. They were re-queried from the Mantle Sepolia GasPriceOracle at blocks 45377548 /
  45377563 when #27 increased the sized nonce (the same query returns the old 2075 → 79 847 and
  859 → 33 774 exactly). The file only says "at block N-1", and `docs/infra.md` §5 lists neither
  value. Without the block numbers, a later change cannot tell an oracle-parameter update from a
  size change. Fix: one comment next to `SPIKE` naming both blocks and the query. Revisit the next
  time `fees.test.ts` or `relayerFeeBound` changes.

---

## Resolved

_(none yet)_
