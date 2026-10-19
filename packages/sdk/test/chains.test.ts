import { describe, expect, it } from "vitest";
import { getChain, PACKAGE_NAME } from "../src/index.js";

describe("chains", () => {
  it("exposes its entry point", () => {
    expect(PACKAGE_NAME).toBe("@0xwh1sker/mantle-aa-sdk");
  });

  it("configures Mantle Sepolia", () => {
    const chain = getChain(5003);
    expect(chain.id).toBe(5003);
    expect(chain.rpcUrls.default.http).toEqual(["https://rpc.sepolia.mantle.xyz"]);
    expect(chain.blockExplorers?.default.url).toBe("https://sepolia.mantlescan.xyz");
    expect(chain.nativeCurrency).toEqual({ name: "MNT", symbol: "MNT", decimals: 18 });
  });

  it("configures Mantle mainnet", () => {
    const chain = getChain(5000);
    expect(chain.rpcUrls.default.http).toEqual(["https://rpc.mantle.xyz"]);
    expect(chain.blockExplorers?.default.url).toBe("https://mantlescan.xyz");
    expect(chain.nativeCurrency.symbol).toBe("MNT");
  });

  it("rejects an unknown chain", () => {
    expect(() => getChain(1)).toThrow(/Unsupported chain id 1/);
  });
});
