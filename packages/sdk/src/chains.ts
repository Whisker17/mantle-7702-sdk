import type { Chain } from "viem";
import { mantle, mantleSepoliaTestnet } from "viem/chains";

/** Mantle Sepolia (5003): the target network. */
export const mantleSepolia: Chain = {
  ...mantleSepoliaTestnet,
  name: "Mantle Sepolia",
  blockExplorers: {
    default: { name: "Mantlescan", url: "https://sepolia.mantlescan.xyz" },
  },
};

/** Mantle mainnet (5000): configuration only; nothing in this SDK targets it by default. */
export const mantleMainnet: Chain = {
  ...mantle,
  blockExplorers: { default: { name: "Mantlescan", url: "https://mantlescan.xyz" } },
};

const chains: Record<number, Chain> = { 5000: mantleMainnet, 5003: mantleSepolia };

export function getChain(chainId: number): Chain {
  const chain = chains[chainId];
  if (!chain) throw new Error(`Unsupported chain id ${chainId}`);
  return chain;
}
