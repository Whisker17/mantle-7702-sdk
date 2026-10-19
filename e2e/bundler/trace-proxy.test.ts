// trace-proxy.mjs (the strict bundler stack against the real chain, sepolia.sh) must not pass a
// credentialed URL on to Alto, whose RPC transport logs every JSON-RPC error it receives into
// alto.log. Local fixtures stand in for both destinations: the upstream RPC (every method but
// `debug_*`) and the tracing anvil (`debug_*`), each answering with errors that name a URL carrying
// a synthetic path and query credential. Checked at the proxy's response and at the pinned Alto's
// own transport (`customTransport`, as the bundler stack runs it) with a recording logger.
// No network beyond the pinned Alto install (shared with the bundler suites); no chain, no secrets.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, installAlto } from "./harness.js";

const PROXY = fileURLToPath(new URL("./trace-proxy.mjs", import.meta.url));
const MARKERS = /SYNTHETIC_PATH_TOKEN|SYNTHETIC_QUERY_TOKEN/;
const REVERT = "0x08c379a00000000000000000000000000000000000000000000000000000000000000020";
const BLOCK = { number: "0x10", hash: `0x${"ab".repeat(32)}`, extraData: "https://example.org" };

type Rpc = { id?: unknown; method: string; params?: unknown[] };

/** A JSON-RPC fixture at `/v2/<path token>?apikey=<query token>`; errors name that URL. */
async function fixture(answer: (req: Rpc, url: string) => object): Promise<[Server, string]> {
  let url = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body) as Rpc;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...answer(rpc, url) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  url = `http://127.0.0.1:${port}/v2/SYNTHETIC_PATH_TOKEN?apikey=SYNTHETIC_QUERY_TOKEN`;
  return [server, url];
}

/** The error the upstream returns for `method`: its URL in message and data, plus revert data. */
const upstreamError = (method: string, url: string) => ({
  code: -32000,
  message: `${method}: upstream request failed: ${url}`,
  data: { detail: `fetch\n${url} timed out`, revert: REVERT, attempts: [1, 2] },
});

describe("trace proxy: upstream and trace-node errors reach Alto without URLs", () => {
  const servers: Server[] = [];
  let proxy: ChildProcess;
  let proxyUrl: string;

  beforeAll(async () => {
    const [upstream, upstreamUrl] = await fixture((req, url) =>
      req.method === "eth_getBlockByNumber"
        ? { result: BLOCK }
        : { error: upstreamError(req.method, url) },
    );
    const [trace] = await fixture((req, url) => {
      if (req.method === "anvil_reset") return { result: null };
      if (req.method === "eth_blockNumber") return { result: "0x10" };
      return { error: { code: -32603, message: `error sending request for url (${url})` } };
    });
    servers.push(upstream, trace);
    const port = await freePort();
    proxyUrl = `http://127.0.0.1:${port}`;
    proxy = spawn(process.execPath, [PROXY], {
      env: {
        ...process.env,
        UPSTREAM_RPC_URL: upstreamUrl,
        TRACE_RPC_URL: `http://127.0.0.1:${(trace.address() as { port: number }).port}`,
        PORT: String(port),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    // The proxy logs one line to stderr once it listens.
    await once(proxy.stderr as NodeJS.ReadableStream, "data", {
      signal: AbortSignal.timeout(10_000),
    });
  }, 30_000);

  afterAll(async () => {
    if (proxy && proxy.exitCode === null) {
      proxy.kill();
      await once(proxy, "exit");
    }
    for (const server of servers) server.close();
  });

  const call = async (method: string) => {
    const res = await fetch(proxyUrl, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.json();
  };

  it("redacts the URL in an upstream error, keeping its code and data structure", async () => {
    for (const method of ["eth_chainId", "eth_call", "eth_sendRawTransaction"]) {
      const out = await call(method);
      expect(JSON.stringify(out)).not.toMatch(MARKERS);
      expect(out).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: {
          code: -32000,
          message: `${method}: upstream request failed: <redacted-url>`,
          data: { detail: "fetch\n<redacted-url> timed out", revert: REVERT, attempts: [1, 2] },
        },
      });
    }
  });

  it("redacts the URL in a trace-node error", async () => {
    const out = await call("debug_traceCall");
    expect(out).toEqual({
      jsonrpc: "2.0",
      id: 7,
      // The redaction, like the SDK's, runs to the next space or quote, so it takes the ")".
      error: { code: -32603, message: "error sending request for url (<redacted-url>" },
    });
  });

  it("passes a successful result through unchanged, URLs included", async () => {
    expect(await call("eth_getBlockByNumber")).toEqual({ jsonrpc: "2.0", id: 7, result: BLOCK });
  });

  it("leaves no URL in what the pinned Alto's transport logs", async () => {
    const cli = await installAlto();
    const { customTransport } = await import(join(dirname(cli), "customTransport.js"));
    const logged: unknown[] = [];
    const record = (entry: unknown, msg: string) => logged.push({ msg, ...(entry as object) });
    const transport = customTransport(proxyUrl, {
      logger: { error: record, info: record },
      retryCount: 0,
    })({});
    for (const method of ["eth_chainId", "debug_traceCall"]) {
      await expect(transport.request({ method, params: [] })).rejects.toThrow();
    }
    const errors = logged.filter((e) => (e as { msg: string }).msg === "received error response");
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toMatch(MARKERS);
    expect(errors[0]).toMatchObject({
      err: { code: -32000, data: { revert: REVERT, attempts: [1, 2] } },
    });
  }, 360_000);
});
