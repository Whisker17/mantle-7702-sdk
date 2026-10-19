# mantle-7702-sdk — Design (spec of record)

> **Status:** v1.0, final (2026-10-18), after six rounds of independent design review
> (Appendix B). Final design review does not mean the implementation has passed security
> acceptance.
> **Nature:** proof of concept. **The contracts are not externally audited.**

## 1. Goals and scope

### 1.1 Goal

Give AI agents an EIP-7702 smart-account layer on Mantle, delivered as an **SDK + CLI**
that several higher-level projects can reuse (first consumer: an agentic meme launchpad).

Core capabilities:

1. **7702 account** — a human EOA is upgraded in place to a smart account (same address).
2. **Session keys** — the human grants agents restricted session keys.
3. **Call allowlist and spend limits** — enforced on-chain.
4. **Gasless** — every step (upgrade, grant, execution, revocation) is paid by a sponsor;
   the human and the agents can hold 0 MNT.

### 1.2 Non-goals (this iteration)

- Paying gas in ERC20
- Mainnet (5000) delivery (configuration only stays switchable)
- MCP server / OpenClaw skill (launchpad phase)
- KMS / TEE signers (only the `Signer` interface is reserved)
- Fund-isolated multi-account setups
- External audit
- Arbitrary third-party DEXes / routers / meme tokens (only our own launchpad meeting §4.4)
- On-chain protection of execution price
- Precise gas / L1-fee estimation (spike measurements and conservative upper bounds only)
- Automatic replacement of stuck relayer transactions (manual bump / cancel only)

### 1.3 Established facts (research, 2026-10)

| Fact | Source |
|---|---|
| Mantle mainnet and Sepolia support EIP-7702 SetCode transactions since the Skadi upgrade | Mantle docs changelog (v1.3.0 / v1.3.1 Skadi) |
| Mantle stated that 7702-based gas sponsorship replaces the deprecated MetaTX; whether an official service exists is unknown | Mantle docs, Everest upgrade notice |
| EntryPoint v0.7 / v0.8 / v0.9 are deployed on Mantle mainnet and Sepolia | `eth_getCode` |
| The Pimlico bundler supports Mantle (5000) and Mantle Sepolia (5003) with 7702 marked supported; its docs do not list v0.8 for Mantle Sepolia; mainnet bundler traffic is low | Pimlico docs, Mantlescan |
| Uniswap Calibur v1.0.0 is deployed on Mantle mainnet at `0x000000009b1d0af20d8c6d0a44e162d11f9b8f00`, not on Sepolia; the CREATE2 deterministic deployer exists on both | `eth_getCode` |
| Rhinestone Smart Sessions, OKX SmartWallet and Coinbase EIP7702Proxy are not deployed on Mantle | `eth_getCode` |
| Industry practice: a 7702 account plus ERC-4337 (EntryPoint ≥ v0.8) for transport and sponsorship; OKX runs 4337 and a relayer side by side; Porto runs its own relay | Vendor docs, Appendix A |
| Native-AA direction: Base EIP-8130 (devnet only; not in the Cobalt activation list), L1 EIP-8141 (scheduled for Hegotá), Tempo 0x76, zkSync | Appendix A |

## 2. Decision log

| # | Decision | Outcome | Rationale |
|---|---|---|---|
| Q1 | Key model | The human holds the root key (the EOA, **fully trusted**); agents hold only restricted session keys | Bounded loss on leakage |
| Q3 | Chain scope | Mantle-first on viem; chain-agnostic configuration | Mantle adaptation is the differentiator |
| Q4 | Stack / delivery | Foundry + TypeScript (viem) + pnpm monorepo; SDK + CLI this iteration; machine-readable CLI first | viem supports 7702 / AA natively |
| Q5 | Network | Mantle Sepolia; CI on anvil fork; mainnet out of scope | EntryPoint already on chain |
| Q6/Q9 | Acceptance scope | Fully gasless flow + batch + buy/sell; no ERC20 gas payment | See §8 |
| Q7 | Repository | Standalone repository; packages `private: true`, not published; the launchpad consumes them by git dependency or local link | — |
| Q8 | Transport | Two paths: Calibur signed `execute` (relayer) + 4337 EntryPoint v0.8 (bundler); SDK `Executor` abstraction; both implemented this iteration | Relayer: low latency, independent of thin 4337 infrastructure; 4337: ecosystem compatibility |
| Q10 | Sponsorship | Own sponsor service; rules in §5.2 | Shared by both paths |
| Q11 | Policy scope | Target + selector allowlist, per-call value cap, quote-asset total / period caps, fixed-ABI parameter rules, expiry; concepts aligned with the 8130 actor/policy model | — |
| Q12 | Session-key storage | Encrypted CLI keystore (`~/.mantle-aa/`), environment override; `Signer` interface | — |
| Q13 | Account contract | **Calibur v1.1.0 (`CaliburEntry`) + our own `AgentPolicyHook`** | Version assessment in §4.1.1 |
| Q14 | 4337 infrastructure | Pimlico bundler (configurable URL) + our own v0.8 `VerifyingPaymaster`; Alto locally and in CI | One source of sponsorship policy |
| Q15 | Sponsor shape | One long-running service (relayer + paymaster signer); **embedded mode kept this iteration** (explicit environment switch; tests and local demos only) | Owner decision |
| Q16 | Default path | Relayer by default; `--via relayer\|bundler` per call; no automatic fallback | — |
| Q17 | Multiple agents | One account, several session keys, each with its own policy, limits and inventory | — |
| Q18 | Limit semantics | Total cap + fixed-window period cap; native units; no price oracle; details in §4.2.4 | — |
| Q19 | Hook shape | Singleton, non-upgradeable; **revocation is a tombstone — the same key can never be granted again**; upgrade = deploy a new version | — |
| Q20 | Emergency stop | `account panic` revokes every session and clears allowances; `--self-pay` fallback; `--undelegate` in two phases | — |
| Q22 | Testing and security | See §9 | — |
| Q24 | Schedule | One week, 2026-10-18 → 10-24, four releases, day-1 infrastructure spike, last day as buffer | — |
| **D1** | Meme disposal scope | **A session may sell only what it bought through the launchpad** (the hook keeps per-key inventory) | Bounds loss on a **cost basis** (excluding appreciation); positions attributed to the human or to other agents cannot be disposed of by that session (conditions in §4.2.6) |

Review record: Appendix B.

## 3. Architecture

