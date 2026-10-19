import { inspect } from "node:util";
import { createClient, custom } from "viem";
import { describe, expect, it } from "vitest";
import { BundlerExecutor, mantleSepolia, RelayerExecutor } from "../../src/index.js";

// A synthetic credential marker: never a real key. Nothing listens on port 1.
const MARKER = "S3CRET-MARKER-7f3a";
const URLS = [
  ["userinfo", `http://user:${MARKER}@127.0.0.1:1`],
  ["a path token", `http://127.0.0.1:1/v2/${MARKER}`],
  ["a query token", `http://127.0.0.1:1/rpc?apikey=${MARKER}`],
  ["an unparsable URL", `http://exa mple.invalid/v2/${MARKER}`],
] as const;

const client = createClient({
  chain: mantleSepolia,
  transport: custom({
    async request() {
      throw new Error("no chain access in this test");
    },
  }),
});

/** Every form an error is read or logged in: message, String(), the cause chain, inspect(). */
function forms(error: unknown): string[] {
  const out = [inspect(error, { depth: 20 })];
  for (let e: unknown = error; e !== undefined && e !== null; e = (e as Error).cause) {
    out.push(String(e), String((e as Error).message), String((e as Error).stack));
  }
  return out;
}

describe("HTTP endpoint errors", () => {
  it.each(URLS)("never carry a URL with %s", async (_, url) => {
    const sponsor = await new RelayerExecutor({ client, url, timeoutMs: 5_000 })
      .relayer()
      .catch((e: unknown) => e);
    const bundler = await new BundlerExecutor({
      client,
      bundlerUrl: url,
      sponsorUrl: url,
      timeoutMs: 5_000,
    })
      .sponsor()
      .catch((e: unknown) => e);
    for (const error of [sponsor, bundler]) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^Sponsor unreachable: /);
      for (const text of forms(error)) expect(text).not.toContain(MARKER);
    }
  });
});
