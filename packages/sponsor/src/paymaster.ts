import { setTimeout as sleep } from "node:timers/promises";
import {
  decodeUserOpCallData,
  type PaymasterDataResult,
  type PaymasterMethod,
  type PaymasterRequest,
  type PaymasterStubDataResult,
  type PaymasterUserOperation,
  PM_GET_PAYMASTER_STUB_DATA_METHOD,
  parsePaymasterRequest,
  paymasterRequestDigest,
  recoverPaymasterRequestSigner,
  SponsorRejectCode,
} from "@mantle-aa/sdk";
import {
  type Address,
  type Client,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import type { LocalAccount } from "viem/accounts";
import { getBlock, getBlockNumber, getLogs, readContract } from "viem/actions";
import {
  checkAccount,
  checkAuthorization,
  checkLane,
  checkRequestSigner,
  checkValidity,
  reject,
} from "./auth.js";
import type { SponsorConfig } from "./config.js";
import { userOpFeeBound } from "./fees.js";
import { checkAllowlist, checkBudget, classify, estimateOrReject } from "./policy.js";
import type { SponsorContext } from "./server.js";
import { type BudgetClass, dayOf, type LedgerEntry, type SponsorStore } from "./store.js";

/**
 * Gas the sponsor gives the paymaster's validation: `EXTCODEHASH` of the sender, the hash over the
 * UserOp and one `ecrecover`. Measured on a Mantle Sepolia fork (`paymaster.fork.test.ts`):
 * `eth_estimateGas` of the validation from the EntryPoint is about 38 900 for a session and a root
 * init UserOp, including the 21 000 base and the calldata, so under 18 000 itself; the rest is
 * headroom for long calldata. Unused verification gas is not charged.
 */
export const PAYMASTER_VERIFICATION_GAS = 60_000n;
/** The paymaster returns an empty context, so the EntryPoint never calls `postOp`. */
export const PAYMASTER_POST_OP_GAS = 0n;

/**
 * The stub's signature: well-formed (65 bytes, low s, v = 28), so the deployed paymaster's
 * `ECDSA.recover` returns an address instead of reverting, and validation costs what a real one
 * does; it recovers to no sponsor key, so it never validates (`SIG_VALIDATION_FAILED`, which
 * gas estimation tolerates and `handleOps` refuses with `AA34`). Signed by
 * keccak256("mantle-aa paymaster stub signature") over keccak256("stub").
 */
export const STUB_SIGNATURE: Hex =
  "0x76e532a617d6ae091a7060eb954b7755b55a34ab5aa086df44522a5543c674aa278a1949ffbd40a86467e7eb5c06a7504e3029bf2ce84ba37b3e85d4e2666b4e1c";

/** Blocks per `eth_getLogs`: Mantle Sepolia's public RPC refuses spans over 10 000 blocks. */
export const LOG_BLOCK_RANGE = 5_000n;

const isRoot = (keyHash: Hex) => BigInt(keyHash) === 0n;
const ZERO = { gas: 0n, fee: 0n };
const clock = () => Math.floor(Date.now() / 1000);

const executeUserOpAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function executeUserOp(PackedUserOperation userOp, bytes32 userOpHash)",
]);
const verifyingPaymasterAbi = parseAbi(["function verifyingSigner() view returns (address)"]);
const userOperationEvent = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

/** A paymaster request whose envelope, lane, initCode and request signature have been checked. */
export interface DecodedUserOp {
  method: PaymasterMethod;
  request: PaymasterRequest;
  /** The authenticated request digest: the stable identity of this request. */
  digest: Hex;
  sender: Address;
  /** The authenticated key: 0 for the root. */
  keyHash: Hex;
  lane: bigint;
  batchedCall: ReturnType<typeof decodeUserOpCallData>;
}

/** A UserOp the sponsor has authenticated, decoded, simulated and decided to sponsor. */
export interface PaymasterDecision extends DecodedUserOp {
  budgetClass: BudgetClass;
  /** The UTC day whose counters the request is checked (and is to be charged) against. */
  day: number;
  /** The UserOp's gas limits, the paymaster's included. */
  gas: bigint;
  /** The EntryPoint's required prefund: the most the deposit can be charged. */
  maxFee: bigint;
}

/** Issues sponsorships and keeps their reservations: `PaymasterLedger`. */
export interface PaymasterIssuer {
  /** The result issued for a request digest before, or undefined. */
  find(digest: Hex): PaymasterDataResult | undefined;
  sponsor(decision: PaymasterDecision): Promise<PaymasterDataResult>;
  /** Settles or releases the open sponsorships (only `account`'s, if given) the chain has ended. */
  reconcile(account?: Address): Promise<void>;
}