```
                    ┌───────────────────────────── off-chain ─────────────────────────────┐
  Human (root key)  │  CLI ──► SDK ──► Executor ──┬─► RelayerExecutor ──► Sponsor Service │
  Agent (session)   │                              │                      (relayer + PM   │
  OpenClaw / TG     │                              └─► BundlerExecutor ──► Pimlico / Alto  │
                    │                                                     ▲  (PM signature │
                    │                                                     │   from Sponsor)│
                    └─────────────────────────────────────────────────────┼────────────────┘
                    ┌───────────────────────────── on-chain (Mantle) ─────┼────────────────┐
                    │  Human EOA ──7702──► CaliburEntry v1.1.0             │                │
                    │                        ├─ execute(SignedBatchedCall) ◄── relayer tx   │
                    │                        ├─ validateUserOp/executeUserOp ◄─ EntryPoint v0.8
                    │                        ├─ execute(BatchedCall) / ERC-7821 ◄─ key calls│
                    │                        └─ per-key hook ──► AgentPolicyHook (0x…1f)     │
                    │  VerifyingPaymaster (EP v0.8, signer = sponsor)                       │
                    │  MockLaunchpad + MemeToken factory + MockUSD (acceptance fixture)     │
                    └───────────────────────────────────────────────────────────────────────┘
```

### 3.1 Repository layout

```
mantle-7702-sdk/
├─ contracts/                 # Foundry
│  ├─ src/AgentPolicyHook.sol
│  ├─ src/VerifyingPaymaster.sol      # ported from eth-infinitism v0.7.0 samples to the v0.8 BasePaymaster
│  ├─ src/mocks/                      # MockUSD, MockLaunchpad, MemeToken
│  ├─ script/                         # CaliburEntry, Hook (address mining), Paymaster, mocks
│  └─ test/                           # unit / fuzz / invariant / entry-point matrix
├─ packages/
│  ├─ sdk/                    # @mantle-aa/sdk (private)
│  ├─ cli/                    # @mantle-aa/cli (private)
│  └─ sponsor/                # sponsor service
├─ e2e/                       # anvil fork + Alto; Sepolia script
├─ deployments/               # mantle-sepolia.json
└─ docs/
```

## 4. On-chain design

### 4.0 Trust model

| Party | Trust assumption |
|---|---|
| Root (human EOA) | Fully trusted; may do anything (including switching hook or implementation) |
| Session key (agent) | **Untrusted**; every restriction must hold on-chain at execution time |
| Sponsor service | Trusted for funds and availability, **not** a security boundary (an agent can call the account directly) |
| Trusted spender / launchpad / MemeToken implementations | Manually verified to satisfy the §4.4 interface contract; the hook cannot verify these properties |
| Quote assets (MockUSD, …) | Standard, non-rebasing ERC20 without transfer fees; the quote-asset list in a policy is the root's trust declaration |

**Core security promise** (POC scope). A compromised session key:

- causes a cumulative net outflow of quote assets (ERC20 quote assets + MNT value) no larger
  than that key's limits — a loss bound **on a cost basis**;
- can sell only the quantity **attributed to itself** (§4.2.6), never the human's,
  airdropped or other sessions' positions;
- cannot change any policy, cannot produce an ERC-1271 signature, and never comes back
  after revocation.

**Not guaranteed:** the current value of, or gains on, the session's own positions (a
compromised session can sell all of its attributed positions at a very low `minOut`, so a
mark-to-market loss can far exceed its quote limit); the fairness of execution prices.

### 4.1 Account: Calibur v1.1.0

- The deployed artifact is **`CaliburEntry`** (the entry contract with a custom storage
  layout) from tag `v1.1.0` (commit `249cac5`).
- The version is identified by **runtime code hash**: the v1.1.0 source still reports
  `"1.0.0"` as the `eip712Domain` version (`src/EIP712.sol:106–107`), and the domain also
  carries a `salt` derived from the implementation (`EIP712.sol:62–66`). The SDK builds the
  signing domain from the on-chain `eip712Domain()` when the account is delegated, and
  computes it offline from the implementation address otherwise (tested).
- Root key = the EOA itself (`keyHash = 0`): admin, not subject to hooks. Session keys are
  secp256k1 with `Settings = {isAdmin = false, expiration, hook = AgentPolicyHook}`;
  **Calibur Settings are the only source of expiry**.
- **Entry-point matrix** (core restrictions must hold at execution time on every entry):

| Entry | Callable by | Validation hook | Execution hooks |
|---|---|---|---|
| `execute(SignedBatchedCall, sig)` | Anyone (only `executor` when set) | `afterVerifySignature` | ✅ |
| `validateUserOp` → `executeUserOp` | EntryPoint | `afterValidateUserOp` | ✅ |
| `execute(BatchedCall)` / ERC-7821 `execute(mode, data)` | The key's own address (`msg.sender.toKeyHash()`) | ❌ | ✅ |
| `isValidSignature` | Anyone | `afterIsValidSignature` | — |

- Calibur's built-in protections: non-admin keys cannot self-call or call the EntryPoint;
  a hook revert reverts the whole transaction (regardless of `revertOnFailure`); `update()`
  rejects a hook without flags or without code.
- **Hook flags.** Calibur selects callbacks from the low five bits of the hook address
  (`AFTER_VERIFY_SIGNATURE = 1<<0`, `AFTER_VALIDATE_USER_OP = 1<<1`,
  `AFTER_IS_VALID_SIGNATURE = 1<<2`, `BEFORE_EXECUTE = 1<<3`, `AFTER_EXECUTE = 1<<4`).
  `AgentPolicyHook` is deployed with a mined CREATE2 salt so that its low five bits
  **must equal `0x1f`**.
