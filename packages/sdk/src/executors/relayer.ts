import { setTimeout as sleep } from "node:timers/promises";
import { type Address, type Client, getAddress, isAddress, isHex } from "viem";
import {
  type ExecRequest,
  type ExecResult,
  type Executor,
  readCaliburNonce,
  signBatchedCall,
} from "../account/executor.js";
import { type AddressBook, loadDeployments } from "../deployments.js";
import { SponsorBusyError, SponsorRejectedError } from "../errors.js";
import {
  type RelayRequest,
  type RelayResult,
  SPONSOR_REJECTED_RPC_CODE,
  SPONSOR_RELAY_METHOD,
  SponsorRejectCode,
  signRelayRequest,
} from "../sponsor/request.js";

export interface RelayerExecutorOptions {
  /** Reads the Calibur nonce and domain of the account the batch is for. */
  client: Client;
  /** The sponsor's JSON-RPC base URL (`POST /` for `sponsor_relay`, `GET /health`). */
  url: string;
  /**
   * The sponsor's relayer address: the batch's `executor` and the request domain. Defaults to the
   * `sponsor` the URL's `GET /health` reports (read once, with its chain id checked).
   */
  relayer?: Address;
  /** Defaults to the committed Mantle Sepolia address book. */
  addresses?: AddressBook;
  /** Bounds one `submit`, every HTTP call and every `pending` re-post included; default 120 s. */
  timeoutMs?: number;
  /** Pause before re-posting a `pending` request; default 1000 ms. */
  pollIntervalMs?: number;
}

/** Seconds the signed request is valid before and after the moment it is signed. */
const VALID_BEFORE_SECONDS = 30;
const VALID_AFTER_SECONDS = 60;
const STATUSES = new Set(["pending", "success", "reverted", "cancelled"]);

/**
 * Submits batches through the sponsor's `sponsor_relay` (docs/DESIGN.md §5.2, §7.1–7.2): signs the
 * SignedBatchedCall with the sponsor's relayer as executor, signs the request digest with the same
 * key, and re-posts the same request while it is `pending` (idempotent by request digest) until it
 * settles or `timeoutMs` passes. `success` / `reverted` resolve to `{ hash, success }`;
 * `SPONSOR_BUSY` throws `SponsorBusyError`, any other rejection `SponsorRejectedError{reason}`, and
 * a `cancelled` relay (the batch did not run) `SponsorRejectedError{reason: "CANCELLED"}`.
 */
export class RelayerExecutor implements Executor {
  readonly kind = "relayer" as const;
  readonly #client: Client;
  readonly #url: string;
  readonly #addresses: AddressBook;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  #relayer: Promise<Address> | undefined;

  constructor(options: RelayerExecutorOptions) {
    this.#client = options.client;
    this.#url = options.url.replace(/\/+$/, "");
    this.#addresses = options.addresses ?? loadDeployments();
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    if (options.relayer) this.#relayer = Promise.resolve(getAddress(options.relayer));
  }

