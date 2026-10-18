import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { describe, expect, it } from "vitest";
import { PrivateKeySigner } from "../src/index.js";

// anvil's first development key; public test material.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("PrivateKeySigner", () => {
  const signer = new PrivateKeySigner(KEY);

  it("derives the address and does not expose the key", () => {
    expect(signer.address).toBe(ADDRESS);
    expect(JSON.stringify(signer)).not.toContain(KEY.slice(2));
  });

  it("signs messages and typed data recoverable to its address", async () => {
    const message = "hello mantle";
    expect(
      await recoverMessageAddress({ message, signature: await signer.signMessage({ message }) }),
    ).toBe(ADDRESS);
    const typed = {
      domain: { name: "Test", version: "1", chainId: 5003 },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping",
      message: { n: 1n },
    } as const;
    const signature = await signer.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(ADDRESS);
  });

  it("signs a chain-bound EIP-7702 authorization and refuses chainId 0", async () => {
    const request = {
      address: "0x000000005c84F8Fd50b21CAC312528A64437030e",
      chainId: 5003,
      nonce: 0,
    } as const;
    const authorization = await signer.signAuthorization(request);
    expect(authorization.chainId).toBe(5003);
    expect(await recoverAuthorizationAddress({ authorization })).toBe(ADDRESS);
    await expect(async () => signer.signAuthorization({ ...request, chainId: 0 })).rejects.toThrow(
      /chainId/,
    );
  });
});