- **Two nonce systems.** The relayer path uses Calibur `getSeq(key)` (192-bit key + 64-bit
  sequence); the bundler path uses `EntryPoint.getNonce(sender, key)`. Calibur's nonce is
  not bound to the keyHash, so **per-agent lanes are an SDK / sponsor convention, not
  on-chain isolation** (a malicious session bypassing the sponsor can consume another
  lane's sequence — a DoS only, a known Calibur limitation). Lanes are derived
  deterministically: `lane = uint192(uint256(keyHash) >> 64)`; the root management lane is
  0; both nonce systems use the same derivation. **The sponsor checks at decode time that
  `(sender, authenticated keyHash, nonce lane)` agree and accepts no session request on
  the root lane**; otherwise it rejects with a structured error. Re-submitting the same
  intent through the other path is not idempotent on chain.
- **Bundler path and `eip7702Auth`.** Only the root's init UserOp may carry `eip7702Auth`;
  session UserOps never do and target already-delegated accounts (§7.1).
- **Deployment.** Through the CREATE2 deterministic deployer; reproducing the canonical
  address `0x000000005c84F8Fd50b21CAC312528A64437030e` (checked against the runtime code at
  that address on Ethereum Sepolia) is **time-boxed to one hour**; on failure our own
  address is used, which is a normal outcome. **Measured (0.1.0):** CaliburEntry v1.1.0 was
  reproduced at the canonical address on Mantle Sepolia with Calibur's own compiler settings
  (cancun, `bytecode_hash = none`, via-IR; `contracts/foundry.toml` profile `calibur`); its
  init code is byte-identical to the canonical Ethereum Sepolia deployment and its runtime
  code hash matches. The commit `d7dbc80` named in the Calibur README is on upstream branch
  `audit-main`, with `src/` identical to v1.1.0. Evidence: `deployments/mantle-sepolia.json`
  (`CaliburEntry`), checked by `contracts/script/DeployCalibur.s.sol` `verify()`.

#### 4.1.1 Calibur version assessment: v1.1.0

| | v1.0.0 (2025-05) | v1.1.0 (2026-07) |
|---|---|---|
| Mantle deployment | Mainnet `0x…9b1d…f00`; none on Sepolia | None on either |
| Public audits | Cantina + OpenZeppelin | Fixes a further round of `SB(...)` audit findings on top of v1.0.0; that report is not in the repository |
| Hook without flags / without code | Silently skipped | Rejected by `update()` |
| Non-admin key calls the EntryPoint | Not blocked | Blocked |
| EntryPoint / SenderCreator registered as a key | Possible | Rejected |
| `validateUserOp` with an unregistered key | Reverts | Returns `SIG_VALIDATION_FAILED` |
| ERC20ETH default unlimited native allowance | No | Yes (ERC20ETH is not deployed on either Mantle network) |

Choose v1.1.0: both versions need our own deployment this iteration, and the v1.1.0 fixes
sit exactly on the session-key attack surface. Costs: the incremental audit report is not
public → the contract review checkpoint and the final security review cover the
v1.0.0 → v1.1.0 diff; the ERC20ETH default allowance → `approveNative(ERC20ETH, 0)` at
init (I8).

### 4.2 AgentPolicyHook

#### 4.2.1 Storage layout (ERC-7562)

ERC-7562 defines associated storage as slot == A or `keccak(A || x) + n` (n ∈ 0..128).
Therefore:

- **Validation reads one fixed-size summary only**, and the account must be the innermost
  key of that mapping:

```solidity
struct Summary { bool initialized; bool active; bool revoked; }
mapping(bytes32 keyHash => mapping(address account => Summary)) internal summaries;
```

- Execution-time data (permissions, limits, inventory, spender lists, …) is not subject to
  this rule and may use any layout. Counters are not kept in arrays: **counters are keyed
  by token** (`mapping(token => Spent)`), so removing and re-adding a token keeps its
  history.
- The re-entrancy lock uses transient storage and is used only at execution time.

#### 4.2.2 Policy structure (sketch)

```solidity
struct Policy {
    uint256 maxValuePerCall;          // per-call MNT value cap
    QuoteLimit   mntLimit;            // MNT: metered by outgoing value only
    QuoteLimit[] quoteLimits;         // ERC20 quote assets: metered by net balance decrease; totalCap, periodCap
    uint32  periodLength;             // fixed-window length (0 = total cap only)
    uint40  anchor;                   // written on the first setPolicy, immutable afterwards
    CallPermission[] permissions;     // fixed-ABI (target, selector, ruleKind)
    address[] trustedSpenders;        // spenders approve may name (must meet §4.4)
    uint32  maxDeadlineWindow;        // upper bound N (seconds) on launchpad deadlines
}
```

`ruleKind` supports only this iteration's fixed ABIs: `ERC20_APPROVE`, `LAUNCHPAD_BUY`,
`LAUNCHPAD_SELL`, `NONE` (call without parameter rules). Multicall and generic router
command formats are not supported.

#### 4.2.3 Callbacks

**`beforeExecute(keyHash, to, value, data)`** (`msg.sender` = account):

1. Take the account-level re-entrancy lock (revert if held).
2. `summary.active` must be true (checked at execution time for every entry).
3. Reject `to == address(this)` (the hook itself).
4. `(to, selector)` must match `permissions`.
5. `value ≤ maxValuePerCall`; MNT is metered **only** here, by outgoing `value`, against
   the MNT limit (a failed target reverts everything; native refunds do not restore limit —
   conservative).
6. Check parameters by `ruleKind`:
   - `ERC20_APPROVE(spender, amount)`: `to` is a quote asset; `spender ∈ trustedSpenders`;
     `amount ≤` the asset's remaining limit (minimum of total and period). Incremental
     approvals such as `increaseAllowance` are always rejected.
   - `LAUNCHPAD_BUY(token, amountIn, minOut, deadline, recipient)`: `recipient == account`;
     `now ≤ deadline ≤ now + maxDeadlineWindow`; `token ∉` quote-asset set.
   - `LAUNCHPAD_SELL(token, amount, minOut, deadline, recipient)`: as above, plus
     **`amount ≤ inventory[keyHash][account][token]`** and
     `balanceOf(account, token) ≥ reserved[account][token]` (fail closed on an attribution
     gap, §4.2.6).
7. Snapshot ERC20 quote-asset balances (**not MNT**); for BUY / SELL also snapshot `token`.
   Return them as `beforeExecuteData`.

**`afterExecute(keyHash, success, output, beforeExecuteData)`**:

1. `success == false` → revert (equivalent to forcing `revertOnFailure = true`; the SDK
   always passes true as well).
2. ERC20 quote assets: per asset add `max(before − after, 0)` to the total and the current
   window; revert when over a cap. Inflows **never** restore past usage.
3. BUY: `delta = max(after − before, 0)`; `inventory[token] += delta; reserved[token] += delta`.
4. SELL: **partial fills are not supported** — the actual balance decrease must **equal**
   `amount`, otherwise revert; `inventory[token] -= amount; reserved[token] -= amount`.
5. Release the re-entrancy lock.

**`afterValidateUserOp`** (view; reads only the Summary and userOp calldata):

- `summary.active && !summary.revoked`;
- `paymasterAndData` is at least 20 bytes and `[0:20] == VerifyingPaymaster` (a session
  UserOp must be sponsored by us → `missingAccountFunds = 0`);
- `callData` is at least 4 bytes and its selector is `executeUserOp`;
- time validity only through Calibur's `validationData` (expiry): **no timestamp reads and
  no balance reads during validation**.

**`afterVerifySignature`**: `summary.active && !summary.revoked`.

**`afterIsValidSignature`**: **always reject** for session keys (no Permit / Permit2 /
off-chain orders).

**Management functions** (only `msg.sender == account`; session keys cannot reach them
because of step 3):

- `setPolicy(keyHash, policy)`: only when `!initialized && !revoked`; after the **validity
  checks**, writes the policy and `anchor = now`; `initialized = active = true`.
- `updatePolicy(keyHash, policy)`: only when `active`; validity checks apply; **must not
  change `anchor` or `periodLength`, must not reset any counter, must not remove an
  existing quote asset** (caps may only be lowered); a new cap below what was spent blocks
  all further spending.
- `revoke(keyHash)`: `active = false; revoked = true` (a tombstone that cannot be cleared).
  **O(1), no inventory iteration**: the revoked key's inventory stays frozen (still counted
  in `reserved`; no session can sell it) until the root releases it explicitly with
  `releaseInventory`.
