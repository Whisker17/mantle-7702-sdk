# Infrastructure on Mantle Sepolia

**Settled bundler setup (release 0.1.2): §10.** Sections 1–9 are the feasibility spike of
release 0.1.0. Its scripts moved: `e2e/spike/bundler.sh` is now `e2e/bundler/sepolia.sh`,
`e2e/spike/trace-proxy.mjs` is `e2e/bundler/trace-proxy.mjs`, and
`e2e/spike/alto-safe-validator.patch` is `e2e/bundler/alto/safe-validator.patch`; the spike
sections below cite the new paths.

Measured 2026-10-18 on Mantle Sepolia (chain id 5003, public RPC
`https://rpc.sepolia.mantle.xyz`, client `mantle-reth/op-reth-v2.2.1-mantle-arsia.2-dev`).
This answers the day-1 risk of `docs/DESIGN.md` §10. The question was whether a relayer-path
type-4 transaction and a session UserOp through a strict (non-unsafe) bundler actually land with
the real `AgentPolicyHook` and a paymaster that checks the sender's delegate.

**Result: both landed.** The relayer path works as designed. The bundler path works through
Alto in safe mode, with two caveats:

- Stock Alto cannot run safe mode for EntryPoint v0.7/v0.8 (§3.2). The gate was passed with a
  one-hunk local patch that fixes only the result decoding (§3.2, §9).
- ERC-7562 rejects a *session* UserOp that carries `eip7702Auth` (§3.4). Only the root's init
  UserOp may carry it. Session UserOps go to accounts that are already delegated.

The spike contracts (`contracts/src/spike/`) are throwaway. The addresses below are not in
`deployments/`.

Explorer links use `https://sepolia.mantlescan.xyz/tx/<hash>`. Mantle's own explorer URL
`https://explorer.sepolia.mantle.xyz/tx/<hash>` answers `302` to exactly that address (checked
with curl). Mantlescan itself serves a Cloudflare JS challenge to curl (`403`), so the page
render was not machine-checked. Every transaction below was checked through `eth_getTransactionReceipt` (status 1).

## 1. Deployed spike contracts

All were deployed from the spike deployer `0xa879350e8e7794172Baf3DbeC027e0F03520B7fA`
(`contracts/script/spike/SpikeDeploy.s.sol`).

