# Using mantle-7702-sdk

What the [quick start](../README.md#quick-start-mantle-sepolia) does not cover: the root's other
operations, running a sponsor, the bundler path, the SDK from TypeScript, consuming the packages
from another project, what a launchpad must satisfy, and the known limits. Everything here is a
proof of concept on Mantle Sepolia; the contracts are not audited.

## Who does what

- **The human (root)** holds the EOA's key. After `account init` the EOA is a Calibur smart
  account at the same address. The root can do anything: grant, update and revoke sessions, run
  any call (`account exec`), and stop everything (`account panic`). Root batches are not checked
  by the hook.
- **An agent** holds one session key. Every call it makes goes through `AgentPolicyHook`, which
  enforces the key's [policy](policy.md) on chain. The agent is untrusted: the policy is the
  only thing standing between it and the account's funds.
- **The sponsor** pays the gas, for allowlisted accounts and within its budgets. It checks and
  simulates every request itself, but it is not a security boundary: an agent could also send
  its signed calls to the account directly, and the hook would apply the same rules.
- **The path** (`--via`): `relayer` (default) sends a signed batch to the sponsor, whose relayer
  wallet submits it; `bundler` sends an ERC-4337 UserOperation to a bundler, sponsored by the
  deployed VerifyingPaymaster with paymaster data the sponsor signs.

The CLI reference (settings, profiles, `--json`, panic) is
[`packages/cli/README.md`](../packages/cli/README.md); `mantle-aa --help` lists every command.

## Root operations

| Command | Does |
| --- | --- |
| `keys new --name <n>` / `keys import --name <n>` | Create a root key and profile; `import` reads the private key from stdin or a prompt, never from argv |
| `account init [--grant <policy.json> --agent <name>]` | Delegate the EOA to CaliburEntry and initialise it, optionally with the first session, in one sponsored type-4 transaction. Safe to rerun after a failure: it re-reads the state (`UNDELEGATED` → `DELEGATED` → `INITIALIZED`) and continues |
| `session grant --agent <name> --policy <file>` | A new session: always a new key. If `<name>` already exists, its previous key stays reachable as the profile `<name>.v1`, `<name>.v2`, … |
| `session update --agent <name> --policy <file>` | Tighten the current key's policy ([rules](policy.md#updating-a-policy)) |
| `session revoke --agent <name>` | Remove the key from Calibur, tombstone it in the hook (it can never be granted again) and reset the allowances its policy allowed |
| `account exec --calls <json> [--release <keyHash,token,amount>]…` | Any root batch. To dispose of meme that is attributed to a session (including a revoked one), name the release explicitly: `--release <keyHash>,<token>,<amount>` adds `releaseInventory` to the same batch. Meme no session holds needs no release |
| `account panic [--self-pay [--undelegate]]` | Revoke every session in one transaction ([details](../packages/cli/README.md#panic)). `--self-pay` needs no sponsor but MNT on the root; `--undelegate` needs `--self-pay` |
| `account status` / `session list` | Read-only: the state, nonces, every session with its policy, remaining limits and inventory, and the account's attributed and unallocated meme |

Up to 8 sessions can be active per account. Grant a session with a custom expiry through the SDK
(`grantSession(policy, { agentName, expiry })`); the CLI always grants 24 hours.

## Running a sponsor

`mantle-aa sponsor serve --config <sponsor.yaml>` runs the sponsor as an HTTP JSON-RPC service:
`sponsor_relay` for the relayer path, `pm_getPaymasterStubData` / `pm_getPaymasterData` (ERC-7677)
for the bundler path, and `GET /health`. It runs until SIGINT or SIGTERM. Clients find it through
`--sponsor-url` or `MANTLE_AA_SPONSOR_URL`.

### `sponsor.yaml`

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `chainId` | yes | | Must equal the address book's (5003) |
| `rpcUrl` | yes | | A literal URL, or `${VAR}` to read it from the environment (an RPC URL may hold an API key; it is never logged) |
| `listen` | no | `{ host: 127.0.0.1, port: 8548 }` | Where to listen; port 0 picks a free one |
| `database` | yes | | The SQLite ledger; a relative path resolves against the config file |
| `relayer` | yes | | The relayer wallet's address, quoted; it also names this sponsor in every request |
| `relayerKey` | no | | `${VAR}`: the variable holding the relayer's key. Without it the sponsor decides but cannot submit |
| `paymasterSignerKey` | no | | `${VAR}`: the key of the VerifyingPaymaster's `verifyingSigner`, checked at start. Without it the `pm_*` methods refuse |
| `settleTimeoutSeconds` | no | 30 | How long `sponsor_relay` waits for the transaction before answering `pending` (the client then polls) |
| `deployments` | no | the committed book | Path to another address book |
| `maxRequestValiditySeconds` | no | 300 | The longest request validity window accepted |
| `policy.allowlist` | yes | | The accounts paid for (quoted addresses) |
| `policy.accountDailyGas` | yes | | Gas per account per UTC day, per budget class |
| `policy.maxFeePerRequestMnt` | yes | | The worst-case fee one request may reserve, in MNT (a quoted decimal) |
| `policy.dailyBudgetMnt` | yes | | Everything paid per UTC day |
| `policy.managementReserveMnt` | yes | | The part of the daily budget only management requests (init, grant, update, revoke, panic, allowance resets) may use, so agents cannot exhaust it |

Keys are only ever `${VAR}` references: a literal key in the file is refused. Addresses must be
quoted, or YAML reads them as numbers. Unknown fields are refused.

**Size the per-request cap for init.** The upgrade with the first grant has a worst-case fee of
about 0.055 MNT on Mantle Sepolia (it cost 0.042–0.044 MNT in the acceptance run), so a
`maxFeePerRequestMnt` of 0.05, as the example in `packages/sponsor/src/config.ts` has, refuses it
with `REQUEST_FEE_CAP`. Use 0.1. The acceptance run's sponsor (`docs/acceptance.md`, Setup) used
`accountDailyGas: 30000000`, `maxFeePerRequestMnt: "0.1"`, `dailyBudgetMnt: "1"`,
`managementReserveMnt: "0.4"`; one account's whole §8 sequence used about 0.14 MNT of relayer fees.

The sponsor handles one request per account at a time (`SPONSOR_BUSY` otherwise), reserves the
worst-case fee before it submits, and settles at the fee the receipt shows, reverted transactions
included.

One sponsor submits from a database at a time: a second `sponsor serve` on the same `database`
refuses to start. `sponsor relayer status|bump|cancel` still work beside the running sponsor.

### Embedded mode

For tests and local demos the CLI can run the same sponsor in its own process instead:
`MANTLE_AA_EMBEDDED_RELAYER=1` and the relayer key in `MANTLE_AA_RELAYER_KEY` (plus
`MANTLE_AA_PAYMASTER_SIGNER_KEY` for `--via bundler`), and no sponsor URL. Each submitting command
starts it, allowlisting the profile's account, with its ledger in
`$MANTLE_AA_HOME/embedded-sponsor.sqlite`, and stops it before exiting. Its caps are fixed
(`packages/sponsor/src/embedded.ts`: 0.5 MNT per request, 5 MNT per day, 10 M gas per account).
One embedded sponsor runs per `MANTLE_AA_HOME` at a time: a submitting command started while
another command's embedded sponsor runs exits 1 before sending anything. Run them one after
another, or give each its own home.

### A stuck relayer transaction

The sponsor does not replace stuck transactions itself. From a second shell, with the same config:

```bash
mantle-aa sponsor relayer status --config sponsor.yaml          # nonces and open requests
mantle-aa sponsor relayer bump   --config sponsor.yaml [--nonce <n>] [--max-fee-per-gas <wei>] [--max-priority-fee-per-gas <wei>]
mantle-aa sponsor relayer cancel --config sponsor.yaml [--nonce <n>]
```

`bump` and `cancel` need the relayer key in the environment. A cancel can lose to the original
transaction; the ledger settles whichever was mined.

### Sponsor rejections

A refused request exits with 20 (`SPONSOR_REJECTED`), or 13 for the three key reasons, and the
message names the reason.

| Reason | Meaning |
| --- | --- |
| `NOT_ALLOWLISTED` | The account is not in `policy.allowlist` |
| `REQUEST_FEE_CAP` | The worst-case fee is over `maxFeePerRequestMnt` (see init above) |
| `ACCOUNT_GAS_CAP`, `DAILY_BUDGET`, `MANAGEMENT_BUDGET` | A daily cap is used up; wait for the next UTC day or raise it |
| `FEE_UNBOUNDED` | The fee could not be bounded (the gas price oracle could not be read) |
| `SIMULATION_FAILED` | The sponsor's own simulation reverted: the policy or the target refuses the call |
| `KEY_NOT_REGISTERED`, `KEY_EXPIRED`, `KEY_INACTIVE` | The session key is unknown, expired, or revoked (exit 13) |
| `ACCOUNT_NOT_DELEGATED`, `ACCOUNT_NOT_INITIALIZED` | Run `account init` first |
| `SUBMISSION_UNAVAILABLE` | Accepted but not submitted: no relayer key (no paymaster signer key, for `pm_*`), or the node refused the transaction. Sign and send again |
| `SPONSOR_BUSY` | Another request of the account is in flight (exit 21) |
| `CANCELLED` | The operator cancelled the relayer transaction; the batch did not run |
| `REQUEST_EXPIRED`, `BAD_REQUEST_SIGNATURE`, `BAD_BATCH_SIGNATURE`, `WRONG_CHAIN`, `WRONG_DOMAIN`, `WRONG_EXECUTOR`, `WRONG_LANE`, `ROOT_LANE_MISUSE`, `AUTHORIZATION_INVALID`, `INIT_CODE_INVALID`, `INVALID_PARAMS` | A malformed or mismatched request. The CLI does not produce these; another client might. Check the clock for `REQUEST_EXPIRED` |

## The bundler path

`--via bundler --bundler-url <url>` (or `MANTLE_AA_BUNDLER_URL`) sends every submitting command
as an ERC-4337 v0.8 UserOperation. The sponsor must have `paymasterSignerKey`; the deployed
VerifyingPaymaster pays from its EntryPoint deposit. `account init` carries the EIP-7702
authorization in the UserOp (`eip7702Auth`); session UserOps never do.

There is no public bundler for EntryPoint v0.8 on Mantle Sepolia, so the repository runs its own:
`e2e/bundler/sepolia.sh up|down|status` starts Alto 0.0.21 in safe mode (full ERC-7562 validation)
with a patch, against the real chain, and traces validation on a local anvil fork because the
public RPC refuses `debug_*`. It needs `anvil`, `npm` (Alto is installed from
`e2e/bundler/alto/package-lock.json` into `$BUNDLER_RUN_DIR` on first start) and these variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUNDLER_PRIVATE_KEY` | required | Alto's executor; it pays for each bundle and is refunded by the EntryPoint, about 20 % short on Mantle (`docs/infra.md` §10.4) |
| `UPSTREAM_RPC_URL` | `https://rpc.sepolia.mantle.xyz` | The chain |
| `BUNDLER_RUN_DIR` | `~/.mantle-aa/bundler-run` | Logs (`alto.log`), PID files and the Alto install. Use one per stack: `down` stops the processes whose PIDs are there |
| `ALTO_PORT` | 4337 | Alto's port; anvil and the trace proxy use 18545 and 18546 |

Why the stack looks like this, and what was measured: `docs/infra.md` §10.

## The SDK from TypeScript

The CLI is a thin layer over `@mantle-aa/sdk`: `MantleAccount` for the root, `AgentSession` for
an agent, and an `Executor` for the path (`RelayerExecutor` or `BundlerExecutor`). Errors are
the classes the exit codes map to (`PolicyViolationError`, `LimitExceededError`,
`InventoryExceededError`, `KeyExpiredError`, `DeadlineOutOfRangeError`, `SponsorRejectedError`,
`SponsorBusyError`, `ExecutionRevertedError`), each with structured fields.

```ts
import {
  AgentSession,
  getChain,
  LimitExceededError,
  loadDeployments,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  PrivateKeySigner,
  RelayerExecutor,
  RuleKind,
} from "@mantle-aa/sdk";
import { createPublicClient, encodeFunctionData, erc20Abi, type Hex, http, parseAbi } from "viem";

const addresses = loadDeployments(); // the committed Mantle Sepolia address book
const client = createPublicClient({
  chain: getChain(addresses.chainId),
  transport: http(process.env.MANTLE_AA_RPC_URL),
});
const executor = new RelayerExecutor({ client, url: process.env.MANTLE_AA_SPONSOR_URL as string });
// Where session keys are saved; the password comes from MANTLE_AA_KEYSTORE_PASSWORD.
const keystore = { home: process.env.MANTLE_AA_HOME as string };

// The human: any Signer (here a raw key; loadProfileSigner reads one from the keystore).
const root = new PrivateKeySigner(process.env.ROOT_KEY as Hex);
const account = new MantleAccount({ client, root, executor, keystore });

const policy: Policy = {
  maxValuePerCall: 0n,
  mntLimit: { token: "0x0000000000000000000000000000000000000000", totalCap: 0n, periodCap: 0n },
  quoteLimits: [{ token: addresses.mockUsd, totalCap: 100_000_000n, periodCap: 50_000_000n }],
  periodLength: 86_400,
  permissions: [
    { target: addresses.mockUsd, selector: "0x095ea7b3", ruleKind: RuleKind.ERC20_APPROVE },
    { target: addresses.mockLaunchpad, selector: "0x9f01c7de", ruleKind: RuleKind.LAUNCHPAD_BUY },
  ],
  trustedSpenders: [addresses.mockLaunchpad],
  maxDeadlineWindow: 600,
};
const { session } = await account.init({ grant: { policy, agentName: "trader" } });

// The agent: its session key, saved in the keystore by the grant.
const agent = new AgentSession({
  client,
  account: account.address,
  keyHash: session!.keyHash,
  signer: loadProfileSigner("trader", keystore),
  executor,
});
const launchpad = parseAbi(["function buy(address,uint256,uint256,uint256,address)"]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
try {
  const { hash } = await agent.exec([
    {
      to: addresses.mockUsd,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [addresses.mockLaunchpad, 10_000_000n] }),
    },
    {
      to: addresses.mockLaunchpad,
      value: 0n,
      data: encodeFunctionData({ abi: launchpad, functionName: "buy", args: [addresses.memeToken, 10_000_000n, 0n, deadline, account.address] }),
    },
  ]);
  console.log(hash);
} catch (error) {
  if (error instanceof LimitExceededError) console.log(`only ${error.remaining} left`);
  else throw error;
}
console.log(await account.status());
```

`agent.simulate(calls)` runs the same checks without submitting. For the bundler path, use
`new BundlerExecutor({ client, bundlerUrl, sponsorUrl })`. `@mantle-aa/sponsor` exports the
sponsor itself (`loadConfig`, `startSponsor`, `startEmbeddedSponsor`) for running it in process.
The signatures are in `packages/sdk/src/` (`docs/DESIGN.md` §5.1 is the design).

## Consuming the packages

`@mantle-aa/sdk`, `@mantle-aa/sponsor` and `@mantle-aa/cli` are private and not published. Use
them from a clone of this repository, built, through pnpm `link:` dependencies:

```bash
git clone git@github.com:Whisker17/mantle-7702-sdk.git ../mantle-7702-sdk   # or check out a tag
(cd ../mantle-7702-sdk && pnpm install --frozen-lockfile && pnpm build)
pnpm add link:../mantle-7702-sdk/packages/sdk link:../mantle-7702-sdk/node_modules/viem
pnpm add link:../mantle-7702-sdk/packages/sponsor           # only to run a sponsor in process
```

Link `viem` from the clone as well, rather than installing your own copy: the SDK takes viem
clients, and with two copies of viem TypeScript rejects your client as a different type (the
code runs either way). Rebuild the clone (`pnpm build`) after pulling. A linked package finds the
default address book in the clone's `deployments/`.

Two forms do not work with this repository, so do not use them:

- **A git dependency** (`pnpm add "git+ssh://git@github.com/Whisker17/mantle-7702-sdk.git#<ref>&path:/packages/sdk"`)
  installs the package's sources without `dist/` (nothing builds it), so importing it fails with
  `ERR_MODULE_NOT_FOUND`.
- **A `file:` dependency** copies the package out of the clone: the SDK then cannot find
  `deployments/mantle-sepolia.json` (pass `loadDeployments(<path>)` everywhere to work around
  it), and `@mantle-aa/sponsor` does not install at all, because its `workspace:*` dependency on
  the SDK resolves only inside this workspace.

## For launchpad builders

The hook bounds what a session can spend, but only for contracts that behave as it assumes. It
cannot verify that; the human's policy declares it, by listing a launchpad as a permission target
and a trusted spender. A launchpad, its MemeTokens and every trusted spender must therefore meet
`docs/DESIGN.md` §4.4, which is binding for the real launchpad. In short:

1. **No upgrades, no indirection.** Not upgradeable; no `delegatecall`, arbitrary external calls,
   configurable modules or admin paths that pull funds.
2. **Pull only from the caller, only in its call.** Quote is taken with
   `transferFrom(msg.sender, …)` inside the account's own call; meme with a privileged MemeToken
   transfer whose `from` is `msg.sender`. Never from an arbitrary `from`.
3. **A closed token set.** MemeTokens come from the launchpad's factory with a fixed
   implementation; only the launchpad can call their privileged transfer; `sell` accepts only
   tokens the launchpad registered. Selling therefore needs no `approve`, and no meme address
   appears in a policy.
4. **Proceeds go to `recipient`.** The hook forces `recipient` to be the account.
5. **Plain balances.** No transfer fees, rebasing or transfer callbacks on MemeTokens or quote
   assets; the quote asset is an immutable `quoteToken()`.
6. **Exact deltas.** `buy` delivers to the recipient only the tokens of this purchase, with no
   other inflow in the same call (the hook attributes the balance increase to the session);
   `sell` takes exactly `amount` or reverts (no partial fills).
7. **Tested against theft.** A third party calling `sell` cannot reduce a victim's balance;
   calling the MemeToken's privileged entry directly is refused; nothing public or admin can pull
   a victim's assets.

The hook's rules recognise the launchpad by these exact signatures, so they are the ABI:

```solidity
function quoteToken() external view returns (address);                    // immutable
function buy(address token, uint256 amountIn, uint256 minOut, uint256 deadline, address recipient) external returns (uint256);   // 0x9f01c7de
function sell(address token, uint256 amount, uint256 minOut, uint256 deadline, address recipient) external returns (uint256);    // 0x1d87be21
```

On each session call the hook checks `recipient == account`,
`now ≤ deadline ≤ now + maxDeadlineWindow` and that `token` is not a quote asset; for `sell` also
the session's inventory. At grant time it requires the launchpad's `quoteToken()` to be one of
the policy's quote assets. `minOut` is not checked: the hook does not protect execution prices.
`contracts/src/mocks/MockLaunchpad.sol` and `MemeToken.sol` are a reference implementation, with
the tests of §4.4 item 7 in `contracts/test/`.

What the promise is, and what it is not (`docs/DESIGN.md` §4.0): a compromised session key loses
at most its quote-asset and MNT limits, measured at cost; it can sell only what it bought; it
cannot change a policy, sign for the account (ERC-1271) or come back after a revoke. It can still
sell its own positions at any price.

## Known limits

The open items are in `docs/DEFERRED_ISSUES.md`. The ones a user meets:

- **Testnet only, unaudited.** The address book has Mantle Sepolia only.
- **Fee cap for init**: see [Running a sponsor](#sponsoryaml).
- **One request per account at a time.** On the bundler path an op the bundler never includes
  blocks the account's next request until its 60 s sponsorship window passes (`SPONSOR_BUSY`), and
  `agent exec` may wait up to its 120 s bound before reporting `not included`.
- **The self-hosted Alto can stall** on an op that fails re-validation, until it refuses every op
  of the unstaked paymaster (`-32505 … is unstaked`); restart the stack (`sepolia.sh down`, `up`).
- **Settlement takes the first receipt**, with no confirmation depth; a reorg is not followed.
- **A sponsorship issued for one session key can be used by another key of the same account**
  (the key's own policy still applies on chain).
- **The public RPC is load-balanced** and can answer from a node a block behind: after a
  transaction, wait about two blocks before reading state that depends on it.
- **Nonce lanes are not bound to keys on chain**: one session key can consume another key's
  nonces (a denial of service of what that key signed, not a bypass). The sponsor and the CLI
  refuse it.

## Running the full acceptance

`e2e/sepolia.ts` runs all of `docs/DESIGN.md` §8 on Mantle Sepolia through both paths: every
step-4 overreach refused three times (by the CLI, by the sponsor, and on chain as a direct
submission), the MNT value case and `account panic` with the sponsor stopped. It needs a funded
relayer, a funded third-party wallet, the paymaster signer key and a bundler executor, takes about
an hour and spends real testnet MNT. How to run it: `e2e/README.md` (`sepolia.ts`). The last run's
transactions and spend: [`docs/acceptance.md`](acceptance.md). The same sequences run on an anvil
fork in CI: `MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz pnpm exec vitest run e2e`.