- `releaseInventory(keyHash, token, amount)`: the root names exactly which key's
  attribution to release (active or revoked keys), reducing `inventory` and `reserved`
  (§4.2.6).

**Size limits** (enforced on chain, so that a panic fits in one transaction): at most
`MAX_SESSIONS = 8` active sessions per account (counted by the hook in `setPolicy`); per
policy `quoteLimits ≤ 4`, `trustedSpenders ≤ 4`, `permissions ≤ 16`. Worst-case panic work
= 8 Calibur `revoke` + 8 hook tombstones + **at most 128 allowance resets** (8 keys × 4
quote assets × 4 spenders, assuming no two keys share an allowance pair), **with no
inventory iteration**. The emergency-stop work measures gas on that worst-case fixture; if
it exceeds the gas / fee budget of one transaction, the size limits are lowered (no
account-level union counter is introduced).

**Policy validity checks** (fail closed; run by both `setPolicy` and `updatePolicy`):

- The quote asset of every `LAUNCHPAD_BUY` permission's launchpad (from the launchpad's
  immutable `quoteToken()`, i.e. trusted protocol configuration) must appear in
  `quoteLimits`; absence does not mean unlimited.
- If `maxValuePerCall > 0`, `mntLimit` must be configured.
- The `to` of an `ERC20_APPROVE` permission must be an asset in `quoteLimits`.
- The only permission allowed on a quote asset is `ERC20_APPROVE` (`approve`); any other
  selector on a quote asset (`transfer`, `transferFrom`, `increaseAllowance`,
  `increaseApproval`, …) is rejected.
- A quote asset cannot be the `token` of a SELL (also checked at run time).

#### 4.2.4 Limit semantics

- Fixed windows: `windowIndex = (now − anchor) / periodLength`; the period counter resets
  when the window changes, the total counter never resets. Up to 2× `periodCap` can be
  spent in a short span across a window boundary (known and accepted).
- Metering bounds the quote-asset net outflow **over one key's grant lifetime**; the root
  granting a new key creates new limits (an explicit human authorization, not a bypass).
- Non-quote assets (meme tokens) can leave **only** through a trusted launchpad SELL, and
  only up to the key's attributed inventory (D1, §4.2.6).

#### 4.2.5 Invariants (invariant / attack-test targets)

- **I1** A session cannot call a `(target, selector)` outside `permissions`, on every
  execution entry of the matrix.
- **I2** For any call sequence, each quote asset's net outflow stays within the total /
  period caps (business-call spending; gas is paid by the sponsor and the account's
  EntryPoint deposit should be 0).
- **I3** A session cannot change any policy (Calibur rejects self-calls; the hook rejects
  `to == hook`).
- **I4** A session cannot produce a valid ERC-1271 signature.
- **I5** (Trust premise: spenders meet §4.4.) A session can approve only `trustedSpenders`,
  for an exact amount within the remaining limit; after revoke / panic the related
  allowances are 0.
- **I6** (SDK) Never register a non-admin key without the hook.
- **I7** (SDK + scripts) The hook address's low five bits equal `0x1f` and it has code.
- **I8** The init batch includes `approveNative(ERC20ETH, 0)`; a session cannot move native
  MNT through any ERC-7914 path (including indirect calls by allowlisted targets).
- **I9** (D1) The cumulative quantity of a meme a session sells is at most what it
  obtained through BUY; provided the root follows §4.2.6, a session cannot dispose of the
  human's, airdropped or other sessions' positions; SELL fails closed on an attribution
  gap.
- **I10** A session's 4337 UserOps must use our paymaster; with a missing or wrong
  paymaster validation fails and the account loses no prefund.
- **I11** A revoked keyHash can never be reactivated (old signatures cannot execute even if
  Calibur accepts them cryptographically).
- **I12** A failed target call or a re-entry reverts everything; no "limit charged but
  nothing transferred" state exists.
- **I13** Policy validity: every allowed quote-asset spending path has a metering
  configuration; removing a limit cannot let a key buy with another key's allowance
  unmetered.

#### 4.2.6 Meme inventory attribution (D1)

The account's meme balance is shared; the hook keeps a **virtual attribution ledger** on
top of it:

- `inventory[keyHash][account][token]`: the quantity attributed to a session;
  `reserved[account][token] = Σ inventory`.
- **Unallocated balance** = `balanceOf − reserved`: the human's prior holdings, airdrops,
  direct transfers and positions released from revoked keys are unallocated, are **never
  attributed to a session automatically**, and only the root can dispose of them.
- **Conservation check:** SELL requires `balanceOf ≥ reserved` first; if a root disposal
  that broke the rules left a gap, every session SELL of that token fails closed until the
  root repairs it with `releaseInventory`, so the first key to act cannot take another
  key's attributed balance.
