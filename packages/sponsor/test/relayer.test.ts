import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { loadRelayerAccount } from "../src/relayer.js";

describe("loadRelayerAccount", () => {
  const key = generatePrivateKey();
  const relayer = privateKeyToAccount(key).address;

  it("loads the configured relayer's key from the variable the config names", () => {
    const account = loadRelayerAccount({ relayer, relayerKeyEnv: "K" }, { K: key });
    expect(account.address).toBe(relayer);
  });

  it("refuses a missing, malformed or foreign key without echoing it", () => {
    const other = generatePrivateKey();
    const cases: [Record<string, string>, RegExp][] = [
      [{}, /K must hold/],
      [{ K: key.slice(0, 40) }, /K must hold/],
      [{ K: other }, /not of relayer/],
    ];
    for (const [env, message] of cases) {
      const error = (() => {
        try {
          loadRelayerAccount({ relayer, relayerKeyEnv: "K" }, env);
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error?.message).toMatch(message);
      expect(error?.message).not.toContain(other.slice(2));
      expect(error?.message).not.toContain(key.slice(2, 40));
    }
    expect(() => loadRelayerAccount({ relayer }, { K: key })).toThrow(/no relayerKey/);
  });
});
