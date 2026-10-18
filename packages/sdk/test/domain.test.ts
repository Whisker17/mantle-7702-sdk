import { readFileSync } from "node:fs";
import { createClient, custom, hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import { caliburDomain, delegationDesignator, getCaliburDomain } from "../src/index.js";

const record = JSON.parse(
  readFileSync(new URL("../../../deployments/mantle-sepolia.json", import.meta.url), "utf8"),
);
const IMPL = "0x000000005c84F8Fd50b21CAC312528A64437030e";
const ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** A client whose only RPC answer is `eth_getCode`. */
const clientWithCode = (code: string) =>
  createClient({
    transport: custom({
      request: async ({ method }) => {
        if (method === "eth_getCode") return code;
        throw new Error(`unexpected ${method}`);
      },
    }),
  });

describe("Calibur EIP-712 domain", () => {
  it("matches the eip712Domain() recorded from the implementation at deployment", () => {
    const { name, version, chainId, verifyingContract, salt } = record.CaliburEntry.eip712Domain;
    expect(caliburDomain({ chainId: 5003, account: IMPL, implementation: IMPL })).toEqual({
      name,
      version,
      chainId,
      verifyingContract,
      salt,
    });
  });

  it("binds the account as verifyingContract and the implementation (with prefix) as salt", () => {
    const domain = caliburDomain({
      chainId: 5003,
      account: ACCOUNT,
      implementation: IMPL,
      saltPrefix: 1n,
    });
    expect(domain.verifyingContract).toBe(ACCOUNT);
    expect(domain.salt).toBe("0x000000000000000000000001000000005c84f8fd50b21cac312528a64437030e");
    const other = caliburDomain({
      chainId: 5000,
      account: ACCOUNT,
      implementation: IMPL,
      saltPrefix: 1n,
    });
    const hash = (d: typeof domain) =>
      hashTypedData({ domain: d, types: {}, primaryType: "EIP712Domain" });
    expect(hash(domain)).not.toBe(hash(other));
  });

  it("computes offline for an undelegated account and refuses a foreign delegate", async () => {
    const params = { account: ACCOUNT, implementation: IMPL, chainId: 5003 } as const;
    expect(await getCaliburDomain(clientWithCode("0x"), params)).toEqual(caliburDomain(params));
    const foreign = delegationDesignator("0x1111111111111111111111111111111111111111");
    await expect(getCaliburDomain(clientWithCode(foreign), params)).rejects.toThrow(
      /not delegated/,
    );
  });
});
