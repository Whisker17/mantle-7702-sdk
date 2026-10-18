import { setTimeout as sleep } from "node:timers/promises";
import {
  type Address,
  type Client,
  encodeAbiParameters,
  getAddress,
  type Hex,
  isAddress,
  isHex,
} from "viem";
import {
  entryPoint08Abi,
  formatUserOperationRequest,
  getUserOperationTypedData,
  type UserOperation,
} from "viem/account-abstraction";
import { readContract } from "viem/actions";
import type { ExecRequest, ExecResult, Executor } from "../account/executor.js";
import { type AddressBook, loadDeployments } from "../deployments.js";
import { ExecutionRevertedError } from "../errors.js";
import {
  encodeUserOpCallData,
  type PaymasterDataResult,
  type PaymasterMethod,
  type PaymasterUserOperation,
  PM_GET_PAYMASTER_DATA_METHOD,
  PM_GET_PAYMASTER_STUB_DATA_METHOD,
  paymasterRequestParams,
  signPaymasterRequest,
} from "../sponsor/paymaster.js";
import { type Endpoint, jsonRpc, readSponsorAddress, sponsorRpcError } from "./http.js";

export interface BundlerExecutorOptions {
  /** Reads the account's EntryPoint nonce. */
  client: Client;
  /** The ERC-4337 bundler's JSON-RPC URL (`eth_*UserOperation*`, `pimlico_getUserOperationGasPrice`). */
  bundlerUrl: string;
  /** The sponsor's JSON-RPC base URL: the ERC-7677 paymaster service (`pm_*`, `GET /health`). */
  sponsorUrl: string;
  /**
   * The sponsor's address, named in every paymaster request. Defaults to the `sponsor` the sponsor
   * URL's `GET /health` reports (read once, with its chain id checked).
   */
  sponsor?: Address;
  /** Defaults to the committed Mantle Sepolia address book. */
  addresses?: AddressBook;
  /** Bounds one `submit`, every HTTP call and the receipt wait included; default 120 s. */
  timeoutMs?: number;
  /** Pause between UserOperation receipt polls; default 1000 ms. */
  pollIntervalMs?: number;
  /**
   * Longest sponsorship window in seconds; default 60. The paymaster signature is good until then,
   * and the sponsor holds the account's one request in flight until then if the op never lands.
   */
  validitySeconds?: number;
  /** Percent of the bundler's verificationGasLimit estimate the op carries; default 150. */
  verificationGasPercent?: bigint;
}

/** Seconds the paymaster requests are valid before the moment they are signed (clock skew). */
const VALID_BEFORE_SECONDS = 30;
/** The bundler RPC's code for a UserOperation whose execution reverts in simulation (ERC-7769). */
const EXECUTION_REVERTED_CODE = -32521;

type Quantity = Hex;
interface GasPrice {
  maxFeePerGas: Quantity;
  maxPriorityFeePerGas: Quantity;
}

/**
 * Submits batches as ERC-4337 EntryPoint v0.8 UserOperations through a bundler, sponsored by the
 * sponsor's ERC-7677 paymaster service (docs/DESIGN.md §4.1, §5.1–5.2, §7.1):
 *
 * 1. callData `executeUserOp.selector ‖ abi.encode(BatchedCall)` (revertOnFailure), nonce
 *    `EntryPoint.getNonce(account, lane)`, fees from the bundler's
 *    `pimlico_getUserOperationGasPrice` (`standard`): the bundler refuses an op priced under its
 *    own quote, and it is the one paying for the bundle.
 * 2. The root's init (a request with an authorization) carries `eip7702Auth` and the 2-byte
 *    initCode `0x7702`; every other op carries neither, and a session request with an
 *    authorization is refused before anything is sent.
 * 3. `pm_getPaymasterStubData`, then `eth_estimateUserOperationGas` of the op with the stub; the op
 *    takes the bundler's callGasLimit and preVerificationGas, `verificationGasPercent` of its
 *    verificationGasLimit, and the sponsor's paymaster gas limits (its signature covers them).
 * 4. `pm_getPaymasterData` for the sized op (each request signed separately by the request's
 *    key: their digests differ), then the account signature: the root's raw over the userOpHash,
 *    a session key's as `abi.encode(keyHash, signature, "")`.
 * 5. `eth_sendUserOperation`, then `eth_getUserOperationReceipt` until it lands or `timeoutMs`
 *    passes. Resolves to the bundle's transaction hash and the UserOperation's own `success`.
 *
 * `ExecRequest.deadline` (which bounds a SignedBatchedCall on the relayer path) bounds the
 * sponsorship here: the paymaster's `validUntil` is the earlier of the deadline and
 * `now + validitySeconds`, so the op cannot be included after either.
 *
 * Errors: `SPONSOR_BUSY` throws `SponsorBusyError`, any other sponsor rejection
 * `SponsorRejectedError{reason}`; a bundler simulation revert `ExecutionRevertedError`; anything
 * else a plain Error.
 */