/** The UserOp with the sponsor's paymaster fields. */
const sponsored = (op: PaymasterUserOperation, paymaster: Address, paymasterData: Hex = "0x") => ({
  ...op,
  paymaster,
  paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
  paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS,
  paymasterData,
  signature: "0x" as Hex,
});

/**
 * `VerifyingPaymaster.getHash(userOp, validUntil, validAfter)` computed offline
 * (contracts/src/VerifyingPaymaster.sol, DESIGN §4.3): over the UserOp as the bundler packs it,
 * the sponsor's paymaster gas limits, the chain, the paymaster, the EntryPoint and the validity.
 */
export function paymasterHash(
  op: PaymasterUserOperation,
  context: { chainId: number; paymaster: Address; entryPoint: Address },
  validUntil: number,
  validAfter: number,
): Hex {
  const p = toPackedUserOperation(sponsored(op, context.paymaster));
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint48" },
        { type: "uint48" },
      ],
      [
        p.sender,
        p.nonce,
        keccak256(p.initCode),
        keccak256(p.callData),
        p.accountGasLimits,
        (PAYMASTER_VERIFICATION_GAS << 128n) | PAYMASTER_POST_OP_GAS,
        p.preVerificationGas,
        p.gasFees,
        BigInt(context.chainId),
        context.paymaster,
        context.entryPoint,
        validUntil,
        validAfter,
      ],
    ),
  );
}

/** `abi.encode(uint48 validUntil, uint48 validAfter) ‖ signature`. */
const paymasterData = (validUntil: number, validAfter: number, signature: Hex) =>
  concat([
    encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, validAfter]),
    signature,
  ]);

/**
 * The initCode a key may carry (owner decision; ERC-7562 STO-021/022, docs/infra.md §3.4–§3.5):
 * the root's init carries `eip7702Auth` and exactly the 2-byte `0x7702` the bundler packs; every
 * other UserOp, and every session UserOp, carries neither.
 */
function checkInitCode(op: PaymasterUserOperation, keyHash: Hex): void {
  const initCode = op.factory ? concat([op.factory, op.factoryData ?? "0x"]).toLowerCase() : "0x";
  if (op.authorization) {
    if (!isRoot(keyHash)) {
      reject(SponsorRejectCode.AUTHORIZATION_INVALID, "a session UserOp never carries eip7702Auth");
    }
    if (initCode !== "0x7702") {
      reject(
        SponsorRejectCode.INIT_CODE_INVALID,
        `the root's init UserOp has initCode 0x7702 (factory 0x7702, no factoryData), not ${initCode}`,
      );
    }
  } else if (initCode !== "0x") {
    reject(
      SponsorRejectCode.INIT_CODE_INVALID,
      `initCode must be empty without eip7702Auth, not ${initCode}`,
    );
  }
}

/**
 * Checks everything that needs no chain state: chain, EntryPoint and sponsor, the validity window
 * at `now` (skipped without one: a retry finds an issued result whatever its validity), the
 * `executeUserOp` calldata, `(sender, keyHash, nonce lane)` agreement on the EntryPoint nonce key,
 * the initCode / `eip7702Auth` rule, the request signature and the authorization.
 */
export async function decodeUserOp(
  method: PaymasterMethod,
  request: PaymasterRequest,
  config: SponsorConfig,
  now?: number,
): Promise<DecodedUserOp> {
  const { userOp: op, auth } = request;
  if (request.chainId !== config.chainId) {
    reject(
      SponsorRejectCode.WRONG_CHAIN,
      `request chain ${request.chainId} is not ${config.chainId}`,
    );
  }
  if (request.entryPoint !== config.addresses.entryPoint) {
    reject(SponsorRejectCode.WRONG_DOMAIN, `request names EntryPoint ${request.entryPoint}`);
  }
  if (auth.sponsor !== config.relayer) {
    reject(SponsorRejectCode.WRONG_DOMAIN, `request names sponsor ${auth.sponsor}`);
  }
  if (now !== undefined) checkValidity(auth, config, now);

  let batchedCall: DecodedUserOp["batchedCall"];
  try {
    batchedCall = decodeUserOpCallData(op.callData);
  } catch (error) {
    return reject(SponsorRejectCode.INVALID_PARAMS, (error as Error).message);
  }
  const keyHash = auth.keyHash;
  const lane = op.nonce >> 64n;
  checkLane(keyHash, lane);
  checkInitCode(op, keyHash);

  const digest = paymasterRequestDigest(method, request);
  checkRequestSigner(
    await recoverPaymasterRequestSigner(method, request, digest).catch(() => zeroAddress),
    op.sender,
    keyHash,
  );
  await checkAuthorization(config, op.sender, keyHash, op.authorization);
  return { method, request, digest, sender: op.sender, keyHash, lane, batchedCall };
}

