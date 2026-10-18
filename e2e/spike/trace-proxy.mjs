// Feasibility-spike JSON-RPC router for a strict-mode (safe-mode) Alto bundler on Mantle Sepolia.
//
// Mantle Sepolia's public RPC does not whitelist `debug_*`, and strict validation needs
// `debug_traceCall` with Alto's JavaScript tracer. This proxy sends every `debug_*` request to a
// local anvil fork (JS tracers supported) after resetting that fork to the upstream chain head,
// and every other request — reads, gas prices, nonces, raw transactions, receipts — to the
// upstream RPC unchanged. No dependencies; Node >= 24.
//
// Env: UPSTREAM_RPC_URL (default https://rpc.sepolia.mantle.xyz),
//      TRACE_RPC_URL (anvil, default http://127.0.0.1:18545), PORT (default 18546).

import { createServer } from "node:http";

const upstream = process.env.UPSTREAM_RPC_URL ?? "https://rpc.sepolia.mantle.xyz";
const traceNode = process.env.TRACE_RPC_URL ?? "http://127.0.0.1:18545";
const port = Number(process.env.PORT ?? 18546);

async function post(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// Fork the upstream head, so every trace sees the state the bundle will execute against.
async function resetTraceNode() {
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
  return BigInt(head.result);
}

async function route(request) {
  if (typeof request?.method === "string" && request.method.startsWith("debug_")) {
    const block = await resetTraceNode();
    const out = await post(traceNode, request);
    const verdict = out.error ? `error ${JSON.stringify(out.error).slice(0, 200)}` : "ok";
    console.error(
      `${new Date().toISOString()} ${request.method} -> trace node @ fork block ${block}: ${verdict}`,
    );
    return out;
  }
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
    reply = { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e) } };
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(reply));
}).listen(port, "127.0.0.1", () => {
  console.error(
    `trace proxy on 127.0.0.1:${port}: debug_* -> ${traceNode} (reset to head), rest -> ${upstream}`,
  );
});