- **Root rule:** when disposing of meme attributed to a session, the root **states
  explicitly** a `(keyHash, token, amount)` release tuple; the SDK checks it (not more than
  that key's inventory) and puts `releaseInventory` and the disposal call in one
  `revertOnFailure = true` batch. **The SDK never infers attribution from balances or
  calldata**; for root calldata it cannot recognise that touches a token with reservations,
  it only warns about the ledger obligation. Disposing of the unallocated part needs
  nothing. CLI: `mantle-aa account exec --release <keyHash,token,amount>…`.
- The BUY balance delta is valid only if every positive balance change of that token within
  the call comes from this purchase — guaranteed by the §4.4 constraints on the launchpad
  and MemeToken (an independent transaction cannot land between one call's snapshots).

### 4.3 VerifyingPaymaster

- Source: eth-infinitism **v0.7.0** `samples/VerifyingPaymaster.sol` (v0.8.0 ships no
  samples), ported onto the v0.8.0 `core/BasePaymaster`, keeping the original licence.
- `getHash` covers: sender, nonce, `keccak(initCode)`, `keccak(callData)`,
  accountGasLimits, paymaster verification / postOp gas, preVerificationGas, gasFees,
  chainId, the paymaster address, **the EntryPoint address (added)**, validUntil,
  validAfter. Constants and actual slices are authoritative; the v0.7 comment describing
  the `paymasterAndData` layout is not copied.
- **Implemented (0.1.0)** (`contracts/src/VerifyingPaymaster.sol`,
  `contracts/test/VerifyingPaymaster.t.sol`):
  - The hash does **not** cover the account signature (the account signs after
    sponsorship, ERC-7677). Of `paymasterAndData` it covers only the paymaster address, the
    two gas limits and the validity window.
  - `paymasterAndData` layout: `paymaster ‖ uint128 verificationGas ‖ uint128 postOpGas ‖
    abi.encode(uint48 validUntil, uint48 validAfter) ‖ 65-byte signature`.
  - For a root init UserOp, the hashed `initCode` is the bytes the bundler packs: Alto and
    viem pack the EIP-7702 marker as the 2-byte `0x7702`; signing over the 20-byte padded
    form failed with `AA34` (`docs/infra.md` §3.5).
- **Delegate binding (added):** `_validatePaymasterUserOp` checks the `sender`'s code
  (ERC-7562 AUTH-030 allows `EXTCODE*` on the current sender) and requires it to equal
  exactly `0xef0100 ‖ CALIBUR_ENTRY`, including for later requests with empty `initCode`.
  This prevents "re-delegate after signing, re-sign the account signature, reuse the
  paymaster signature". Implemented as `EXTCODEHASH(sender) == keccak256(0xef0100 ‖
  CALIBUR_ENTRY)`, equivalent to the 23-byte comparison.
- Operations: the signer is a separate sponsor key; the deposit is funded in MNT; stake
  requirements follow the chosen bundler's actual validation (confirmed by the spike). No
  paymaster stake is needed while validation reads only immutables and returns an empty
  context (measured with strict Alto, `docs/infra.md` §3.3, §3.5, §8).
- The port diff, construction / ownership, ERC-7677 encoding and signing order are in scope
  of the contract review checkpoint and the final security review.

### 4.4 Interface contract for trusted spenders, the launchpad and MemeToken

These are the implementation requirements for this iteration's mocks **and binding design
constraints on the real launchpad**:

1. Not upgradeable; no delegatecall, arbitrary external calls, configurable modules or
   admin pull paths.
2. Funds are pulled only within the same call the account makes, and only from the actual
   `msg.sender` (`transferFrom(msg.sender, …)` or the MemeToken privileged transfer with
   `from == msg.sender`); an arbitrary `from` is never accepted.
3. MemeTokens are deployed by the launchpad factory from a fixed implementation; the
   privileged transfer entry may be called only by that launchpad; the launchpad accepts
   only tokens it registered (`sell(token, …)` checks the registry). Selling meme therefore
   needs **no approve**, and no dynamic token address ever appears in an allowlist.
4. Proceeds always go to `recipient`; the hook forces `recipient == account`.
5. MemeToken and quote assets have standard balance behaviour: no transfer fees, no
   rebasing, no transfer callbacks; the launchpad's quote asset is given by an immutable
   `quoteToken()`.
6. BUY transfers to the recipient only the purchased token's amount for this purchase and
   mixes no other inflow into the same call; SELL either fills `amount` in full or reverts
   (no partial fills).
7. Tests: a third party calling sell cannot reduce a victim's balance; calling the token's
   privileged entry directly is rejected; no public or admin entry can pull a victim's
   assets externally.

## 5. Off-chain design

### 5.1 SDK (`packages/sdk`)

```ts
interface Signer { address: Address; signTypedData(...): Promise<Hex>; signMessage(...): Promise<Hex>; signAuthorization?(...): Promise<SignedAuthorization> }

interface Executor {
  kind: 'relayer' | 'bundler'
  submit(req: ExecRequest): Promise<ExecResult>   // {account, keyHash, calls[], lane}
}

class MantleAccount {
  init(opts)                       // 7702 upgrade + safe initialisation (may include the first grant)
  status()                         // init state machine, keys, policies, remaining limits, inventory
  exec(calls)                      // root
  panic(opts)
  grantSession(policy)             // always generates a new session key
  updateSession(keyHash, policy)
  revokeSession(keyHash)
  listSessions()
}

class AgentSession {
  simulate(calls)                  // local replica of the hook rules + eth_call; structured rejection reasons
  exec(calls, { via })             // simulate first; a failure is reported locally and nothing is sent
}
```

- **Init state machine:** `UNDELEGATED → DELEGATED (safe initialisation incomplete) →
  INITIALIZED`. Before every retry, re-read the delegation, the EOA authorization nonce and
  the Calibur nonce, then decide whether a new authorization is needed. The sponsor accepts
  session business requests only for `INITIALIZED` accounts. Front-running the
  authorization only changes the initialisation state; it cannot take root control (Calibur
  has no initializer; root = EOA).
- **Signing conventions:** authorizations use `chainId = 5003` (never 0); management
  batches: `deadline = now + 10 min`, `executor = relayer`, `revertOnFailure = true`; agent
  SignedBatchedCalls: default `deadline = now + 2 min` (this bounds the SignedBatchedCall
  entry only; 4337 is bounded by the paymaster's `validUntil`).
- **Allowance cleanup:** an ERC20 allowance belongs to `(account, token, spender)`, not to
  a key. Revoke / panic reset the `(quote asset, trustedSpender)` allowances of the revoked
  key, **which may conservatively affect other keys** (accepted); update cleans up by the
  **difference between the old and new `(token, spender)` pair sets**.
- **Guards:** I6 and I7 are enforced inside `grantSession` / `updateSession`.
- **Mantle adaptation:** chain configuration (5000 / 5003), address book, MNT gas / L1 fee
  estimation (precise estimation is out of this week; spike measurements first).
- **Error model:** `PolicyViolation{reason, callIndex}`, `LimitExceeded{asset, remaining}`,
  `InventoryExceeded{token, held}`, `SponsorRejected{reason}`, `SponsorBusy`,
  `ExecutionReverted{data}`.

### 5.2 Sponsor service (`packages/sponsor`)

**Interface** (HTTP JSON-RPC):

- `sponsor_relay(signedBatchedCall, signature, authorization?)`
- `pm_getPaymasterStubData` / `pm_getPaymasterData` (ERC-7677)

**Request authentication** (separate from the final transaction signature):

- A request carries an EIP-191 signature over a "request digest" = canonical request
  fields + sender + authenticated keyHash + target EntryPoint / entry + chainId + sponsor
  domain separator + request validity.
- Root requests: the recovered address equals the sender (no registered key needed —
  works for the first init).
- Session requests: on-chain check that the key is registered, not expired and
  `summary.active`.
- The relayer path also verifies the SignedBatchedCall signature directly; the sponsor
  **decodes and simulates every request itself** (the SDK simulation is not trusted).

**Sponsorship policy:** `(sender, authenticated keyHash, nonce lane)` agreement (§4.1);
account allowlist; per-account daily gas cap; per-request fee cap; global daily budget;
management operations (revoke / panic / init) use a **separate reserved budget** that
business requests cannot consume; a hook for per-project sponsorship is reserved.

**Fee upper bounds:**

- 4337: `(verificationGasLimit + callGasLimit + paymasterVerificationGasLimit +
  paymasterPostOpGasLimit + preVerificationGas) × maxFeePerGas` (matches EP v0.8
  `_getRequiredPrefund`).
- Relayer (measured, `docs/infra.md` §5): `gasLimit × (maxFeePerGas + operatorFeeScalar ×
  100) + operatorFeeConstant + tokenRatio × GasPriceOracle.getL1FeeUpperBound(unsigned tx
  size)`, with the oracle's scalars read at reservation time. Settlement charges what the
  receipt says the sender paid: `gasUsed × effectiveGasPrice + l1Fee + gasUsed ×
  operatorFeeScalar × 100 + operatorFeeConstant` (matched to the wei). When the oracle cannot
  be read, the request is rejected.

**Ledger state machine** (SQLite): `authenticate → decode / simulate → transactionally
reserve the worst-case fee → submit / sign → settle on chain (failed transactions are
charged too) → release the remainder`.

- **At most one pending request per account**; otherwise a structured `SponsorBusy`.
- Idempotency: first look up an issued result by the stable authenticated request digest;
  a retry returns the same result (no extended validity, no second reservation); relayer
  results are identified by the SignedBatchedCall EIP-712 digest, paymaster results by
  `getHash`.
- A paymaster reservation starts when the signature is issued; after `validUntil` expires,
  **reconcile against on-chain events and settle any incurred fee before releasing**.
- Relayer nonces are persisted and reconciled with the chain's `pending` / `latest` at
  start-up; `mantle-aa sponsor relayer status|bump|cancel` recovers manually (bump reserves
  the extra first; a cancel can lose to the original transaction — settle by the
  transaction actually confirmed).

**Embedded mode** (kept this iteration): with `MANTLE_AA_EMBEDDED_RELAYER=1` the CLI runs
the same sponsor logic (authentication / policy / ledger) in process and submits with a
local relayer key; tests and local demos only.

### 5.3 Keystore

- `~/.mantle-aa/keys/<name>.json` (encrypted JSON keystore); password entered
  interactively or injected through `MANTLE_AA_KEYSTORE_PASSWORD`.
- Profiles: `~/.mantle-aa/profiles.json` maps `name → {account, keyHash, keyfile, role}`;
  every grant creates a new key and a new profile version.

## 6. CLI

```
mantle-aa keys new|import|list
mantle-aa account init     [--grant <policy.json> --agent <name>]
mantle-aa account status
mantle-aa account exec     --calls <json> [--release <keyHash,token,amount>…]
mantle-aa account panic    [--self-pay] [--undelegate]
mantle-aa session grant    --agent <name> --policy <policy.json>
mantle-aa session update   --agent <name> --policy <policy.json>
mantle-aa session revoke   --agent <name>
mantle-aa session list
mantle-aa agent simulate   --agent <name> --calls <json>
mantle-aa agent exec       --agent <name> --calls <json> [--via relayer|bundler]
mantle-aa sponsor serve    --config <sponsor.yaml>
mantle-aa sponsor relayer  status|bump|cancel
```

Conventions: every command supports `--json`; exit codes `0` success / `10` policy
rejection / `11` limit exceeded / `12` inventory exceeded / `13` key expired or revoked /
`20` sponsor rejection / `21` sponsor busy / `30` on-chain revert / `1` other;
`agent exec` simulates locally first.

## 7. Key flows

### 7.1 Init (+ first grant)

1. The root signs a 7702 authorization (delegate = CaliburEntry, chainId 5003).
2. The root signs a SignedBatchedCall: `[approveNative(ERC20ETH, 0), register(agentKey),
   update(agentKeyHash, {hook, expiry}), hook.setPolicy(agentKeyHash, policy)]`,
   executor = relayer, deadline 10 min.
3. The sponsor checks the delegate, authentication and budget → submits a type-4
   transaction (authorizationList + `execute(...)`).
4. Note: the 7702 authorization takes effect before execution, so **a failed execution does
   not undo the delegation** → the state stays `DELEGATED` and is retried per the §5.1
   state machine.

(The 4337 path is equivalent: the UserOp carries `eip7702Auth`, sponsored by the
VerifyingPaymaster.)

Only the root's init UserOp may carry `eip7702Auth`; session UserOps **never** do. They
target already-delegated accounts with empty `initCode`. Reason (ERC-7562 STO-021/022): a
bundler treats the `0x7702` marker as sender creation, and the hook's validation reads
sender-associated storage in an external contract, which is then allowed only with a staked
factory (the marker can never be staked). Measured rejection by strict Alto and the reference-bundler citation:
`docs/infra.md` §3.4.

### 7.2 Agent execution (relayer by default)

SDK simulate → the session key signs a SignedBatchedCall (agent lane, deadline 2 min) →
signs the request digest → sponsor authenticates / simulates / reserves → submits →
settles.

### 7.3 Revoke / panic

- `revoke`: the root signs `[revoke(keyHash) (Calibur), hook.revoke(keyHash),
  approve(quote, spender, 0)…]`, submitted on the management budget.
- `panic`: one transaction revokes every non-root key + hook tombstones + clears the
  related allowances (bounded by the §4.2.3 size limits; inventory is not released — the
  revoked keys' positions stay frozen until the root releases them explicitly).
- `--self-pay`: the root EOA sends the transaction itself, calling its own
  `execute(BatchedCall)`; **the root must hold gas** (funded first in acceptance).
- `--undelegate`: **two phases** — first complete and confirm the atomic revocation above,
  then send a separate type-4 transaction delegating to the zero address. Clearing the
  delegation does not clear account storage (keys / nonces / storage remain); if the same
  implementation is delegated again later, revoked keys are still tombstoned.

## 8. Acceptance (definition of done)

**Fixture:** MockUSD (mintable standard ERC20, the quote asset); MockLaunchpad + MemeToken
factory (meeting §4.4); principal obtained by minting; **the human and the agent hold 0 MNT
throughout**.

**Policy:** permissions = `(MockUSD, approve)`, `(MockLaunchpad, buy)`,
`(MockLaunchpad, sell)`; trustedSpenders = `[MockLaunchpad]`; MockUSD total / period caps;
expiry 24 h.

On Mantle Sepolia, through **both** the relayer and the bundler path:

1. `account init` (with the first grant) completes gaslessly; state `INITIALIZED`.
2. `agent exec`: the batch `approve(MockUSD → Launchpad, exact) + buy(meme, amountIn, …)`
   succeeds.
3. `agent exec`: `sell(meme, ≤ inventory, …)` succeeds and MockUSD returns to the account.
4. Every overreach is rejected, **including when submitted on chain directly, bypassing
   the SDK's local pre-check**: target outside the allowlist, over-limit approve / buy,
   selling more than the session's own inventory (including meme the human held before),
   `to == hook`, ERC-1271 signature, wrong paymaster, expired key, deadline out of range,
   `recipient ≠ self`.
5. After `session revoke`, neither old nor new signatures execute; re-granting the same
   key is rejected.
6. `account status` / `session list` show the state machine, keys, policies, remaining
   limits and inventory correctly.

Also:

- **MNT value case:** fund explicitly after init; test `maxValuePerCall` and the MNT limit;
  record principal and gas separately.
- **Panic:** with the sponsor stopped, `panic --self-pay` succeeds after the root is funded;
  `--undelegate` completes in two phases.
- **Embedded mode:** E2E runs without a long-running sponsor.
- **Entry-point matrix:** direct `execute(BatchedCall)`, ERC-7821, SignedBatchedCall,
  executeUserOp and ERC-1271 all cover the applicable I1–I13.

## 9. Testing and security

- **Contracts:** Foundry unit + fuzz + invariant (I1–I5, I8–I13); invariant configuration
  `runs = 512, depth = 64`, three fixed seeds in CI; on a fork with the real CaliburEntry
  v1.1.0.
- **Attack tests** (at least): approve-only followed by an external pull; pull after
  revoke; leftover allowance after a failed buy; inflow and outflow within one call and
  across calls; failed calls (the `revertOnFailure = false` bypass); abnormal `balanceOf`;
  fee-on-transfer tokens (rejected / unsupported); re-entry through allowlisted callbacks
  (same key / other key); indirect native pull by an allowlisted target (etched ERC20ETH
  mock); a third party calling sell to pull a victim's balance; re-delegating to reuse a
  paymaster signature; paymaster field tampering / cross-chain / expiry; cross-lane nonce
  consumption (recorded on chain as a known limitation; the sponsor must reject it);
  cross-path replay; a front-run authorization; retry after a failed grant. **D1 /
  metering:** several keys holding the same token; the human's prior holdings and airdrops
  are never attributed; SELL fails closed after the root moves attributed tokens without a
  release; after revoke, inventory / reserved / actual balance are unchanged and the old
  key cannot SELL; other active keys of the same token can still sell their own
  inventory; an explicit root release for a revoked key reduces only that inventory and
  reserved by the same amount (balance unchanged, unallocated increased); partial fills
  rejected; sending 1 MNT charges exactly 1 MNT of limit; "another key approved but this
  key has no quote limit" and "update removes a limit but keeps BUY" are rejected; with
  several keys and an unallocated balance of one token, only the named key is released;
  `setPolicy` beyond the size limits is rejected; panic at the maximum size succeeds with
  gas recorded.
- **Sponsor:** 3 agents × 5 requests concurrently on one account → queueing / `SponsorBusy`
  followed by retries all complete, with no duplicate submission and no over-reservation;
  relayer nonce allocation across several accounts; reconciliation after a restart;
  revert griefing is charged.
- **E2E:** anvil fork + strict-mode (non-unsafe) Alto, both paths through §8; the Sepolia
  script produces a list of transaction links.
- **Security review** (a contract checkpoint in 0.1.0 and a final review in 0.1.3):
  `AgentPolicyHook` in full, the `VerifyingPaymaster` port diff and the sponsor signing
  logic, the Calibur v1.0.0 → v1.1.0 diff, the SDK guards I6 / I7; earlier releases have
  review checkpoints for what they deliver.
- The README states "POC, not audited"; sponsor hot wallets hold small amounts only.
- The 0.1.0 contract review checkpoint is `docs/reviews/0.1.0.md` (High 0 / Medium 0 /
  Low 1 / Info 3). Its SR-02 (`approveNative(ERC20ETH, 0)` in init) and SR-03 (atomic
  hooked grant) are SDK preconditions of I8 and I6.
- The 0.1.3 final security review is `docs/reviews/0.1.3.md` (High 0 / Medium 1 / Low 1 /
  Info 0, on `ac975ec`); its SR3-01 and SR3-02 were fixed afterwards (#52, #53).

## 10. Risks and open items

| Item | Description | Handling |
|---|---|---|
| Strict bundler feasibility | Whether strict-mode Alto / Pimlico accept a real type-4 delegation + a hook reading the Summary + a paymaster checking the delegate | **Landed** (`docs/infra.md`): Alto 0.0.21 in safe mode with a committed one-hunk result-decoding patch (owner decision); stock Alto cannot run safe mode for EntryPoint v0.7/v0.8 |
| Pimlico v0.8 on Mantle Sepolia | Not listed in its docs | Measured (`docs/infra.md` §4): the public endpoint for 5003 has no EntryPoint v0.8; the patched Alto is used |
| Mantle L1 fee | Affects the relayer fee upper bound | Measured (`docs/infra.md` §5): `paid = gasUsed × effectiveGasPrice + l1Fee + gasUsed × operatorFeeScalar × 100 + operatorFeeConstant`; operator fee ≈ 10 gwei/gas, L1 fee negligible |
| Canonical address reproduction | The commit `d7dbc80` named in the Calibur README is on upstream branch `audit-main` (`src/` identical to v1.1.0) | Reproduced on Mantle Sepolia (§4.1, `deployments/mantle-sepolia.json`) |
| Hook / paymaster unaudited | Our own core contracts | Invariants + attack tests + cross review + small funds |
| Trusted-implementation assumption | The §4.4 contract needs manual verification | Written into the real launchpad's design constraints |
| Position value / execution price | A compromised session can sell all of its attributed positions cheaply; the mark-to-market loss can exceed its quote limit | Accepted (cost-basis promise in §4.0) |
| Root disposal of attributed positions | Disposal without an explicit release creates an attribution gap | SELL fails closed; the root states release tuples, which the SDK checks and batches atomically |
| Frozen inventory | Revoked keys' positions stay frozen until the root releases them | Accepted; `account status` shows frozen positions |
| Official Mantle 7702 sponsorship | Unknown whether it exists | The sponsor interface is replaceable |
| Native AA migration | If Mantle adopts 8130 / 8141 | The permission model is independent of transport; add an Executor |

## Appendix A: Research summary

- **OKX Wallet:** `okxlabs/okx-smart-wallet-evm` — 4337 v0.7 + 7702 + `executeWithRelayer`,
  pluggable validators (ECDSA / passkey), AllowanceManager; BlockSec and CertiK audits; MIT.
- **Base / Coinbase:** `EIP7702Proxy` upgrades an EOA to CoinbaseSmartWallet; 4337 + CDP
  Paymaster / ERC-7677; mainnet 7702 delegations are sponsored by Coinbase. The native-AA
  direction is EIP-8130 (keystore + actors + native payer; account contracts are portable
  and use 4337 on chains without 8130), currently only on the vibenet devnet.
- **Uniswap Calibur:** non-upgradeable singleton, EP v0.8, ERC-7821 batches, signed
  `execute` (optional executor), per-key expiry / admin / hook; Cantina and OpenZeppelin
  audits; MIT.
- **MetaMask:** `EIP7702StatelessDeleGator` + ERC-7710 / 7715 delegations, works with any
  4337 bundler / paymaster.
- **Porto (Ithaca):** 7702 accounts + its own relay / orchestrator, no 4337.
- **ethereum.org 7702 guidance:** use a 4337 bundler with EntryPoint ≥ v0.8 as the relayer.
- **Native AA:** zkSync (protocol level, single mempool, paymasters for EOAs); Tempo 0x76
  (separate fee-payer signature domain, access keys with spending limits, batches, validity
  windows); Ethereum EIP-8141 frame transactions (scheduled for Hegotá; the choice against
  8130 is still open).
- **4337 risks:** thin Mantle infrastructure, extra latency, ERC-7562 validation rules
  (including AUTH-010…040 for 7702), gas overhead, MNT / L1-fee estimation, EntryPoint
  version churn, a future migration to native AA.

## Appendix B: Independent design review record (six rounds)

| # | Severity | Topic | Outcome |
|---|---|---|---|
| R1 | Major | CaliburEntry, domain version / salt | Accepted (§4.1) |
| R2 | **Blocker** | Pull after approve, outside the account, bypasses limits | Accepted: trusted-spender model + exact-amount approve + no incremental approvals + allowance reset on revoke (§4.2.3, §4.4, I5) |
| R3 | Major | ERC20ETH default native allowance | Accepted: reset to 0 at init (I8) |
| R4 | Major | Two nonce systems; lanes are not on-chain isolation | Accepted (§4.1) |
| R5 | Major | 4337 prefund bypasses the hooks | Accepted: session UserOps must use our paymaster (I10) |
| R6 | Major | Accounting of failed calls; re-entry | Accepted: revert on failure + account-level lock (I12) |
| R7 | Major | Balance-delta semantics; token types | Accepted: net outflow, standard tokens, every quote asset metered |
| R8 | Major | Period and update semantics | Accepted: fixed windows, updates never reset, tombstone instead of epoch (I11) |
| R9 | Major | Non-atomic init; signing constraints | Accepted: state machine + signing conventions (§5.1, §7.1) |
| R10 | Major | Undelegate cannot share the revocation transaction | Accepted: two phases (§7.3) |
| R11 | Major | Sponsor reservation and recovery | Accepted: ledger state machine, authentication, fee bounds, idempotency, reconciliation (§5.2) |
| R12 | Major | Paymaster signature scope; delegate binding | Accepted: v0.7 port + EntryPoint in the hash + delegate check (§4.3) |
| R13 | Major | ERC-7562 storage | Accepted, with the author's correction: account as the innermost key; validation reads a fixed-size summary only (§4.2.1) |
| R14 | Major | Direct-call entries bypass the sponsor / validation hooks | Accepted: entry-point matrix; restrictions at execution time (§4.1) |
| R15 | Major | Buy only; no execution protection | Accepted: fixed buy/sell ABIs, two-sided deadline check, price risk stated |
| R16 | Major | Contradictions in the acceptance fixture | Accepted: MockUSD quote asset, 0 MNT, SDK-bypass tests (§8) |
| R17 | Major | Dependency graph | Accepted (issue plan) |
| R18 | Major | One-week feasibility | Accepted: day-1 spike, buffer day; embedded mode kept by owner decision |
| N1 | — | Metering dynamically created meme tokens | Owner chose D1 = per-key inventory cap (I9) |
| F1 | Major | D1 does not imply "max loss ≤ limit" | Accepted: cost-basis wording (§4.0) |
| F2 | Major | Conservation of the shared balance | Accepted: reserved + fail closed + `releaseInventory` (§4.2.6) |
| F3 | Major | Partial fills; the BUY balance-delta premise | Accepted: no partial fills; §4.4 items 5–6 |
| F4 | Major | MNT charged twice | Accepted: MNT by value only; balance deltas for ERC20 only (§4.2.3) |
| F5 | Major | Policy validity | Accepted: fail-closed checks + allowance cleanup by pair-set difference (I13) |
| F6 | Major | Release gates, paymaster deployment, critical path | Accepted (issue plan) |
| F7 | Minor | Sponsor lane check | Accepted: deterministic lane derivation + admission check (§4.1, §5.2) |
| F8 | Minor | Issue number references | Accepted |
| F9 | Major | Revoke iterating inventory has unbounded gas | Accepted: O(1) revoke, frozen inventory + explicit release; size limits (§4.2.3) |
| F10 | Major | Automatic release cannot determine attribution | Accepted: explicit root release tuples; the SDK never infers (§4.2.6) |
| F11 | Major | Panic allowance-reset bound miscounted | Accepted: worst case 128 pairs, measured on a worst-case fixture; lower the limits if over budget |
| F12 | Minor | Test list still said "revoke releases inventory" | Accepted: replaced by frozen-inventory acceptance |

### Final review conclusion and remaining known risks

Conclusion: **final** (document review only; no contract tests, on-chain spike or gas
measurement were run).

1. Not externally audited: security depends on Calibur, the hook, the paymaster and the
   trusted launchpad / token implementations meeting the design constraints.
2. Infrastructure and schedule: one-week delivery depends on the day-1 strict-bundler
   spike succeeding; Mantle fee bounds and worst-case panic gas must be measured.
3. Economic loss boundary: limits bound cost basis, not position value, gains or execution
   price.
4. Attribution ledger maintenance: frozen inventory after revocation needs an explicit root
   release; a root that moves assets outside the rules makes SELL of the related token
   fail closed.
5. Availability and operations: nonce lanes are not isolated on chain (cross-lane DoS);
   when the sponsor is down, a self-pay emergency stop requires the root to hold gas.