/**
 * The relayer path's policy for a UserOp: allowlist → the account and key on chain → budget class
 * → the sponsor's own simulation (`eth_estimateGas` of Calibur's `executeUserOp` as the EntryPoint
 * calls it, under the authenticated key, with the authorization applied for the root's init) →
 * the 4337 fee bound (DESIGN §5.2) → caps against today's persisted usage.
 */
async function decide(
  ctx: SponsorContext,
  decoded: DecodedUserOp,
  now: number,
): Promise<PaymasterDecision> {
  const { config, client, store } = ctx;
  const { sender, keyHash, batchedCall } = decoded;
  const op = decoded.request.userOp;
  checkAllowlist(config, sender);
  await checkAccount(client, config, { sender, keyHash, authorization: op.authorization });
  const budgetClass = classify({ keyHash, batchedCall }, sender, config);
  // Calibur's executeUserOp reads only the key of `abi.encode(keyHash, sig, hookData)`, but refuses
  // a sig shorter than 64 bytes.
  const signature = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
    [keyHash, `0x${"00".repeat(65)}`, "0x"],
  );
  await estimateOrReject(client, {
    account: config.addresses.entryPoint,
    to: sender,
    data: encodeFunctionData({
      abi: executeUserOpAbi,
      functionName: "executeUserOp",
      args: [toPackedUserOperation({ ...op, signature }), zeroHash],
    }),
    ...(op.authorization ? { authorizationList: [op.authorization] } : {}),
  });
  const { gas, maxFee } = userOpFeeBound({
    ...op,
    paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
    paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS,
  });
  const day = dayOf(now);
  checkBudget(config, store.usage(day, sender), { budgetClass, gas, maxFee });
  return { ...decoded, budgetClass, day, gas, maxFee };
}

/**
 * Before the busy check: the bundler tells the client of an inclusion before the reconcile loop
 * sees it, so the sender's open sponsorship is reconciled once now. Only one the chain can still
 * include keeps the account busy; a failed read leaves it open, and so the account busy.
 */
async function reconcileSender(
  ctx: SponsorContext & { paymaster?: PaymasterIssuer | undefined },
  sender: Address,
): Promise<void> {
  if (!ctx.paymaster || !ctx.store.openEntry(sender)?.paymaster) return;
  await ctx.paymaster.reconcile(sender).catch(() => undefined);
}

function parse(params: unknown): PaymasterRequest {
  try {
    return parsePaymasterRequest(params);
  } catch (error) {
    return reject(SponsorRejectCode.INVALID_PARAMS, (error as Error).message);
  }
}

/**
 * `pm_getPaymasterStubData` / `pm_getPaymasterData` end to end (ERC-7677). Both authenticate and
 * decide as the relayer path does. The stub reserves nothing and carries a signature that never
 * validates (`isFinal: false`). The data first returns the recorded result if its request digest
 * was issued before (whatever its validity now, so no retry extends it), else signs and reserves
 * through the issuer. Throws `SponsorRejection`.
 */
export async function sponsorUserOp(
  ctx: SponsorContext & { paymaster?: PaymasterIssuer | undefined },
  method: PaymasterMethod,
  params: unknown,
): Promise<PaymasterStubDataResult | PaymasterDataResult> {
  const request = parse(params);
  const unavailable = () =>
    reject(SponsorRejectCode.SUBMISSION_UNAVAILABLE, "this sponsor has no paymaster signer");
  if (method === PM_GET_PAYMASTER_STUB_DATA_METHOD) {
    const now = (ctx.now ?? clock)();
    const decoded = await decodeUserOp(method, request, ctx.config, now);
    await reconcileSender(ctx, decoded.sender);
    if (ctx.store.openEntry(decoded.sender)) {
      reject(SponsorRejectCode.SPONSOR_BUSY, `${decoded.sender} has a request in flight`);
    }
    await decide(ctx, decoded, now);
    if (!ctx.paymaster) return unavailable();
    return {
      paymaster: ctx.config.addresses.verifyingPaymaster,
      paymasterData: paymasterData(request.auth.validUntil, 0, STUB_SIGNATURE),
      paymasterVerificationGasLimit: toHex(PAYMASTER_VERIFICATION_GAS),
      paymasterPostOpGasLimit: toHex(PAYMASTER_POST_OP_GAS),
      isFinal: false,
    };
  }
  const decoded = await decodeUserOp(method, request, ctx.config);
  const issued = ctx.paymaster?.find(decoded.digest);
  if (issued) return issued;
  const now = (ctx.now ?? clock)();
  checkValidity(request.auth, ctx.config, now);
  await reconcileSender(ctx, decoded.sender);
  const decision = await decide(ctx, decoded, now);
  if (!ctx.paymaster) return unavailable();
  return ctx.paymaster.sponsor(decision);
}