  /** The sponsor's relayer address. */
  relayer(): Promise<Address> {
    this.#relayer ??= this.#health().catch((error) => {
      this.#relayer = undefined;
      throw error;
    });
    return this.#relayer;
  }

  async submit(request: ExecRequest): Promise<ExecResult> {
    const deadline = Date.now() + this.#timeoutMs;
    const relayer = await this.relayer();
    const { chainId, caliburEntry } = this.#addresses;
    const data = await signBatchedCall(this.#client, {
      account: request.account,
      implementation: caliburEntry,
      chainId,
      signer: request.signer,
      keyHash: request.keyHash,
      calls: request.calls,
      nonce: await readCaliburNonce(this.#client, request.account, request.lane),
      executor: relayer,
      deadline: request.deadline,
    });
    const now = Math.floor(Date.now() / 1000);
    const a = request.authorization;
    const signed = await signRelayRequest(request.signer, {
      sender: getAddress(request.account),
      data,
      // The wire carries the tuple only; a signed authorization's bigint `v` is not JSON.
      ...(a && {
        authorization: {
          address: a.address,
          chainId: a.chainId,
          nonce: a.nonce,
          yParity: a.yParity ?? 0,
          r: a.r,
          s: a.s,
        },
      }),
      auth: {
        chainId,
        sponsor: relayer,
        entry: caliburEntry,
        validAfter: now - VALID_BEFORE_SECONDS,
        validUntil: now + VALID_AFTER_SECONDS,
      },
    });

    for (;;) {
      const result = await this.#relay(signed, deadline);
      if (result.status === "success" || result.status === "reverted") {
        if (!result.hash) throw new Error(`Sponsor reported ${result.status} without a hash`);
        return { hash: result.hash, success: result.status === "success" };
      }
      if (result.status === "cancelled") throw new SponsorRejectedError({ reason: "CANCELLED" });
      if (Date.now() + this.#pollIntervalMs >= deadline) {
        throw new Error(
          `Relay of batch ${result.batchDigest} still pending after ${this.#timeoutMs} ms` +
            (result.hash ? ` (transaction ${result.hash})` : ""),
        );
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  async #relay(request: RelayRequest, deadline: number): Promise<RelayResult> {
    const body = await this.#fetch(this.#url, deadline, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: SPONSOR_RELAY_METHOD,
        params: [request],
      }),
    });
    const { result, error } = (body ?? {}) as { result?: unknown; error?: unknown };
    if (error !== undefined) throw rpcError(error);
    return relayResult(result);
  }

  async #health(): Promise<Address> {
    const body = (await this.#fetch(`${this.#url}/health`, Date.now() + this.#timeoutMs)) as {
      chainId?: unknown;
      sponsor?: unknown;
    };
    if (typeof body?.sponsor !== "string" || !isAddress(body.sponsor, { strict: false })) {
      throw new Error("Sponsor health reports no relayer address");
    }
    if (body.chainId !== this.#addresses.chainId) {
      throw new Error(`Sponsor chain ${body.chainId} is not ${this.#addresses.chainId}`);
    }
    return getAddress(body.sponsor);
  }

  /** One HTTP call, aborted at `deadline` (ms since epoch); resolves to the parsed JSON body. */
  async #fetch(url: string, deadline: number, init: RequestInit = {}): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Sponsor did not answer within ${this.#timeoutMs} ms`);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(remaining) });
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError") {
        throw new Error(`Sponsor did not answer within ${this.#timeoutMs} ms`);
      }
      throw new Error(`Sponsor unreachable: ${(error as Error)?.message}`, { cause: error });
    }
    if (!res.ok) throw new Error(`Sponsor answered HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error("Sponsor answered with invalid JSON");
    }
  }
}

/** Maps a JSON-RPC error to the SDK error model. */
function rpcError(error: unknown): Error {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  const data = (e.data ?? {}) as { reason?: unknown; detail?: unknown };
  if (e.code === SPONSOR_REJECTED_RPC_CODE && typeof data.reason === "string") {
    if (data.reason === SponsorRejectCode.SPONSOR_BUSY) return new SponsorBusyError();
    const rejected = new SponsorRejectedError({ reason: data.reason });
    if (typeof data.detail === "string" && data.detail) rejected.message += ` (${data.detail})`;
    return rejected;
  }
  return new Error(`Sponsor error ${String(e.code)}: ${String(e.message)}`);
}

/** Validates the sponsor's (untrusted) `sponsor_relay` result. */
function relayResult(value: unknown): RelayResult {
  const r = (value ?? {}) as Record<string, unknown>;
  const hash32 = (v: unknown) =>
    typeof v === "string" && isHex(v, { strict: true }) && v.length === 66;
  if (
    typeof r.status !== "string" ||
    !STATUSES.has(r.status) ||
    !hash32(r.batchDigest) ||
    (r.hash !== undefined && !hash32(r.hash))
  ) {
    throw new Error("Sponsor answered with a malformed relay result");
  }
  return r as unknown as RelayResult;
}
