# mantle-7702-sdk

EIP-7702 smart accounts for AI agents on Mantle: upgrade an EOA in place, grant agents
scoped and revocable session keys enforced on-chain, and let a sponsor pay every
transaction — through a relayer or an ERC-4337 bundler.

> **Proof of concept. The contracts are not audited.** Mantle Sepolia (chain 5003) only. Do not
> use any of it with real funds, and fund the sponsor's hot wallets with testnet amounts only.

The human's EOA is delegated to Uniswap Calibur (`CaliburEntry` v1.1.0). Each agent gets its own
session key, hooked to `AgentPolicyHook`, which enforces the key's policy on every call: a call
allowlist, spend caps on quote assets (and MNT), and a per-key inventory of what the agent bought.
The human and the agents hold 0 MNT; a sponsor pays the gas.

| Read | For |
| --- | --- |
| This file | Installing from npm, the quick start and the exit codes |
| [`docs/policy.md`](docs/policy.md) | The `policy.json` a session is granted with |
| [`docs/usage.md`](docs/usage.md) | Running a sponsor and the bundler path, the SDK from TypeScript, installing the packages, the launchpad contract, known limits |
| [`packages/cli/README.md`](packages/cli/README.md) | CLI settings, profiles, `account panic`, the `--json` output |
| [`docs/DESIGN.md`](docs/DESIGN.md) | The spec of record: trust model, hook rules, invariants |
| [`docs/acceptance.md`](docs/acceptance.md) | The full acceptance run on Mantle Sepolia, with transaction links |

## Install

The SDK, the sponsor and the CLI are published to npm under the owner's `@0xwh1sker` scope
(MIT). Each needs Node 24 or later.

| Package | Install | For |
| --- | --- | --- |
| `@0xwh1sker/mantle-aa-cli` | `npm i -g @0xwh1sker/mantle-aa-cli`, or run it without installing: `npx -y @0xwh1sker/mantle-aa-cli <args>` | The `mantle-aa` command |
| `@0xwh1sker/mantle-aa-sdk` | `npm i @0xwh1sker/mantle-aa-sdk viem` | The SDK from TypeScript; `viem` is a peer dependency |
| `@0xwh1sker/mantle-aa-sponsor` | `npm i @0xwh1sker/mantle-aa-sponsor` | Running a sponsor in process (`startSponsor`); the CLI's `sponsor serve` already uses it |

The SDK ships the Mantle Sepolia address book, so nothing else is needed for the relayer path.
The self-hosted bundler stack (`e2e/bundler/sepolia.sh`, a pinned Alto), the contracts and the
end-to-end suites are not in any package: they are in this repository only. Details and the
contributor setup: [`docs/usage.md`](docs/usage.md#installing-the-packages).

## Requirements

Node 24 or later with npm, Foundry (`cast`; `anvil` for the bundler path), `jq` and `curl`. A
Mantle Sepolia wallet with about 0.2 MNT to be the sponsor's relayer. For the bundler path also:
`git` (the bundler stack is in this repository, not in the packages), the private key of the
deployed VerifyingPaymaster's signer (`0x7223c837518A51eF0f6c40d67B539D1Aa29a67E9`, held by the
operator of this deployment) and a second funded wallet for the bundler's executor.

## Quick start (Mantle Sepolia)

This walks through `docs/DESIGN.md` §8 with the CLI: a fresh human key, a sponsor, the account's
upgrade with a first session, an agent buying and selling on the mock launchpad, an overreach the
policy refuses, a submission through a bundler, and a revoke. The commands are meant to be pasted
into one bash shell, in order.

### 1. Install and configure

```bash
npm i -g @0xwh1sker/mantle-aa-cli          # provides the mantle-aa command

export MANTLE_AA_RPC_URL=https://rpc.sepolia.mantle.xyz
export MANTLE_AA_HOME=$(mktemp -d)          # keystores and profiles; default ~/.mantle-aa
export MANTLE_AA_KEYSTORE_PASSWORD='choose-a-password'
```