export interface PaymasterLedgerOptions {
  config: SponsorConfig;
  client: Client;
  store: SponsorStore;
  /** The VerifyingPaymaster's `verifyingSigner`. */
  signer: LocalAccount;
  /** How often open sponsorships are reconciled with the chain; default 1000 ms. */
  pollIntervalMs?: number;
}

/**
 * The paymaster's reservations (DESIGN §5.2), in the relayer ledger's store, caps and
 * one-request-per-account rule: a reservation starts when the signature is issued, valid until the
 * request's `validUntil` (a retry returns the same result and never extends it or reserves again);
 * it is settled with the `actualGasCost` of the UserOp's `UserOperationEvent` (a failed UserOp is
 * charged too), or released once a block past `validUntil` exists and every block since signing
 * has been searched without finding one.
 */
export class PaymasterLedger implements PaymasterIssuer {
  readonly signer: Address;
  readonly #config: SponsorConfig;
  readonly #client: Client;
  readonly #store: SponsorStore;
  readonly #account: LocalAccount;
  readonly #pollIntervalMs: number;
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;

  constructor(options: PaymasterLedgerOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#store = options.store;
    this.#account = options.signer;
    this.signer = options.signer.address;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /**
   * Checks the key is the paymaster's `verifyingSigner` (every signature would fail `AA34`
   * otherwise), reconciles what a previous process left open, then keeps reconciling until `close`.
   */
  async start(): Promise<void> {
    const onChain = await readContract(this.#client, {
      address: this.#config.addresses.verifyingPaymaster,
      abi: verifyingPaymasterAbi,
      functionName: "verifyingSigner",
    });
    if (onChain !== this.signer) {
      throw new Error(`the paymaster's verifyingSigner is ${onChain}, not ${this.signer}`);
    }
    await this.reconcile();
    this.#loop = this.#run();
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await this.#loop;
  }

  find(digest: Hex): PaymasterDataResult | undefined {
    return this.#store.entry(digest)?.paymaster?.result;
  }

