import { type Address, getAddress, isAddress } from "viem";
import { SponsorBusyError, SponsorRejectedError } from "../errors.js";
import { SPONSOR_REJECTED_RPC_CODE, SponsorRejectCode } from "../sponsor/request.js";

/** An HTTP JSON-RPC service an executor talks to. Its URL never appears in an error message. */
export interface Endpoint {
  /** "Sponsor" or "Bundler": names the service in error messages. */
  label: string;
  url: string;
  /** The budget of one `submit`, reported when a call runs out of it. */
  timeoutMs: number;
}

/** One HTTP call to `url`, aborted at `deadline` (ms since epoch); resolves to the parsed JSON body. */
export async function fetchJson(
  e: Endpoint,
  url: string,
  deadline: number,
  init: RequestInit = {},
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${e.label} did not answer within ${e.timeoutMs} ms`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(remaining) });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new Error(`${e.label} did not answer within ${e.timeoutMs} ms`);
    }
    // Neither the native message nor the cause: either may hold the URL, and with it a credential.
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    const reason = typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "request failed";
    throw new Error(`${e.label} unreachable: ${reason}`);
  }
  if (!res.ok) throw new Error(`${e.label} answered HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${e.label} answered with invalid JSON`);
  }
}

/** One JSON-RPC call to the endpoint; a JSON-RPC error is thrown as `toError(error)`. */
export async function jsonRpc(
  e: Endpoint,
  method: string,
  params: unknown[],
  deadline: number,
  toError: (error: unknown) => Error,
): Promise<unknown> {
  const body = await fetchJson(e, e.url, deadline, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const { result, error } = (body ?? {}) as { result?: unknown; error?: unknown };
  if (error !== undefined) throw toError(error);
  return result;
}

/** Maps a sponsor JSON-RPC error to the SDK error model. */
export function sponsorRpcError(error: unknown): Error {
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

/** The sponsor's address from its `GET /health`, after checking it serves `chainId`. */
export async function readSponsorAddress(e: Endpoint, chainId: number): Promise<Address> {
  const body = (await fetchJson(e, `${e.url}/health`, Date.now() + e.timeoutMs)) as {
    chainId?: unknown;
    sponsor?: unknown;
  };
  if (typeof body?.sponsor !== "string" || !isAddress(body.sponsor, { strict: false })) {
    throw new Error("Sponsor health reports no relayer address");
  }
  if (body.chainId !== chainId) throw new Error(`Sponsor chain ${body.chainId} is not ${chainId}`);
  return getAddress(body.sponsor);
}