Set the sponsor's keys in the same shell. The CLI and the sponsor read keys from the environment
only; never put one on a command line or in a file.

```bash
export SPONSOR_RELAYER_ADDRESS=0x…          # the funded relayer wallet
read -rs SPONSOR_RELAYER_KEY && export SPONSOR_RELAYER_KEY            # its private key, 0x…
read -rs SPONSOR_PAYMASTER_SIGNER_KEY && export SPONSOR_PAYMASTER_SIGNER_KEY  # bundler path only
```

The deployed contracts (`deployments/mantle-sepolia.json`) the policy and calls below use:

```bash
USD=0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526    # MockUSD, 6 decimals, anyone can mint
PAD=0x63614eAb4365EcA8c674D649fF2d3beb1a1cC7E9    # MockLaunchpad: 1 mUSD buys 1e21 meme units
MEME=0xAb2D3B4cD4770e2669fe2BA781D449A214EF958f   # MemeToken AMEME, created by the launchpad
```

### 2. Create the human's key

```bash
ACCOUNT=$(mantle-aa keys new --name human --json | jq -r .result.account)
echo "$ACCOUNT"
```

`$ACCOUNT` is both the human's EOA and, once upgraded, the smart account. It holds 0 MNT.

### 3. Start a sponsor

The sponsor pays only for allowlisted accounts. `${VAR}` in the file is read from the
environment when the sponsor starts; the keys never appear in it.

```bash
cat > "$MANTLE_AA_HOME/sponsor.yaml" <<EOF
chainId: 5003
rpcUrl: \${MANTLE_AA_RPC_URL}
listen: { host: 127.0.0.1, port: 8548 }
database: ./sponsor.sqlite
relayer: "$SPONSOR_RELAYER_ADDRESS"
relayerKey: \${SPONSOR_RELAYER_KEY}
paymasterSignerKey: \${SPONSOR_PAYMASTER_SIGNER_KEY}
policy:
  allowlist: ["$ACCOUNT"]
  accountDailyGas: 30000000
  maxFeePerRequestMnt: "0.1"
  dailyBudgetMnt: "1"
  managementReserveMnt: "0.4"
EOF
mantle-aa sponsor serve --config "$MANTLE_AA_HOME/sponsor.yaml" >"$MANTLE_AA_HOME/sponsor.log" 2>&1 &
SPONSOR_PID=$!
for i in $(seq 30); do curl -sf http://127.0.0.1:8548/health && break; sleep 1; done; echo
export MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548
```

