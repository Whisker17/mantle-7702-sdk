// DIAGNOSTIC (temporary): a pass-through JSON-RPC proxy between anvil and the upstream RPC that
// prints one JSON line per request (time, latency, HTTP status, methods, JSON-RPC error code).
import { createServer } from "node:http";

const upstream = process.env.UPSTREAM_RPC_URL;
createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const t = Date.now();
  let status = 0;
  let text = "";
  try {
    const out = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    status = out.status;
    text = await out.text();
  } catch (e) {
    text = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -1, message: String(e) } });
  }
  let methods = "?";
  let key = "";
  let code;
  try {
    const j = JSON.parse(body);
    methods = (Array.isArray(j) ? j : [j]).map((x) => x.method).join(",");
    key = (Array.isArray(j) ? j : [j])
      .map((x) => `${x.method}${JSON.stringify(x.params)}`)
      .join(",");
    const r = JSON.parse(text);
    code = (Array.isArray(r) ? r : [r]).find((x) => x.error)?.error?.code;
  } catch {}
  console.log(JSON.stringify({ t, ms: Date.now() - t, status, methods, key, code }));
  res.writeHead(status || 502, { "content-type": "application/json" });
  res.end(text);
}).listen(0, "127.0.0.1", function () {
  console.log(`listening ${this.address().port}`);
});
