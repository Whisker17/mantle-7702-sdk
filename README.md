# mantle-7702-sdk

EIP-7702 smart accounts for AI agents on Mantle: upgrade an EOA in place, grant agents
scoped and revocable session keys enforced on-chain, and let a sponsor pay every
transaction — through a relayer or an ERC-4337 bundler.

> **Status: proof of concept, under construction.** Mantle Sepolia only. The contracts are
> not audited; do not use them with real funds.

- Design (spec of record): [`docs/DESIGN.md`](docs/DESIGN.md)
- Agent and contributor guide: [`AGENTS.md`](AGENTS.md)

## Development

```bash
pnpm install
pnpm check        # lint + typecheck + test
```

Requires Node 24, pnpm 11 and Foundry.
