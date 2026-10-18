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

---

## Resolved

_(none yet)_