  /**
   * Signs the sponsorship and, in one SQLite transaction, returns the result already issued for the
   * request digest or the paymaster hash, else rejects `SPONSOR_BUSY` or a cap, else reserves the
   * worst case and records the result. A signature that loses this race is never returned.
   */
  async sponsor(d: PaymasterDecision): Promise<PaymasterDataResult> {
    const { chainId, addresses } = this.#config;
    const op = d.request.userOp;
    const validUntil = d.request.auth.validUntil;
    const validAfter = 0;
    const context = {
      chainId,
      paymaster: addresses.verifyingPaymaster,
      entryPoint: addresses.entryPoint,
    };
    const hash = paymasterHash(op, context, validUntil, validAfter);
    const signature = await this.#account.signMessage({ message: { raw: hash } });
    const result: PaymasterDataResult = {
      paymaster: context.paymaster,
      paymasterData: paymasterData(validUntil, validAfter, signature),
      paymasterVerificationGasLimit: toHex(PAYMASTER_VERIFICATION_GAS),
      paymasterPostOpGasLimit: toHex(PAYMASTER_POST_OP_GAS),
    };
    const userOpHash = getUserOperationHash({
      chainId,
      entryPointAddress: context.entryPoint,
      entryPointVersion: "0.8",
      userOperation: sponsored(op, context.paymaster, result.paymasterData),
    });
    // The UserOp can only be included in a later block than the chain's head now.
    const head = await getBlockNumber(this.#client, { cacheTime: 0 });
    return this.#store.transaction(() => {
      const known = this.#store.entry(d.digest) ?? this.#store.entryByBatch(hash);
      if (known?.paymaster) return known.paymaster.result;
      if (this.#store.openEntry(d.sender)) {
        reject(SponsorRejectCode.SPONSOR_BUSY, `${d.sender} has a request in flight`);
      }
      checkBudget(this.#config, this.#store.usage(d.day, d.sender), d);
      const reserved = { gas: d.gas, fee: d.maxFee };
      this.#store.insertEntry({
        digest: d.digest,
        batchDigest: hash,
        account: d.sender,
        budgetClass: d.budgetClass,
        day: d.day,
        state: "submitted",
        reserved,
        paymaster: { userOpHash, validUntil, scannedTo: Number(head), result },
      });
      this.#store.add(d.day, d.sender, d.budgetClass, reserved);
      return result;
    });
  }

  /**
   * One pass over the open sponsorships: search the blocks not searched yet for each one's
   * `UserOperationEvent` (in `LOG_BLOCK_RANGE` spans, recording progress) and settle it if found;
   * release it if none was found up to a block whose timestamp is past its `validUntil`, after which
   * the EntryPoint can no longer include it (`AA32`). A failed read leaves it open for the next pass.
   * With `account`, only that account's. Passes may overlap (the loop and a request's): settling,
   * releasing and recording progress each re-read the entry in a transaction and act only on an open
   * one, so an entry is closed once and a closed one is never rewritten.
   */
  async reconcile(account?: Address): Promise<void> {
    const open = this.#store
      .entries(["submitted"])
      .filter((e) => e.paymaster && (account === undefined || e.account === account));
    if (!open.length) return;
    const head = await getBlock(this.#client, { blockTag: "latest" });
    for (const entry of open) {
      const record = entry.paymaster as NonNullable<LedgerEntry["paymaster"]>;
      let scannedTo = BigInt(record.scannedTo);
      while (scannedTo < head.number) {
        const toBlock =
          scannedTo + LOG_BLOCK_RANGE < head.number ? scannedTo + LOG_BLOCK_RANGE : head.number;
        const [event] = await getLogs(this.#client, {
          address: this.#config.addresses.entryPoint,
          event: userOperationEvent,
          args: { userOpHash: record.userOpHash },
          fromBlock: scannedTo + 1n,
          toBlock,
        });
        if (event) {
          this.#settle(entry, event);
          break;
        }
        scannedTo = toBlock;
        if (!this.#scanned(entry.digest, scannedTo)) break;
      }
      if (scannedTo === head.number && head.timestamp > BigInt(record.validUntil)) {
        this.#release(entry.digest);
      }
    }
  }

  async #run(): Promise<void> {
    for (;;) {
      try {
        await sleep(this.#pollIntervalMs, undefined, { signal: this.#stop.signal });
      } catch {
        return;
      }
      // Never log the error itself: viem messages carry the RPC URL.
      await this.reconcile().catch(() => console.error("sponsor: paymaster reconciliation failed"));
    }
  }

  /** Records the entry searched up to `block`, if still open; false once another pass closed it. */
  #scanned(digest: Hex, block: bigint): boolean {
    return this.#store.transaction(() => {
      const now = this.#store.entry(digest);
      if (now?.state !== "submitted" || !now.paymaster) return false;
      if (block > BigInt(now.paymaster.scannedTo)) {
        this.#store.updateEntry(digest, {
          paymaster: { ...now.paymaster, scannedTo: Number(block) },
        });
      }
      return true;
    });
  }

  /** Charges what the EntryPoint took from the deposit and releases the rest of the reservation. */
  #settle(
    entry: LedgerEntry,
    event: {
      transactionHash: Hex;
      blockNumber: bigint;
      args: {
        success?: boolean | undefined;
        actualGasCost?: bigint | undefined;
        actualGasUsed?: bigint | undefined;
      };
    },
  ): void {
    const { success = false, actualGasCost = 0n, actualGasUsed = 0n } = event.args;
    const charged = { gas: actualGasUsed, fee: actualGasCost };
    this.#store.transaction(() => {
      const now = this.#store.entry(entry.digest);
      if (now?.state !== "submitted" || !now.paymaster) return;
      this.#store.add(now.day, now.account, now.budgetClass, {
        gas: charged.gas - now.reserved.gas,
        fee: charged.fee - now.reserved.fee,
      });
      this.#store.updateEntry(entry.digest, {
        state: "settled",
        reserved: ZERO,
        charged,
        paymaster: {
          ...now.paymaster,
          scannedTo: Number(event.blockNumber),
          included: {
            transactionHash: event.transactionHash,
            blockNumber: Number(event.blockNumber),
            success,
            actualGasCost: String(actualGasCost),
            actualGasUsed: String(actualGasUsed),
          },
        },
      });
    });
  }

  /** Ends a sponsorship the chain can no longer include: its whole reservation is released. */
  #release(digest: Hex): void {
    this.#store.transaction(() => {
      const now = this.#store.entry(digest);
      if (now?.state !== "submitted") return;
      this.#store.add(now.day, now.account, now.budgetClass, {
        gas: -now.reserved.gas,
        fee: -now.reserved.fee,
      });
      this.#store.updateEntry(digest, { state: "released", reserved: ZERO });
    });
  }
}
