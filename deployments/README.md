# deployments

Committed address books, one JSON file per network (`mantle-sepolia.json`). Written by the
deployment scripts under `contracts/script/`.

## Schema

Top level: `chainId` (number) plus one object per contract, keyed by contract name.

| Field | Meaning |
| --- | --- |
| `address` | Deployed address (checksummed) |
| `deployTx` | Deployment transaction hash |
| `block` | Block number of `deployTx` |
| `deployer` | EOA that sent `deployTx` |
| `method` | `create2-deterministic` (through `factory` with `salt`) or `create` |
| `factory`, `salt` | Only for `create2-deterministic`; `factory` is the CREATE2 deterministic deployer `0x4e59…956C` |
| `initCodeHash` | keccak256 of the init code (creation code + constructor args) |
| `runtimeCodeHash` | keccak256 of the code at `address` on chain |
| `compiler` | Exactly what produced the bytecode: `solc`, `evmVersion`, `optimizer`, `optimizerRuns`, `viaIr`, `bytecodeHash`, and the `foundryProfile` in `contracts/foundry.toml` that reproduces it |
| `source` | `submodule` path (or `contracts/src` for our own code), `repository`, `tag`, `commit`, `contract` (`path:Name`) |

Contract-specific fields are added next to these (for example `CaliburEntry.eip712Domain`,
`canonicalAddressReproduced`, `canonicalAddressReason`).

## Verify

```sh
cd contracts
FOUNDRY_PROFILE=calibur forge script script/DeployCalibur.s.sol --sig 'verify()' \
  --rpc-url "$MANTLE_SEPOLIA_RPC_URL"
```

Read-only. Rebuilds the init code, recomputes the CREATE2 address, and checks the on-chain
code hash and `eip712Domain()` against `mantle-sepolia.json`.
