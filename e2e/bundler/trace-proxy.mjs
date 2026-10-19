// JSON-RPC router for a strict-mode (safe-mode) Alto bundler on the real Mantle Sepolia chain.
//
// Mantle Sepolia's public RPC does not whitelist `debug_*`, and strict validation needs
// `debug_traceCall` with Alto's JavaScript tracer. This proxy sends every `debug_*` request to a
// local anvil fork (JS tracers supported) and every other request — reads, gas prices, nonces,
// raw transactions, receipts — to the upstream RPC unchanged. No dependencies; Node >= 24.
//
// The fork is re-forked at the upstream head before a trace when a raw transaction (a bundle) has
// gone upstream since the last fork, or when the fork is older than FORK_MAX_AGE_S. Otherwise
// the warm fork is reused: a fresh fork fetches every touched account and slot lazily from the
// upstream RPC, which can exceed Alto's fixed 10 s RPC timeout (measured on 2026-10-18).
//
// The upstream URL may carry an API key: a JSON-RPC error from either the trace node (it may name
// the fork URL) or the upstream (it may name its own URL) is passed on and logged with every URL in
// its strings redacted (code, data and successful results are unchanged), and the upstream is
// never logged.
//
// Env: UPSTREAM_RPC_URL (default https://rpc.sepolia.mantle.xyz),
//      TRACE_RPC_URL (anvil, default http://127.0.0.1:18545), PORT (default 18546),
//      FORK_MAX_AGE_S (default 120).

import { createServer } from "node:http";

const upstream = process.env.UPSTREAM_RPC_URL ?? "https://rpc.sepolia.mantle.xyz";
const traceNode = process.env.TRACE_RPC_URL ?? "http://127.0.0.1:18545";
const port = Number(process.env.PORT ?? 18546);
const maxForkAgeMs = Number(process.env.FORK_MAX_AGE_S ?? 120) * 1000;
/** When the trace node was last forked, its block, and whether a bundle went out since. */
let fork = { at: 0, block: 0n, dirty: true };
/** Every URL becomes `<redacted-url>`, as redactUrls in packages/sdk/src/errors.ts. */
const redact = (text) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, "<redacted-url>");

/** Posts a JSON-RPC request; every string in a returned error has its URLs redacted. */
async function post(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json();
  if (out?.error) {
    out.error = JSON.parse(
      JSON.stringify(out.error, (_, v) => (typeof v === "string" ? redact(v) : v)),
    );
  }
  return out;
}

// Fork the upstream head when the trace node may be stale, so a trace sees the state the bundle
// will execute against; returns the fork block.
async function freshTraceNode() {
  if (!fork.dirty && Date.now() - fork.at < maxForkAgeMs) return fork.block;
  const out = await post(traceNode, {
    jsonrpc: "2.0",
    id: 0,
    method: "anvil_reset",
    params: [{ forking: { jsonRpcUrl: upstream } }],
  });
  if (out.error) throw new Error(`anvil_reset failed: ${JSON.stringify(out.error)}`);
  const head = await post(traceNode, {
    jsonrpc: "2.0",
    id: 0,
    method: "eth_blockNumber",
    params: [],
  });
  fork = { at: Date.now(), block: BigInt(head.result), dirty: false };
  return fork.block;
}

async function route(request) {
  if (typeof request?.method === "string" && request.method.startsWith("debug_")) {
    const block = await freshTraceNode();
    const out = await post(traceNode, request);
    const verdict = out.error ? `error ${JSON.stringify(out.error).slice(0, 200)}` : "ok";
    console.error(
      `${new Date().toISOString()} ${request.method} -> trace node @ fork block ${block}: ${verdict}`,
    );
    return out;
  }
  if (request?.method === "eth_sendRawTransaction") fork.dirty = true;
  return post(upstream, request);
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let reply;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    reply = Array.isArray(body) ? await Promise.all(body.map(route)) : await route(body);
  } catch (e) {
    reply = { jsonrpc: "2.0", id: null, error: { code: -32603, message: redact(String(e)) } };
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(reply));
}).listen(port, "127.0.0.1", () => {
  console.error(
    `trace proxy on 127.0.0.1:${port}: debug_* -> ${traceNode} (re-forked at head when stale), rest -> the upstream RPC`,
  );
});