| Contract | Address | How | Tx |
| --- | --- | --- | --- |
| CaliburEntry v1.1.0 | `0x6d5A5d57cB1112e931BAC1c636E0964Cf7234F04` | plain CREATE | [0x5b971ba8…76db](https://sepolia.mantlescan.xyz/tx/0x5b971ba8c95eea51641843d0a1ce35eba4f27917b6c4bcca752e3be1438776db) |
| SpikePaymaster (EP v0.8, signer `0xD4CF09a147428ADAC2375Ecb22de6b100Ef304C4`) | `0x9B4f47f7870b9C19A86F78dEBa044D8A1c8684e7` | plain CREATE | [0x30196418…9900](https://sepolia.mantlescan.xyz/tx/0x3019641856b8bea0890105b3f6bf09f7436f38f87e106fde1a2581b04b9b9900) |
| AgentPolicyHook (the real, merged hook; `PAYMASTER` = SpikePaymaster) | `0xA900F066EbdF9AbB4e1849aE1CaD5dB0DC42367F` (low five bits `0x1f`) | CREATE2 deployer `0x4e59…956c`, mined salt `7` | [0x4a282284…f3f8](https://sepolia.mantlescan.xyz/tx/0x4a282284ccdd1b0f88912edfa1745b6b3e15001fd4ace9cd3d2bdc7c41a4f3f8) |
| SpikeTarget (`ping(uint256)` emits `Pinged(account, tag)`) | `0x45D7ACB22806952B02b7664ffF80d868cAcb0491` | plain CREATE | [0xdc94d589…b7ca](https://sepolia.mantlescan.xyz/tx/0xdc94d5898ea5895d2e40e7d84b47ba74428b595ac9edb8ffd4f97a52874ab7ca) |
| Paymaster deposit 0.3 MNT into EP v0.8 | — | `deposit()` | [0xbfab8de1…e4cd](https://sepolia.mantlescan.xyz/tx/0xbfab8de1e6d7ac303fb44d4e2f989cc393ea442fe669246f394bcc631626e4cd) |

SpikePaymaster is a minimal VerifyingPaymaster. Its validation requires
`keccak256(sender.code) == keccak256(0xef0100 ‖ CaliburEntry)` (the 23-byte delegation designator,
read with `EXTCODESIZE`/`EXTCODECOPY`). It also checks an ECDSA signature by the sponsor signer
over the UserOp fields plus `validUntil`/`validAfter`. It reads only immutables and returns an
empty context, so it is **unstaked**.

The session policy grants exactly one permission: `(SpikeTarget, ping, NONE)`. Session-key
settings use the hook with a 7-day expiry.

Accounts. Each holds **0 MNT** throughout:

- root A `0xc83B1FF2ea0CD2Dea813f9757bB7A029c71C21A9`, delegated by the relayer path;
- root B `0x1f729e1c764E4Fd881A16C855624Aa6E1b725159`, delegated by the bundler path;
- session key `0x40E6900C6da4d9459E01111Ca52d1fd600292A02`, keyHash
  `0x4418cc18bf3f94241b3ec7e83db53de5f67afd4d8f0507f26fdade3bdc4c41e0`.

## 2. (a) Relayer path — landed

The relayer is the spike deployer key. It is the SignedBatchedCall `executor`
(`contracts/script/spike/SpikeRelayer.s.sol`).

| Step | Tx | Facts |
| --- | --- | --- |
| Delegation + grant: type-4 transaction. `authorizationList = [CaliburEntry, chainId 0x138b, nonce 0]` signed by root A, calling `execute(SignedBatchedCall)` with the root batch `register(sessionKey)`, `update(keyHash, {hook, expiry})`, `hook.setPolicy` | [0x67a69667…a9f](https://sepolia.mantlescan.xyz/tx/0x67a69667f88cc4c93cf558de5898c812b778b77301ca774b1e39e6d36647ea9f) | type `0x4`, gasUsed 438 589. Afterwards root A's code is `0xef0100 ‖ CaliburEntry` and the hook Summary is active |
| Session SignedBatchedCall on the session lane (`uint192(keyHash >> 64)`, seq 0): `SpikeTarget.ping(1)` | [0xea6530cd…a7c](https://sepolia.mantlescan.xyz/tx/0xea6530cd7b214bbb0ddb70df8c20a96fca4cb1f4e66bdeb39ead4ad00fe6aa7c) | type `0x2`, gasUsed 116 108, `Pinged(root A, 1)` emitted. The hook ran `afterVerifySignature`, `beforeExecute` and `afterExecute` |

The SDK can compute the SignedBatchedCall digest offline before delegation. The Calibur domain is
`("Calibur", "1.0.0", 5003, account, salt = bytes32(uint160(CaliburEntry)))` (salt prefix 0).
`sessionCall` asserts that this equals the account's on-chain `hashTypedData`.

## 3. (b) Bundler path — landed (strict Alto, patched)

### 3.1 What "strict" means in this run

- **Bundler:** Alto `@pimlico/alto@0.0.21` (npm `latest`, published 2026-08-18). It is installed
  pinned into the run directory outside the workspace by `e2e/bundler/sepolia.sh` (then
  `e2e/spike/bundler.sh`), with `e2e/bundler/alto/safe-validator.patch` applied (§3.2, §9).
- **Flags:**
  `--entrypoints 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108 --rpc-url http://127.0.0.1:18546
  --safe-mode true --chain-type mantle --block-time 2000 --port 4337 --refilling-wallets false
  --deploy-simulations-contract true --log-level info`. The executor and utility key
  (`0xc0cC940EEf35CE9c7430403c1269a57D6f8FD451`) go in through `ALTO_EXECUTOR_PRIVATE_KEYS` /
  `ALTO_UTILITY_PRIVATE_KEY`, never on a command line. All other options use Alto defaults,
  including `--min-entity-stake 1`, `--min-entity-unstake-delay 1` and `--eip-7702-support true`.
- **Validation:** safe mode, which means `SafeValidator` → `debug_traceCall` with Alto's JS
  `bundlerCollectorTracer` → `tracerResultParserV07` (ERC-7562 opcode, storage, stake and
  context rules). No rule or tracer code is modified.
- **Tracing node:** Mantle Sepolia's public RPC rejects `debug_*` (`403 "rpc method is not
  whitelisted"`). `e2e/bundler/trace-proxy.mjs` therefore routes every `debug_*` request to a
  local **anvil 1.7.1** fork (`--hardfork prague`). Before each trace, the proxy calls
  `anvil_reset` to fork the upstream head. Every trace was logged with its fork block; one example
  is `debug_traceCall -> trace node @ fork block 45378193: ok`. Anvil supports JS tracers
  (checked).
- **Everything else** goes unchanged to the real Mantle Sepolia RPC: reads, `eth_call`, gas
  prices, nonces, gas estimation, `eth_sendRawTransaction` and receipts. Bundles are submitted to
  and land on the real chain.
- **Simulation contracts:** Alto deployed these with its utility key through the CREATE2 deployer.
  PimlicoSimulations `0xf050608D8c131296BccA23A992E4F3f1135790a7`, EntryPointSimulations v7
  `0xcD13a28aF05Dc14Fba6e5ea95bBbC425248C2DC7`, v8 `0xcfFF0eb14cbA7ce1437190d4c856a47a9374e354`
  and v9 `0xC53c61c137986366E676B6F2A854947E8fF9e472`. Txs:
  [0xda991293…e16a](https://sepolia.mantlescan.xyz/tx/0xda991293c3f60c27874067f7e81868b345cf665901d5721acaa2195480fae16a),
  [0x1089284d…0597](https://sepolia.mantlescan.xyz/tx/0x1089284d16ad5de3cdad0837c5d7139e11104ee20ab1370c784d4c0033fa0597),
  [0x5eec6fb8…0dcb](https://sepolia.mantlescan.xyz/tx/0x5eec6fb8c4e4315b3d1289eeff9c034ca6cef92b2feb0f99d2a9812687830dcb),
  [0x06661db2…7c0f](https://sepolia.mantlescan.xyz/tx/0x06661db279176e35da4fdf110e03768c6ef8fa7aae4a77f0e71d6ba23eea7c0f).

Validation ran on a fork of the head and was not re-validated on a geth node. One fidelity
artifact of anvil's JS tracer is known (§3.5).

### 3.2 Stock Alto cannot do safe mode for EntryPoint v0.7/v0.8

This was measured with stock 0.0.21, and `rpc/validation/` of `0.0.0-main.20261013T112709` is
byte-identical. Every v0.8 UserOp, including valid ones, is rejected by `eth_sendUserOperation`
with:

```
Encoded error signature "0x99410554" not found on ABI. ... Version: viem@2.57.7
```

The cause is in `esm/rpc/validation/SafeValidator.js`, `getValidationResultWithTracerV07`:

1. It traces `PimlicoSimulations.simulateValidation`, which calls
   `EntryPoint.delegateAndRevert(EntryPointSimulations, …)`.
2. It takes the *last traced call exit* as the result. The tracer never records the top-level
   frame, so that exit is the EntryPoint's revert `DelegateAndRevert(bool success, bytes ret)`
   (selector `0x99410554`).
3. It decodes that with `decodeErrorResult({abi: pimlicoSimulationsAbi, …})` and expects an
   error named `ValidationResult`. `pimlicoSimulationsAbi` contains no errors at all, because
   `simulateValidation` *returns* the `ValidationResult`. So decoding always throws.

The tracing itself succeeds. The traced data was `DelegateAndRevert(true, <ValidationResult>)`.
A debug-enabled RPC would therefore not help.

**Patch** (`e2e/bundler/alto/safe-validator.patch`, one hunk plus one import): decode
`DelegateAndRevert(success, ret)`. On success, decode `ret` as the `simulateValidation` return
value. On failure, decode `FailedOp` / `FailedOpWithRevert` so the `AAxx` reason survives. Every
ERC-7562 check after this point is unchanged. `sepolia.sh` with `ALTO_PATCH=0` runs stock Alto
and reproduces the failure.

### 3.3 Landed UserOps

`e2e/spike/userop.sh` builds and signs with `contracts/script/spike/SpikeUserOp.s.sol`, sizes the
op with `eth_estimateUserOperationGas` and sends it.

| UserOp | handleOps tx | Facts |
| --- | --- | --- |
| **Session UserOp, no `eip7702Auth`**, root A, session lane, `ping(3)`. Sponsored by SpikePaymaster. The real hook's `afterValidateUserOp` reads the Summary | [0x8f778f38…3fb7](https://sepolia.mantlescan.xyz/tx/0x8f778f383d7ad2bc95a8ea7f00da0b124c106cfe12de3d2eca50fc5965593fb7) | userOpHash `0x798442d326f4fd3af95cf1b28e417dae5a6efcc1c0f1836690122f160ef02a7e`, success. `Pinged(root A, 3)`. Tracer verdict OK. Sent through the same patched Alto, started by hand before the patch also decoded `FailedOp` |
| **Root init UserOp with `eip7702Auth`** for fresh root B: `factory = 0x7702`, authorization `[CaliburEntry, 5003, nonce 0]`, raw root signature, grant batch (register, update, `hook.setPolicy`), sponsored by SpikePaymaster | [0x99e841ba…2119](https://sepolia.mantlescan.xyz/tx/0x99e841ba2adf79d13af08c4dbda130322552c96c64eb08041d465c4637272119) | **type `0x4`** bundle from the executor to EP v0.8, with the authorization in `authorizationList`. userOpHash `0x305f6aa959122e902b4356def5505560ab4883c98bfad3adbde76289254959a1`, success. Afterwards root B's code is `0xef0100 ‖ CaliburEntry` and the hook Summary is active. This is the bundler-path type-4 delegation |
| Session UserOp, no `eip7702Auth`, root A, `ping(5)`, through the committed `bundler.sh up` (now `e2e/bundler/sepolia.sh`) + `userop.sh session 5` | [0xb1aa2ba1…94f3](https://sepolia.mantlescan.xyz/tx/0xb1aa2ba1b8ca3e29fb46e41099dd2ace19b3885fd04bcfd8ab39c014243794f3) | userOpHash `0xb4b80d00d2950c0fc2beb115425f7cea6606489c2575ef5c34e584efefa7a5be`, success. `Pinged(root A, 5)` |

These validation reads passed the strict checks, as shown by the tracer result in Alto's log:

- the hook read exactly one slot, `summaries[keyHash][account]` =
  `keccak(account ‖ keccak(keyHash ‖ 0))` (sender-associated, STO-021);
- the paymaster used `EXTCODESIZE` and `EXTCODECOPY` on the sender (23 bytes, AUTH-030);
- the paymaster stayed unstaked: no storage access and an empty context (EREP-050).

### 3.4 Measured constraint: a session UserOp must not carry `eip7702Auth`

Root A was already delegated. Its session UserOp **with** `eip7702Auth` (`factory = 0x7702`) is
rejected by the patched strict Alto:

```
{"message":"unstaked account accessed 0xa900f066ebdf9abb4e1849ae1cad5db0dc42367f slot 0x2c7d3fe7f4723aa2631f331d620df024131d126a43f15648617875b53c7458be","data":{"account":"0xc83B1FF2ea0CD2Dea813f9757bB7A029c71C21A9"},"code":-32502}
```

The slot is the hook Summary of `(keyHash, root A)`. Under ERC-7562 STO-021, sender-associated
storage in an external contract is allowed only when the op does not create the sender. An op with
a factory counts as sender creation, and then STO-022 requires a *staked factory*. Both bundlers
treat the `0x7702` marker as a factory, and the marker can never be staked:

- Alto 0.0.21 `esm/rpc/validation/TracerResultParserV07.js:486` (`if (userOp.factory) { … }`).
  Alto also accepts the read if the *account* is staked in the EntryPoint. That is non-standard,
  and the account would need MNT.
- The eth-infinitism reference bundler 0.8.1 (commit `aae77140e5c2b1386d04eaeba2d23fc17a62bd87`),
  `packages/validation-manager/src/ERC7562Parser.ts:640`
  (`const isSenderCreation = userOp.factory != null`) and `:655–658`
  (`isAllowedSTO021 = isSenderAssociated && !isSenderCreation`; STO-022 needs `isFactoryStaked`).

**Consequence:** only the root's init UserOp may carry `eip7702Auth`. Its validation never enters
the hook, because the root key has no hook. Session UserOps are sent without it, to accounts
already delegated and initialised.

Facts on avoiding the hook read (the hook was not changed):

- The read is the hook's revocation check (DESIGN §4.2.3).
- Execution re-checks `summary.active` in `beforeExecute`. Calibur's own `revoke(keyHash)` lives
  in account storage (STO-010), and an unregistered key fails validation.
- Skipping the read when `initCode` is the 7702 marker would still keep the execution-time
  guarantee. It would let a hook-revoked key that is still registered in Calibur pass validation,
  though, and the paymaster would then pay for the reverted execution.

### 3.5 Other findings on the bundler path

- **`initCode` bytes.** Alto and viem pack `factory = "0x7702"` with empty `factoryData` as the
  *2-byte* `initCode` `0x7702`, not the 20-byte padded marker. Both are valid for EP v0.8 (the
  userOpHash substitutes the delegate). A paymaster hash over `keccak(initCode)`, however, must use
  the bytes the bundler packs. Signing over the 20-byte form failed with `AA34 signature error`.
- **Tracing-node artifact.** Anvil's JS tracer reports the step after a returning call with the
  callee's gas as `getCost()`. A replay showed `SWAP1` with cost 33 935 at Calibur pc 11220. With
  Alto's estimated `verificationGasLimit` (0x10cd9), this trips OP-020 (`"account internally
  reverts on oog"`). A geth tracing node would not. `userop.sh` adds 50 % headroom
  (`VERIFICATION_GAS_PCT=150`). Unused verification gas is not charged.
- **Verification gas.** The first op on a fresh nonce lane costs about 22 k more verification gas
  (nonce slot 0 → 1). Estimates were 0x17c6e on the first op and 0x10cd9 later.
- **Stake.** No entity needed stake: the account and the paymaster were unstaked. A paymaster
  that reads its own storage or returns a context would need stake. Alto's default minimum is
  1 MNT with a 1 s delay.
- **PreVerificationGas.** `--chain-type mantle` computes PVG from the BVM oracle L1 fee only. It
  does not cover Mantle's operator fee (§5), so the executor lost MNT on every bundle (§5 table).

## 4. (c) Pimlico (chain 5003)

The public endpoint is `https://public.pimlico.io/v2/5003/rpc` (same answers on
`/v2/mantle-sepolia/rpc`). `api.pimlico.io` requires an `apikey`.

- `eth_supportedEntryPoints` = `[0x5FF137D4…2789 (v0.6), 0x0000000071727De2…a032 (v0.7),
  0x433709009B8330FDa32311DF1C2AFA402eD8D009 (v0.9)]`. **EntryPoint v0.8 is not supported**:
  `eth_estimateUserOperationGas` against v0.8 returns `-32604 "entryPoint not supported"`.
- On v0.9, an op with `factory = 0x7702` and `eip7702Auth` passes the schema, and simulation
  reaches account validation. It then reverts `AA23 0xd663742a` (Calibur `NotEntryPoint()`),
  because Calibur v1.1.0 accepts only EP v0.8 unless `updateEntryPoint` is called.
- So Pimlico is not a route for the designed EP v0.8. Given §3.2, Pimlico's hosted v0.7+ bundling
  suggests it is not Alto safe mode (not verified).

## 5. Mantle fee model (relayer transactions and `handleOps`)

Mantle Sepolia runs the Arsia upgrade. GasPriceOracle `0x420000000000000000000000000000000000000F`
reports `version()` = `1.1.0` and `isArsia()` = true. Receipts carry `l1Fee`, `l1GasUsed`,
`l1GasPrice`, `l1BaseFeeScalar`, `l1BlobBaseFee`, `l1BlobBaseFeeScalar`, `tokenRatio`,
`operatorFeeScalar`, `operatorFeeConstant` and `daFootprintGasScalar`.

**What the sender pays.** This was verified to the wei against the sender's balance delta for
every transaction below:

```
paid = gasUsed × effectiveGasPrice + l1Fee + gasUsed × operatorFeeScalar × 100 + operatorFeeConstant
```

- The operator fee matches `GasPriceOracle.getOperatorFee(gasUsed)`. Measured values:
  `operatorFeeScalar = 1e8` and `operatorFeeConstant = 0`, so the operator fee is **10 gwei per
  gas**. That is +20 % on the 50 gwei base fee, which is the floor seen all day.
- `l1Fee ≈ tokenRatio × l1GasUsed × (16 × l1BaseFeeScalar × l1BaseFee + l1BlobBaseFeeScalar ×
  l1BlobBaseFee) / 16e6`. This is the Ecotone/Fjord formula, MNT-denominated through `tokenRatio`
  (about 4 578). It reproduces the receipts to within 0.01 %. Measured `l1Fee` is 5.7e7–1.3e8 wei,
  which is negligible: about 1e-10 MNT.
- The oracle's `getL1Fee` / `getL1FeeUpperBound` are ETH-denominated. Multiplied by
  `tokenRatio`, `getL1FeeUpperBound(2135)` gives 375 904 158 wei, a valid bound (3.8× the actual
  fee for that 2 135-byte transaction).

| Tx | Kind | gasUsed | effectiveGasPrice | L2 fee (MNT) | l1Fee (wei) | operator fee (MNT) | sender paid (MNT) | EP refund `actualGasCost` (MNT) | executor net (MNT) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0x67a69667 | relayer type-4 grant | 438 589 | 50.01 gwei | 0.021933836 | 100 033 878 | 0.004385890 | 0.026319726 | — | — |
| 0xea6530cd | relayer session call | 116 108 | 50.01 gwei | 0.005806561 | 56 671 062 | 0.001161080 | 0.006967641 | — | — |
| 0x8f778f38 | handleOps, session | 166 418 | 50.0001 gwei | 0.008320917 | 96 691 938 | 0.001664180 | 0.009985097 | 0.008681117 | −0.001303979 |
| 0x99e841ba | handleOps, root init type-4 | 476 504 | 50.0001 gwei | 0.023825248 | 131 644 968 | 0.004765040 | 0.028590288 | 0.024242698 | −0.004347589 |
| 0xb1aa2ba1 | handleOps, session | 149 330 | 50.0001 gwei | 0.007466515 | 90 877 878 | 0.001493300 | 0.008959815 | 0.007826816 | −0.001132999 |

**Worst-case reservation for the sponsor** (DESIGN §5.2):

- **Relayer:**
  `gasLimit × (maxFeePerGas + operatorFeeScalar × 100) + operatorFeeConstant + tokenRatio ×
  GasPriceOracle.getL1FeeUpperBound(txSize)`. Read the scalars from the oracle at reservation
  time, because they are system-configured.
- **4337:** the paymaster deposit is charged exactly `actualGasCost`. The deposit went from 0.3 to
  0.2592493684989 MNT, which equals the sum of the three refunds. DESIGN's EP prefund bound
  therefore holds for the sponsor. The operator fee and the L1 fee land on the **bundler**. With
  Alto `--chain-type mantle`, the executor lost about 13–15 % of each bundle's cost, so bundler
  infrastructure must price the operator fee into PVG or run at a loss.

## 6. Reproduce

All scripts read keys from the environment only.

```bash
# contracts (broadcasting key = keystore account; PMSIGNER_ADDRESS in env)
forge script script/spike/SpikeDeploy.s.sol --rpc-url "$MANTLE_SEPOLIA_RPC_URL" --account … --sender … --broadcast --slow
# (a) ROOT_PRIVATE_KEY, SESSION_PRIVATE_KEY, SPIKE_CALIBUR, SPIKE_HOOK, SPIKE_TARGET in env
forge script script/spike/SpikeRelayer.s.sol --sig "grant()" … --broadcast
forge script script/spike/SpikeRelayer.s.sol --sig "sessionCall(uint256)" 1 … --broadcast
# (b) BUNDLER_PRIVATE_KEY in env; ALTO_PATCH=0 reproduces the stock failure
e2e/bundler/sepolia.sh up
e2e/spike/userop.sh session <tag>                 # session UserOp, no eip7702Auth
e2e/spike/userop.sh session <tag> with-auth       # rejected (§3.4)
e2e/spike/userop.sh root-init                     # INITROOT_PRIVATE_KEY: fresh EOA
e2e/bundler/sepolia.sh down
```

`userop.sh` signs paymaster data in SpikePaymaster's layout (`validUntil ‖ validAfter` packed
into 12 bytes). The deployed VerifyingPaymaster expects `abi.encode(validUntil, validAfter)`
(64 bytes), so `userop.sh` works only with SpikePaymaster; for the deployed paymaster use
§10.2.

## 7. MNT spent

| Spent on | MNT |
| --- | ---: |
| Deployer fees: deploys, the two relayer txs, one transfer | 0.588166536 |
| Bundler executor: Alto's simulation contracts (about 1.0569) and the net bundle losses | 1.060648654 |
| Paymaster deposit consumed | 0.040750632 |
| **Total consumed** | **1.689565822** |

Still parked: the bundler executor `0xc0cC…D451` holds 0.939351346 MNT, and the paymaster deposit
holds 0.259249368 MNT (withdrawable by the deployer as owner).

Release 0.1.2 spent another 0.011963848 MNT (§10.5).

## 8. What later work should take from this

- **Bundler infrastructure.** For EP v0.8 safe mode, use the patched Alto 0.0.21 or an upstream
  fix (§9). The tracing node must support `debug_traceCall` with JS tracers. A geth-family node
  avoids the anvil OP-020 artifact. Price Mantle's operator fee into PVG (release 0.1.2 decided
  to accept the shortfall instead, §10.4). Pimlico public offers no v0.8.
- **SDK `BundlerExecutor`:**
  - never attach `eip7702Auth` to session UserOps; only root init ops may carry it;
  - build `executeUserOp.selector ‖ abi.encode(BatchedCall)` calldata;
  - sign paymaster data over the 2-byte `0x7702` initCode;
  - leave verification-gas headroom.
- **Paymaster.** Unstaked is enough when validation reads only immutables and returns an empty
  context. The delegate check through `EXTCODECOPY` of the sender is accepted by strict
  validation.
- **Sponsor.** Use the relayer reservation formula in §5. The L1 fee is negligible, and the
  operator fee is not.

## 9. Upstream bug report (draft, not filed)

> **Safe mode rejects every EntryPoint v0.7/v0.8 UserOp: `Encoded error signature "0x99410554"
> not found on ABI`**
>
> Version: `@pimlico/alto` 0.0.21. `rpc/validation/` is unchanged in
> `0.0.0-main.20261013T112709`.
>
> Steps: run with `--safe-mode true` against EntryPoint v0.8, with an RPC that supports
> `debug_traceCall` with JS tracers. Send any valid v0.8 UserOp to `eth_sendUserOperation`.
>
> Actual: `Encoded error signature "0x99410554" not found on ABI` (viem
> `AbiErrorSignatureNotFoundError`).
>
> Cause: `SafeValidator.getValidationResultWithTracerV07` (`esm/rpc/validation/SafeValidator.js`)
> treats `tracerResult.calls.slice(-1)[0]` as the result. It decodes that with
> `decodeErrorResult({ abi: pimlicoSimulationsAbi })` and expects an error named
> `ValidationResult`. `PimlicoSimulations.simulateValidation` *returns* the `ValidationResult`,
> and `pimlicoSimulationsAbi` has no error entries. The tracer does not record the top-level
> frame, so the last exit is `EntryPoint.delegateAndRevert`'s revert,
> `DelegateAndRevert(bool,bytes)` (`0x99410554`), which wraps the encoded result. Decoding
> therefore always throws, and safe mode can never accept a v0.7+/v0.8 UserOp.
>
> Fix (verified on Mantle Sepolia, chain 5003): decode `DelegateAndRevert(success, ret)`. If
> `success`, decode `ret` with `decodeFunctionResult(pimlicoSimulationsAbi, "simulateValidation")`.
> Otherwise decode `ret` as `FailedOp` / `FailedOpWithRevert` and keep the `AAxx` reason for the
> existing error mapping. A one-hunk patch is attached.

## 10. Settled bundler setup (release 0.1.2)

Measured 2026-10-18. **Decision: self-hosted Alto `@pimlico/alto@0.0.21` in safe mode against
EntryPoint v0.8, with the one-hunk safe-validator patch (§3.2).** Two configurations share the
same pinned install: a fork harness that test suites start themselves (§10.1), and a stack
against the real chain (§10.2).

Premises re-checked on 2026-10-18:

- **Pimlico.** `eth_supportedEntryPoints` on `https://public.pimlico.io/v2/5003/rpc` still answers
  `["0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789","0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "0x433709009B8330FDa32311DF1C2AFA402eD8D009"]` (v0.6, v0.7, v0.9). No EntryPoint v0.8, so
  Pimlico stays out (§4).
- **Newer Alto.** npm `latest` is still `0.0.21` and `main` is still
  `0.0.0-main.20261013T112709`. Upstream `main` (`482c08bb`, 2026-10-13) still decodes the last
  traced exit with `decodeErrorResult({ abi: pimlicoSimulationsAbi })` in
  `src/rpc/validation/SafeValidator.ts` `getValidationResultWithTracerV07`; that file last
  changed on 2025-12-31 (`0b9b22ff`, "feat/v9"). No issue or PR fixes it (a GitHub search for
  `0x99410554` finds only #756 and #761, both about other decoding paths). The patch stays.
- **Trace proxy on a fork.** Not needed. On an anvil fork, Alto points at anvil for everything,
  and anvil serves `debug_traceCall` with Alto's JS tracer itself. The fork smoke test's
  validation was traced there (Alto logged its `tracerResult`). The proxy is still needed
  against the real chain, whose public RPC rejects `debug_*`.

**Install.** `e2e/bundler/alto/package.json` pins `@pimlico/alto@0.0.21`, and
`e2e/bundler/alto/package-lock.json` pins its whole dependency tree (viem 2.57.7, the version the
patch was written against). Both setups install it with `npm ci --ignore-scripts` outside the pnpm
workspace and then apply the patch with `patch -p1`. The harness caches the install in the OS
temp directory under a hash of the lockfile and the patch; `sepolia.sh` caches it in its run
directory. This was chosen over a root devDependency with a pnpm patch for three reasons. Alto
brings 261 packages (about 360 MB) that only the bundler suites use. pnpm 11 rejects two of its
build scripts (`msgpackr-extract`, `protobufjs`) unless `pnpm-workspace.yaml` lists them. And the
npm lockfile pins the tree just as exactly. The cost is one `npm ci` per fresh machine; on a CI
runner, every run is fresh. Measured locally: about 20 s with a warm npm cache.

**Alto flags (both setups):** `--entrypoints 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
--safe-mode true --chain-type mantle --refilling-wallets false --deploy-simulations-contract true
--log-level info --public-client-log-level warn`, plus `--rpc-url` and `--port`. The harness sets
`--block-time 1000`; `sepolia.sh` sets `--block-time 2000`. The executor and utility key go in
through `ALTO_EXECUTOR_PRIVATE_KEYS` / `ALTO_UTILITY_PRIVATE_KEY`, never on a command line. All
other options keep Alto's defaults (`--min-entity-stake 1`, `--min-entity-unstake-delay 1`,
`--eip-7702-support true`). Alto's own RPC timeout is a fixed 10 s.

### 10.1 Fork harness (`e2e/bundler/harness.ts`)

The fork harness needs Node, npm, `patch` and anvil, and no secrets. These are exactly the tools
CI's `typescript` job has.

- `startBundlerStack(upstreamRpcUrl)` starts anvil forking the upstream head (`--hardfork prague`)
  and the patched Alto on it. The executor is a fresh random key funded with 100 MNT by
  `anvil_setBalance`; its key stays inside the harness. The call returns `{ rpcUrl, client,
  bundler: { url, entryPoint, executor, logs }, stop }`.
- `startFork(upstreamRpcUrl)` and `startAlto({ rpcUrl, executorKey })` are the two halves, for a
  suite that already has its own fork. `installAlto()` returns the CLI path.
- `setPaymasterSigner(client, paymaster, signer)` works on a fork only. It swaps the deployed
  VerifyingPaymaster's `verifyingSigner` immutable in the runtime code (two occurrences) for an
  address whose key the test holds, and asserts the result through `verifyingSigner()`. The
  address, the logic and the EntryPoint deposit stay the same.
- Ports are random free ports. Every wait is bounded: anvil 60 s, the install 300 s, Alto 120 s
  each, a bundler request 60 s, the receipt 120 s. `stop()` sends SIGTERM, then SIGKILL after
  10 s. Every child is also killed when the test process exits.
- The verification-gas headroom stays at 150 % of Alto's estimate, because the tracing node is
  still anvil (§3.5).

`e2e/bundler/userop.ts` (`sendSponsoredUserOp`) builds an op for a Calibur account, sizes it with
`eth_estimateUserOperationGas` and signs the paymaster data directly with the signer's key. The
data is `abi.encode(validUntil, validAfter) ‖ 65-byte signature` over `getHash`, which covers the
2-byte `0x7702` initCode the bundler packs. The function then root-signs the op, sends it and
waits for the receipt. It needs no sponsor service.

Smoke suite `e2e/bundler/bundler.test.ts`: the root init UserOp of a fresh EOA, with
`eip7702Auth`, whose batch mints 1 mUSD. The deployed paymaster sponsors it. The suite asserts the
op succeeded, the paymaster is the deployed one, Alto traced the validation, the bundle is a
type-4 transaction from the executor, the account's code is `0xef0100 ‖ CaliburEntry`, and the
mint landed. Run it with:

```bash
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz pnpm exec vitest run e2e/bundler
```

Measured locally: 1 passed, 0 skipped, in 14–20 s with the install cached.

### 10.2 Stack against Mantle Sepolia (`e2e/bundler/sepolia.sh`)

The chain stack chains anvil (the tracing node) to `trace-proxy.mjs` to the same patched Alto.
`debug_*` requests go to anvil; everything else goes to the real RPC. Before this release, the
proxy re-forked anvil at the head before *every* trace. A fresh fork fetches every account and
slot it touches lazily over the public RPC. On 2026-10-18 the public RPC answered
`eth_blockNumber` in 0.4–12.7 s, so a cold trace took longer than Alto's fixed 10 s timeout and
every send failed with `The request took too long to respond`. The proxy now re-forks only when
a raw transaction (a bundle) has gone upstream since the last fork, or when the fork is older
than `FORK_MAX_AGE_S` (default 120 s). Otherwise it reuses the warm fork. `land-sepolia.ts`
retries a send that timed out this way, up to three attempts. The landing below needed one
retry.

```bash
# executor key: BUNDLER_PRIVATE_KEY (env only); the paymaster's verifyingSigner key: PAYMASTER_SIGNER_PRIVATE_KEY
e2e/bundler/sepolia.sh up            # Alto on http://127.0.0.1:4337, logs in $BUNDLER_RUN_DIR
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz node e2e/bundler/land-sepolia.ts
e2e/bundler/sepolia.sh down
```

`land-sepolia.ts` runs under plain Node (type stripping). It generates a fresh root key in memory
and sends that account's init UserOp, the same op as the smoke test. The sponsor is the deployed
VerifyingPaymaster `0x301813D34cBebdf90FEBf32929CfB323c9eF3B4C`, signed by its `verifyingSigner`
`0x7223c837518A51eF0f6c40d67B539D1Aa29a67E9`. The script prints the result and the bundle's
fee split as JSON.

### 10.3 Landed on Mantle Sepolia

| UserOp | handleOps tx | Facts |
| --- | --- | --- |
| **Root init UserOp with `eip7702Auth`** for fresh EOA `0x128b153ec75cF21aFA77Ea6b39222Ff3786819D2`, batch `MockUSD.mint(account, 1e6)`, **sponsored by the deployed VerifyingPaymaster** | [0x41c5245f…784a](https://sepolia.mantlescan.xyz/tx/0x41c5245faefb945b9885d0adf91b4ff207478c62245524c886eb0be5b211784a) | userOpHash `0x882cefcef984c630e0a5b4fdc4fd6672eb24be08608bb775afc566bceab79fde`, success, block 45 396 785. **Type `0x4`** bundle from the executor `0xc0cC…D451` to EP v0.8, with one authorization. Afterwards the account's code is `0xef0100 ‖ 0x000000005c84F8Fd50b21CAC312528A64437030e` |

This is the first op the deployed paymaster has sponsored through the strict bundler on chain.
Its delegate check (`EXTCODEHASH` of the sender) passed safe-mode validation. Its hash covered
the 2-byte `0x7702` initCode. The op's gas: callGasLimit 60 267, verificationGasLimit 88 956
(150 % of the estimate), preVerificationGas 82 454, paymasterVerificationGasLimit 21 219,
maxFeePerGas 60.0001 gwei, actualGasUsed 191 700. A session UserOp through the deployed
paymaster and hook is left to the bundler-path E2E suite.

### 10.4 Operator-fee PVG shortfall: accepted

These numbers come from the bundle above. The executor's balance delta matches the formula in §5
to the wei.

| gasUsed | effectiveGasPrice | L2 fee (MNT) | l1Fee (wei) | operator fee (MNT) | executor paid (MNT) | EP refund `actualGasCost` (MNT) | executor net (MNT) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 183 045 | 55.360145566 gwei | 0.010133398 | 113 821 536 | 0.001830450 | 0.011963848 | 0.009585019 | −0.002378829 |

The executor lost 19.9 % of what it paid. This splits into three parts:

- the operator fee, 0.001830450 MNT (10 gwei/gas);
- a priority fee above the 50 gwei base fee, 183 045 × 5.36 gwei = 0.000981148 MNT. Alto bid
  `maxPriorityFeePerGas = maxFeePerGas`. The bundles in §5 paid about 0.0001 gwei;
- offset by the op's charged-but-unused gas and PVG margin, +0.000432751 MNT.

Closing the shortfall would take about 47 600 more PVG at the op's 50.0001 gwei, which means
raising PVG to about 1.58× Alto's estimate.

**Decision: accept the shortfall; do not compensate in PVG for 0.1.2.** In this setup one
operator funds both the bundler executor and the paymaster deposit. Raising PVG would only move
the same MNT from the executor to the deposit, and it would add a PVG formula that the paymaster
signer (ERC-7677) must also price. Measured cost: 0.0011–0.0043 MNT per bundle (§5 and above).
The executor holds 0.936972517 MNT, which covers several hundred bundles. Revisit this before
a mainnet or third-party bundler. On an anvil fork none of this is visible: anvil charges no
Mantle operator fee or L1 fee.

### 10.5 MNT spent (release 0.1.2)

| Spent on | MNT |
| --- | ---: |
| Bundler executor: net loss on the bundle in §10.3 | 0.002378829 |
| Paymaster deposit consumed (`actualGasCost`) | 0.009585019 |
| **Total consumed** | **0.011963848** |

The failed sends were rejected during validation and broadcast nothing. Over the whole run the
executor nonce went from 7 to 8. The simulation contracts already existed (§3.1), so nothing was
deployed. Still parked: the executor `0xc0cC…D451` holds 0.936972517 MNT, and the deployed
paymaster's deposit holds 4.990414981 MNT.