The sponsor runs in the background and logs to `sponsor.log`; `$SPONSOR_PID` is its process
(use the installed `mantle-aa` here: under `npx` it would be npx's). `/health` answers `{"status":"ok","chainId":5003,"sponsor":"<relayer>"}`. Without a paymaster
signer key, delete the `paymasterSignerKey` line: the relayer path works, the bundler path does
not. Keep `maxFeePerRequestMnt` at 0.1 or more: the upgrade with the first grant costs up to
≈0.055 MNT, so the 0.05 of older examples refuses it. All fields: [`docs/usage.md`](docs/usage.md#running-a-sponsor).

### 4. Write the agent's policy

The policy of `docs/DESIGN.md` §8: approve MockUSD to the launchpad, buy and sell there, at most
100 mUSD in total and 50 mUSD per day. The fields are specified in [`docs/policy.md`](docs/policy.md).

```bash
cat > "$MANTLE_AA_HOME/policy.json" <<EOF
{
  "quoteLimits": [{ "token": "$USD", "totalCap": "100000000", "periodCap": "50000000" }],
  "periodLength": 86400,
  "permissions": [
    { "target": "$USD", "selector": "approve(address,uint256)", "ruleKind": "ERC20_APPROVE" },
    { "target": "$PAD", "selector": "buy(address,uint256,uint256,uint256,address)", "ruleKind": "LAUNCHPAD_BUY" },
    { "target": "$PAD", "selector": "sell(address,uint256,uint256,uint256,address)", "ruleKind": "LAUNCHPAD_SELL" }
  ],
  "trustedSpenders": ["$PAD"],
  "maxDeadlineWindow": 600
}
EOF
```

### 5. Upgrade the account and grant the first session

```bash
mantle-aa account init --grant "$MANTLE_AA_HOME/policy.json" --agent trader
```

One sponsored type-4 transaction delegates the EOA to CaliburEntry and registers the agent
`trader`: a new session key, saved as the profile `trader`, valid for 24 hours. The result shows
`"state": "INITIALIZED"` and the transaction hash.

### 6. Fund the account with principal

MockUSD can be minted by anyone; here the human mints 100 mUSD to the account with a sponsored
root call.

```bash
MINT=$(cast calldata 'mint(address,uint256)' "$ACCOUNT" 100000000)
mantle-aa account exec --calls "[{\"to\":\"$USD\",\"data\":\"$MINT\"}]"
```

### 7. The agent buys, then sells

Approve exactly 10 mUSD to the launchpad and buy with it, in one batch. The launchpad's deadline
must be within the policy's `maxDeadlineWindow` (600 s) of the chain's time.

```bash
APPROVE=$(cast calldata 'approve(address,uint256)' "$PAD" 10000000)
BUY=$(cast calldata 'buy(address,uint256,uint256,uint256,address)' "$MEME" 10000000 0 $(($(date +%s) + 300)) "$ACCOUNT")
mantle-aa agent exec --agent trader --calls "[{\"to\":\"$USD\",\"data\":\"$APPROVE\"},{\"to\":\"$PAD\",\"data\":\"$BUY\"}]"
```

The agent now holds 1e22 meme units of inventory, and 40 mUSD of the day's 50 remain. Sell half
of it; the proceeds (5 mUSD) go back to the account:

```bash
SELL=$(cast calldata 'sell(address,uint256,uint256,uint256,address)' "$MEME" 5000000000000000000000 0 $(($(date +%s) + 300)) "$ACCOUNT")
mantle-aa agent exec --agent trader --calls "[{\"to\":\"$PAD\",\"data\":\"$SELL\"}]"
```

`agent exec` simulates the batch against the policy first and sends nothing that fails.

### 8. An overreach is refused

`transfer` on MockUSD is not in the policy. The CLI refuses it locally with exit code 10, and
nothing is sent; the hook would revert it on chain too.

```bash
STEAL=$(cast calldata 'transfer(address,uint256)' "$SPONSOR_RELAYER_ADDRESS" 1000000)
mantle-aa agent exec --agent trader --calls "[{\"to\":\"$USD\",\"data\":\"$STEAL\"}]"
echo "exit code $?"
```

### 9. Inspect the account

```bash
mantle-aa account status
mantle-aa session list
```

`account status` shows the init state, every session key (registered, expiry, active or
revoked), its policy, the remaining limits and the meme inventory attributed to it.

### 10. Submit through a bundler

The same agent call can go as an ERC-4337 UserOperation, sponsored by the deployed
VerifyingPaymaster (the sponsor signs its paymaster data). `e2e/bundler/sepolia.sh` starts the
self-hosted bundler stack against Mantle Sepolia: Alto in safe mode on port 4337, tracing on a
local anvil fork (ports 18545 and 18546). The stack is not in the npm packages; it needs a clone
of this repository (no build), the executor's key and `npm`; the first start installs the pinned
Alto.

```bash
git clone https://github.com/Whisker17/mantle-7702-sdk.git "$MANTLE_AA_HOME/repo"
BUNDLER_SH="$MANTLE_AA_HOME/repo/e2e/bundler/sepolia.sh"
read -rs BUNDLER_PRIVATE_KEY && export BUNDLER_PRIVATE_KEY   # the funded executor wallet, 0x…
export BUNDLER_RUN_DIR="$MANTLE_AA_HOME/bundler"
"$BUNDLER_SH" up
SELL=$(cast calldata 'sell(address,uint256,uint256,uint256,address)' "$MEME" 1000000000000000000000 0 $(($(date +%s) + 300)) "$ACCOUNT")
mantle-aa agent exec --agent trader --calls "[{\"to\":\"$PAD\",\"data\":\"$SELL\"}]" --via bundler --bundler-url http://127.0.0.1:4337
"$BUNDLER_SH" down
```

The result carries the bundle's transaction hash. Every submitting command accepts
`--via bundler`, `account init` included. Details: [`docs/usage.md`](docs/usage.md#the-bundler-path).

### 11. Revoke the session

```bash
mantle-aa session revoke --agent trader
mantle-aa agent exec --agent trader --calls "[{\"to\":\"$PAD\",\"data\":\"$SELL\"}]"
echo "exit code $?"
mantle-aa session list
```

The revoke removes the key from Calibur, tombstones it in the hook and resets the MockUSD
allowance to the launchpad. The agent's next call exits with 13. The revoked key never comes back;
its remaining inventory stays attributed to it, frozen, until the human releases it
(`account exec --release`, [`docs/usage.md`](docs/usage.md#root-operations)).

### 12. Stop the sponsor

```bash
kill "$SPONSOR_PID"
```

### The rest of §8

The quick start covers §8 steps 1–3, 5, 6, one item of step 4, and the bundler path for one
call. Every other step-4 overreach (each refused by the CLI, by the sponsor and on chain), the
whole sequence on the bundler path, the MNT value case and `account panic` with the sponsor down
are run by `e2e/sepolia.ts`, which spends real testnet MNT. How to run it: `e2e/README.md`
(`sepolia.ts`); the last run, with every transaction: [`docs/acceptance.md`](docs/acceptance.md).

## Exit codes

Every command supports `--json`: stdout then carries one object, `{ "ok": true, "command",
"result" }` or `{ "ok": false, "command", "exitCode", "error": { "code", "type", "message", … } }`.

| Exit | `error.code` | Meaning | What to do |
| --- | --- | --- | --- |
| 0 | | Success | |
| 10 | `POLICY_VIOLATION` | A call the policy forbids: target or selector not permitted, spender not trusted, `recipient` not the account, deadline outside the window, a call to the hook | Change the call, or grant a policy that allows it |
| 11 | `LIMIT_EXCEEDED` | Over a quote-asset or MNT cap, or over `maxValuePerCall`; `error.remaining` says what is left | Spend less, wait for the next period, or have the human grant a new session |
| 12 | `INVENTORY_EXCEEDED` | A sell of more than this session bought; `error.held` is its inventory | Sell at most `held` |
| 13 | `KEY_EXPIRED_OR_REVOKED` | The session key expired, was revoked, or is not registered | Have the human grant a new session |
| 20 | `SPONSOR_REJECTED` | The sponsor refused; the message carries its reason (see [`docs/usage.md`](docs/usage.md#sponsor-rejections)) | Depends on the reason |
| 21 | `SPONSOR_BUSY` | The account already has a request in flight | Retry once it settles (on the bundler path, up to 60 s) |
| 30 | `EXECUTION_REVERTED` | Reverted in simulation (by the sponsor or the bundler) or on chain | Read `error.reason` |
| 1 | `USAGE`, `NOT_AVAILABLE`, `ERROR` | Bad arguments or settings, or anything else | Read the message |

Which SDK error maps to which code: [`packages/cli/README.md`](packages/cli/README.md#output-and-exit-codes).

## Development

From a clone; pnpm 11 as well as Node 24 or later.

```bash
git clone https://github.com/Whisker17/mantle-7702-sdk.git && cd mantle-7702-sdk
pnpm install --frozen-lockfile
pnpm check        # lint + typecheck + test
cd contracts && forge fmt --check && forge build --sizes && forge test -vvv
```

The fork suites run against Mantle Sepolia when `MANTLE_SEPOLIA_RPC_URL` is set (they skip
otherwise); the contract tests need `git submodule update --init --recursive`. Contributor and
agent guide: [`AGENTS.md`](AGENTS.md).
