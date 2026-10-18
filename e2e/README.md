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
- Not covered here: a wrong paymaster (bundler path), the MNT value case, panic and the
  entry-point matrix (later suites and the contract tests).

```bash
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz pnpm exec vitest run e2e
```

## `bundler/` — the strict-mode bundler

The settled setup is in `docs/infra.md` §10: Alto 0.0.21 in safe mode against EntryPoint v0.8,
with `alto/safe-validator.patch`. Alto's whole dependency tree is pinned by
`alto/package-lock.json` and installed with `npm ci` outside the pnpm workspace.

- `harness.ts`: what a fork suite starts and stops itself. `startBundlerStack(upstreamRpcUrl)`
  starts an anvil fork and Alto on it, with a random executor key funded on the fork. It returns
  `{ rpcUrl, client, bundler: { url, entryPoint, executor, logs }, stop }`. `startFork` and
  `startAlto({ rpcUrl, executorKey })` are its two halves. `setPaymasterSigner` swaps the deployed
  VerifyingPaymaster's signer on a fork for a key the test holds. Ports are random, every wait is
  bounded, and `stop()` kills every process.
- `userop.ts`: `sendSponsoredUserOp` builds, sizes, sponsors (paymaster data signed directly with
  the signer key), signs, sends and awaits one UserOp for a Calibur account.
- `bundler.test.ts`: the smoke suite. A fresh EOA's root init UserOp with `eip7702Auth`,
  sponsored by the deployed paymaster, lands as a type-4 bundle.
- `sepolia.sh`, `trace-proxy.mjs`, `land-sepolia.ts`: the same Alto against the real chain, with
  `debug_*` traced on a local anvil fork, and the script that landed the UserOp in
  `docs/infra.md` §10.3.

`spike/userop.sh` is the 0.1.0 spike's UserOp builder. It signs in SpikePaymaster's layout, so it
does not work with the deployed paymaster.