export class BundlerExecutor implements Executor {
  readonly kind = "bundler" as const;
  readonly #client: Client;
  readonly #bundler: Endpoint;
  readonly #sponsorEndpoint: Endpoint;
  readonly #addresses: AddressBook;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #validitySeconds: number;
  readonly #verificationGasPercent: bigint;
  #sponsor: Promise<Address> | undefined;

  constructor(options: BundlerExecutorOptions) {
    this.#client = options.client;
    this.#addresses = options.addresses ?? loadDeployments();
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#validitySeconds = options.validitySeconds ?? 60;
    this.#verificationGasPercent = options.verificationGasPercent ?? 150n;
    const endpoint = (label: string, url: string) => ({
      label,
      url: url.replace(/\/+$/, ""),
      timeoutMs: this.#timeoutMs,
    });
    this.#bundler = endpoint("Bundler", options.bundlerUrl);
    this.#sponsorEndpoint = endpoint("Sponsor", options.sponsorUrl);
    if (options.sponsor) this.#sponsor = Promise.resolve(getAddress(options.sponsor));
  }

  /** The sponsor's address. */
  sponsor(): Promise<Address> {
    this.#sponsor ??= readSponsorAddress(this.#sponsorEndpoint, this.#addresses.chainId).catch(
      (error) => {
        this.#sponsor = undefined;
        throw error;
      },
    );
    return this.#sponsor;
  }

  async submit(request: ExecRequest): Promise<ExecResult> {
    const isRoot = BigInt(request.keyHash) === 0n;
    if (request.authorization && !isRoot) {
      throw new Error("Refusing to attach eip7702Auth to a session UserOperation");
    }
    const deadline = Date.now() + this.#timeoutMs;
    const now = Math.floor(Date.now() / 1000);
    const validUntil = Math.min(now + this.#validitySeconds, Number(request.deadline));
    if (validUntil <= now) throw new Error(`The request's deadline ${request.deadline} has passed`);

    const { chainId, entryPoint } = this.#addresses;
    const sponsor = await this.sponsor();
    const bundler = (method: string, params: unknown[]) =>
      jsonRpc(this.#bundler, method, params, deadline, bundlerRpcError);
    const [nonce, price] = await Promise.all([
      readContract(this.#client, {
        address: entryPoint,
        abi: entryPoint08Abi,
        functionName: "getNonce",
        args: [request.account, request.lane],
      }),
      bundler("pimlico_getUserOperationGasPrice", []) as Promise<{ standard?: GasPrice }>,
    ]);

    const a = request.authorization;
    const unsized: PaymasterUserOperation = {
      sender: getAddress(request.account),
      nonce,
      ...(a && { factory: "0x7702", factoryData: "0x", authorization: a }),
      callData: encodeUserOpCallData(request.calls),
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: quantity(price?.standard?.maxFeePerGas, "Bundler", "maxFeePerGas"),
      maxPriorityFeePerGas: quantity(
        price?.standard?.maxPriorityFeePerGas,
        "Bundler",
        "maxPriorityFeePerGas",
      ),
    };

    const paymaster = async (method: PaymasterMethod, userOp: PaymasterUserOperation) => {
      const signed = await signPaymasterRequest(request.signer, method, {
        userOp,
        entryPoint,
        chainId,
        auth: {
          sponsor,
          keyHash: request.keyHash,
          validAfter: now - VALID_BEFORE_SECONDS,
          validUntil,
        },
      });
      const result = await jsonRpc(
        this.#sponsorEndpoint,
        method,
        paymasterRequestParams(signed),
        deadline,
        sponsorRpcError,
      );
      return paymasterResult(result, this.#addresses.verifyingPaymaster);
    };
    const signed = async (op: PaymasterUserOperation, pm: PaymasterDataResult) => {
      const userOperation: UserOperation<"0.8"> = {
        ...op,
        paymaster: pm.paymaster,
        paymasterData: pm.paymasterData,
        paymasterVerificationGasLimit: BigInt(pm.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: BigInt(pm.paymasterPostOpGasLimit),
        signature: "0x",
      };
      const signature = await request.signer.signTypedData(
        getUserOperationTypedData({ chainId, entryPointAddress: entryPoint, userOperation }),
      );
      userOperation.signature = isRoot
        ? signature
        : encodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
            [request.keyHash, signature, "0x"],
          );
      return formatUserOperationRequest(userOperation);
    };

    const stub = await paymaster(PM_GET_PAYMASTER_STUB_DATA_METHOD, unsized);
    const estimate = (await bundler("eth_estimateUserOperationGas", [
      await signed(unsized, stub),
      entryPoint,
    ])) as Record<string, unknown> | null;
    const gas = (field: string) => quantity(estimate?.[field], "Bundler", field);
    const sized: PaymasterUserOperation = {
      ...unsized,
      callGasLimit: gas("callGasLimit"),
      // The anvil tracing node over-reports a step after a returning call, which trips ERC-7562
      // OP-020 on a tight limit (docs/infra.md §3.5); unused verification gas is not charged.
      verificationGasLimit: (gas("verificationGasLimit") * this.#verificationGasPercent) / 100n,
      preVerificationGas: gas("preVerificationGas"),
    };
    const sponsored = await paymaster(PM_GET_PAYMASTER_DATA_METHOD, sized);
    const userOpHash = await bundler("eth_sendUserOperation", [
      await signed(sized, sponsored),
      entryPoint,
    ]);
    if (!isHash(userOpHash)) throw new Error("Bundler answered with a malformed userOpHash");

    const notIncluded = () =>
      new Error(`UserOperation ${userOpHash} not included after ${this.#timeoutMs} ms`);
    for (;;) {
      const receipt = (await bundler("eth_getUserOperationReceipt", [userOpHash]).catch((e) => {
        throw Date.now() >= deadline ? notIncluded() : e;
      })) as { success?: unknown; receipt?: { transactionHash?: unknown } } | null;
      if (receipt) {
        const hash = receipt.receipt?.transactionHash;
        if (typeof receipt.success !== "boolean" || !isHash(hash)) {
          throw new Error("Bundler answered with a malformed UserOperation receipt");
        }
        return { hash, success: receipt.success };
      }
      if (Date.now() + this.#pollIntervalMs >= deadline) throw notIncluded();
      await sleep(this.#pollIntervalMs);
    }
  }
}

const isHash = (v: unknown): v is Hex =>
  typeof v === "string" && isHex(v, { strict: true }) && v.length === 66;

/** A hex quantity from an untrusted answer. */
function quantity(value: unknown, label: string, field: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`${label} answered with a malformed ${field}`);
  }
  return BigInt(value);
}

/** Validates the sponsor's (untrusted) paymaster result: the address book's paymaster, hex fields. */
function paymasterResult(value: unknown, verifyingPaymaster: Address): PaymasterDataResult {
  const r = (value ?? {}) as Record<string, unknown>;
  if (
    typeof r.paymaster !== "string" ||
    !isAddress(r.paymaster, { strict: false }) ||
    getAddress(r.paymaster) !== getAddress(verifyingPaymaster)
  ) {
    throw new Error(`Sponsor answered with paymaster ${String(r.paymaster)}`);
  }
  if (typeof r.paymasterData !== "string" || !isHex(r.paymasterData, { strict: true })) {
    throw new Error("Sponsor answered with a malformed paymasterData");
  }
  return {
    paymaster: getAddress(r.paymaster),
    paymasterData: r.paymasterData,
    paymasterVerificationGasLimit: hexQuantity(r.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: hexQuantity(r.paymasterPostOpGasLimit),
  };
}

const hexQuantity = (v: unknown): Hex =>
  `0x${quantity(v, "Sponsor", "paymaster gas limit").toString(16)}`;

/** Maps a bundler JSON-RPC error: a simulation revert to `ExecutionRevertedError`, else an Error. */
function bundlerRpcError(error: unknown): Error {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  if (e.code === EXECUTION_REVERTED_CODE) {
    const data = (e.data as { revertData?: unknown } | undefined)?.revertData ?? e.data;
    return new ExecutionRevertedError({
      ...(isHex(data, { strict: true }) && { data }),
      reason: String(e.message),
    });
  }
  return new Error(`Bundler error ${String(e.code)}: ${String(e.message)}`);
}
