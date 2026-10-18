import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig, parseConfig } from "../src/config.js";

const yaml = (rpcUrl = "http://127.0.0.1:8545") => `
chainId: 5003
rpcUrl: ${rpcUrl}
listen: { host: 127.0.0.1, port: 0 }
database: ./data/sponsor.sqlite
relayer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
policy:
  allowlist: ["0x00000000000000000000000000000000000000aa"]
  accountDailyGas: 5000000
  maxFeePerRequestMnt: "0.05"
  dailyBudgetMnt: "5"
  managementReserveMnt: "1"
`;

describe("sponsor config", () => {
  afterEach(() => {
    delete process.env.SPONSOR_TEST_RPC;
  });

  it("loads YAML, resolving relative paths against the file and amounts in MNT", () => {
    const dir = mkdtempSync(join(tmpdir(), "sponsor-config-"));
    writeFileSync(join(dir, "sponsor.yaml"), yaml());
    const config = loadConfig(join(dir, "sponsor.yaml"));
    expect(config.database).toBe(join(dir, "data/sponsor.sqlite"));
    expect(config.relayer).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(config.addresses.chainId).toBe(5003);
    expect(config.policy).toEqual({
      allowlist: ["0x00000000000000000000000000000000000000AA"],
      accountDailyGas: 5_000_000n,
      maxFeePerRequest: parseEther("0.05"),
      dailyBudget: parseEther("5"),
      managementReserve: parseEther("1"),
    });
    expect(config.maxRequestValiditySeconds).toBe(300);
  });

  it("reads the RPC URL from the environment without echoing it", () => {
    process.env.SPONSOR_TEST_RPC = "https://user:secret@rpc.example";
    expect(parseConfig(parse(yaml(`\${SPONSOR_TEST_RPC}`)), "/").rpcUrl).toBe(
      "https://user:secret@rpc.example",
    );
    delete process.env.SPONSOR_TEST_RPC;
    expect(() => parseConfig(parse(yaml(`\${SPONSOR_TEST_RPC}`)), "/")).toThrow(/not set/);
  });

  it.each([
    ["an unquoted address", (s: string) => s.replace(/"(0x7099[^"]+)"/, "$1"), /relayer/],
    ["an unknown key", (s: string) => `${s}typo: 1\n`, /unknown keys: typo/],
    ["an unknown policy key", (s: string) => s.replace("dailyBudgetMnt", "dailyBudget"), /unknown/],
    ["a reserve above the budget", (s: string) => s.replace('"1"', '"6"'), /exceeds/],
    ["an unquoted amount", (s: string) => s.replace('"0.05"', "0.05"), /maxFeePerRequestMnt/],
    ["another chain", (s: string) => s.replace("5003", "5000"), /deployments/],
    ["a non-http RPC URL", (s: string) => s.replace("http://127.0.0.1:8545", "ws://x"), /http/],
  ])("rejects %s", (_, edit, message) => {
    expect(() => parseConfig(parse(edit(yaml())), "/")).toThrow(message);
  });
});
