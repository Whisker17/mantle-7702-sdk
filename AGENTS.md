# AGENTS.md

Instructions for coding agents (Claude Code, Codex, pi, …) and contributors working in
this repository.

## What this is

`mantle-7702-sdk`: an EIP-7702 smart-account layer for Mantle, delivered as a TypeScript
SDK and CLI. A human EOA is upgraded in place to Uniswap Calibur; the human grants AI
agents session keys whose permissions (call allowlist, quote-asset spend caps, per-key
meme inventory) are enforced on-chain by `AgentPolicyHook`; a sponsor service pays gas
over two transports — a signed `execute` submitted by a relayer, or an ERC-4337
EntryPoint v0.8 UserOperation through a bundler and `VerifyingPaymaster`. Target network:
Mantle Sepolia (5003). This is a proof of concept; the contracts are **not audited**.

The spec of record is `docs/DESIGN.md`. Read it before any design or architectural
decision; do not re-derive parameters or decisions recorded there. Its §4.0 trust model,
§4.2.5 invariants and Appendix B review record are binding: a change that weakens an
invariant needs an explicit design amendment, not a code comment.

## Status

The repository holds the toolchain skeleton only (root pnpm workspace, Biome, TypeScript,
Vitest, CI). The packages, the Foundry project and the deployments land with the 0.1.0
work. Read the tree, not this paragraph, before assuming a module or command exists.

## Build, test, run

The checks CI runs on every pull request (`.github/workflows/ci.yml`):

```bash
pnpm install --frozen-lockfile
pnpm lint          # biome check .
pnpm typecheck     # tsc
pnpm build         # every package that has a build script
pnpm test          # vitest run

# once contracts/foundry.toml exists:
cd contracts && forge fmt --check && forge build --sizes && forge test -vvv
```

Toolchain: Node 24 (`.nvmrc`), pnpm 11 (`packageManager`), Foundry (stable). Each
worktree runs its own `pnpm install`; `node_modules/`, `contracts/out/` and
`contracts/cache/` stay inside the worktree and are git-ignored.

## Architecture

Mirrors `docs/DESIGN.md` §3:

- **`contracts/`** — Foundry project: `AgentPolicyHook` (the only custom security-critical
  contract), `VerifyingPaymaster` (ported from eth-infinitism v0.7.0 to the v0.8
  `BasePaymaster`), test mocks (MockUSD, MockLaunchpad, MemeToken), deployment scripts.
  Calibur v1.1.0 (`CaliburEntry`) and account-abstraction v0.8.0 are dependencies, not
  forks.
- **`packages/sdk`** — `@mantle-aa/sdk` (private): account and session management, local
  policy simulation, `RelayerExecutor` and `BundlerExecutor`, keystore signer.
- **`packages/cli`** — `@mantle-aa/cli` (private): the `mantle-aa` command; every command
  supports `--json` and semantic exit codes (`docs/DESIGN.md` §6).
- **`packages/sponsor`** — the sponsor service: request authentication, sponsorship
  policy, reservation ledger, relayer submission, ERC-7677 paymaster signing; also runs
  embedded in the CLI for tests and local demos.
- **`deployments/`** — committed address books (`mantle-sepolia.json`).
- **`e2e/`** — end-to-end suites (anvil fork + strict-mode Alto) and the Sepolia
  acceptance script.

Packages are not published; consumers depend on this repository by git or local link.

## Chain access and secrets

- Chain reads and writes go through an RPC URL passed explicitly or via environment
  variables; there is no hidden default for Mantle mainnet (5000), which is out of scope.
- Private keys live only in encrypted keystores outside the repository
  (`~/.mantle-aa/`) or in environment variables. Never print a key, a keystore password
  or a credentialed RPC URL, and never write one into an artifact, a log, an error, a
  commit or a pull request.
- The sponsor's relayer and paymaster-signer keys are hot wallets: fund them with
  testnet amounts only.

## Skills

Team skills live in `.claude/skills/<name>/SKILL.md` (read the file directly if your
runtime does not load skills). None yet; repeatable procedures (Sepolia deployment, the
acceptance run) are added here once they have been run by hand.

## Contributing

Branch names `type/<topic>`; Conventional Commit messages; PRs use
`.github/pull_request_template.md` and include `forge snapshot --diff` output for any
change under `contracts/`. Known accepted debt goes in `docs/DEFERRED_ISSUES.md`.
