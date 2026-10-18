import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  parseRelayRequest,
  SPONSOR_REJECTED_RPC_CODE,
  SPONSOR_RELAY_METHOD,
  SponsorRejectCode,
} from "@mantle-aa/sdk";
import type { Client } from "viem";
import { type DecodedRelay, decodeRelay, reject, SponsorRejection, verifyOnChain } from "./auth.js";
import type { SponsorConfig } from "./config.js";
import {
  checkAllowlist,
  checkBudget,
  classify,
  type SponsoredTransaction,
  simulate,
} from "./policy.js";
import { type BudgetClass, dayOf, type SponsorStore } from "./store.js";

/** A request the sponsor has authenticated, decoded, simulated and decided to pay for. */
export interface RelayDecision extends DecodedRelay {
  budgetClass: BudgetClass;
  /** The UTC day whose counters the request is checked (and is to be charged) against. */
  day: number;
  tx: SponsoredTransaction;
}

export interface SponsorContext {
  config: SponsorConfig;
  client: Client;
  store: SponsorStore;
  /** Unix seconds; defaults to the local clock. */
  now?: () => number;
}

const clock = () => Math.floor(Date.now() / 1000);

/**
 * The `sponsor_relay` pipeline up to the sponsorship decision: parse → domain, validity, decode,
 * lanes and request signature → allowlist → chain checks (delegation, session key, batch
 * signature) → own simulation and worst-case fee → caps against today's persisted usage.
 * Throws `SponsorRejection` on the first failed check.
 */
export async function authorizeRelay(ctx: SponsorContext, params: unknown): Promise<RelayDecision> {
  let request: ReturnType<typeof parseRelayRequest>;
  try {
    request = parseRelayRequest(params);
  } catch (error) {
    return reject(SponsorRejectCode.INVALID_PARAMS, (error as Error).message);
  }
  const now = (ctx.now ?? clock)();
  const relay = await decodeRelay(request, ctx.config, now);
  checkAllowlist(ctx.config, relay.sender);
  await verifyOnChain(ctx.client, ctx.config, relay);
  const budgetClass = classify(relay.signedBatchedCall, relay.sender, ctx.config);
  const tx = await simulate(ctx.client, ctx.config, {
    to: relay.sender,
    data: relay.data,
    ...(request.authorization ? { authorizationList: [request.authorization] } : {}),
  });
  const day = dayOf(now);
  checkBudget(ctx.config, ctx.store.usage(day, relay.sender), { budgetClass, ...tx });
  return { ...relay, budgetClass, day, tx };
}

export interface SponsorServerOptions extends SponsorContext {
  /** Pays for an accepted request (reservation, submission, settlement). */
  submit?: (decision: RelayDecision) => Promise<unknown>;
}

const MAX_BODY_BYTES = 1 << 20;

/** The HTTP JSON-RPC server: `POST /` for `sponsor_relay`, `GET /health`. */
export function createSponsorServer(options: SponsorServerOptions) {
  const { config } = options;

  async function relay(params: unknown): Promise<unknown> {
    if (!Array.isArray(params) || params.length !== 1) {
      return reject(SponsorRejectCode.INVALID_PARAMS, "params must be [request]");
    }
    const decision = await authorizeRelay(options, params[0]);
    if (!options.submit) {
      return reject(SponsorRejectCode.SUBMISSION_UNAVAILABLE, "this sponsor has no relayer");
    }
    return options.submit(decision);
  }

  async function rpc(body: string): Promise<object> {
    let message: { id?: unknown; jsonrpc?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(body);
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const id = message.id ?? null;
    if (message.method !== SPONSOR_RELAY_METHOD) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
    try {
      return { jsonrpc: "2.0", id, result: await relay(message.params) };
    } catch (error) {
      if (error instanceof SponsorRejection) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: SPONSOR_REJECTED_RPC_CODE,
            message: `Sponsor rejected the request: ${error.reason}`,
            data: { reason: error.reason, detail: error.detail },
          },
        };
      }
      // Never echo an internal error: viem messages carry the RPC URL, which may hold credentials.
      console.error(`sponsor: internal error (${(error as Error)?.name ?? "unknown"})`);
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { status: "ok", chainId: config.chainId, sponsor: config.relayer });
    }
    if (req.method !== "POST" || req.url !== "/") return send(404, { error: "Not found" });
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += (chunk as Buffer).length;
      if (length > MAX_BODY_BYTES) return send(413, { error: "Request body too large" });
      chunks.push(chunk as Buffer);
    }
    send(200, await rpc(Buffer.concat(chunks).toString("utf8")));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.headersSent || res.writeHead(500).end());
  });
  return {
    /** Listens on the configured host and port (0 = ephemeral); resolves to the base URL. */
    listen(): Promise<string> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.listen.port, config.listen.host, () => {
          const { address, port } = server.address() as AddressInfo;
          resolve(`http://${address.includes(":") ? `[${address}]` : address}:${port}`);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
