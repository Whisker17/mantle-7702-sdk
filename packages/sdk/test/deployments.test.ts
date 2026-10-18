import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DeploymentRecord, loadDeployments } from "../src/index.js";

const file = new URL("../../../deployments/mantle-sepolia.json", import.meta.url);
const record: DeploymentRecord = JSON.parse(readFileSync(file, "utf8"));

describe("deployments", () => {
  it("loads the committed Mantle Sepolia address book by default", () => {
    expect(loadDeployments()).toEqual({
      chainId: 5003,
      caliburEntry: "0x000000005c84F8Fd50b21CAC312528A64437030e",
      verifyingPaymaster: "0x301813D34cBebdf90FEBf32929CfB323c9eF3B4C",
      entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      agentPolicyHook: "0xdC99279cc8858a109A0dE31b021D54EBe30aDd7F",
      mockUsd: "0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526",
      mockLaunchpad: "0x63614eAb4365EcA8c674D649fF2d3beb1a1cC7E9",
      memeToken: "0xAb2D3B4cD4770e2669fe2BA781D449A214EF958f",
    });
  });

  it("accepts a custom record and checksums its addresses", () => {
    const custom = {
      ...record,
      chainId: 31337,
      MockUSD: { address: record.MockUSD.address.toLowerCase() },
    };
    const book = loadDeployments(custom);
    expect(book.chainId).toBe(31337);
    expect(book.mockUsd).toBe("0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526");
  });

  it("rejects a record with a missing or malformed address", () => {
    expect(() => loadDeployments({ ...record, AgentPolicyHook: { address: "0x1234" } })).toThrow(
      /AgentPolicyHook/,
    );
    const { MemeToken: _, ...noMeme } = record;
    expect(() => loadDeployments(noMeme as DeploymentRecord)).toThrow(/MemeToken/);
  });
});
