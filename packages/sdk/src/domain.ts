import {
  type Address,
  type Client,
  concat,
  getAddress,
  type Hex,
  pad,
  type TypedDataDomain,
} from "viem";
import { getCode, readContract } from "viem/actions";

/** Calibur v1.1.0 `eip712Domain()` still reports version "1.0.0" (docs/DESIGN.md §4.1). */
export const CALIBUR_DOMAIN_NAME = "Calibur";
export const CALIBUR_DOMAIN_VERSION = "1.0.0";

const eip712DomainAbi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

export interface CaliburDomain extends TypedDataDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
  salt: Hex;
}

/**
 * The domain a delegated account reports, computed offline: `verifyingContract` is the account
 * (Calibur runs in the EOA's context) and `salt = (saltPrefix << 160) | implementation`
 * (`EIP712.sol`, `PrefixedSaltLib.pack`). The prefix is 0 until the account calls `updateSalt()`.
 */
export function caliburDomain(params: {
  chainId: number;
  account: Address;
  implementation: Address;
  saltPrefix?: bigint;
}): CaliburDomain {
  const salt = ((params.saltPrefix ?? 0n) << 160n) | BigInt(params.implementation);
  return {
    name: CALIBUR_DOMAIN_NAME,
    version: CALIBUR_DOMAIN_VERSION,
    chainId: params.chainId,
    verifyingContract: getAddress(params.account),
    salt: pad(`0x${salt.toString(16)}`, { size: 32 }),
  };
}

/** Reads `eip712Domain()` from a contract (a delegated account or the implementation itself). */
export async function readCaliburDomain(client: Client, address: Address): Promise<CaliburDomain> {
  const [, name, version, chainId, verifyingContract, salt] = await readContract(client, {
    address,
    abi: eip712DomainAbi,
    functionName: "eip712Domain",
  });
  return { name, version, chainId: Number(chainId), verifyingContract, salt };
}

/** The EIP-7702 delegation designator `0xef0100 ‖ implementation`. */
export const delegationDesignator = (implementation: Address): Hex =>
  concat(["0xef0100", implementation]).toLowerCase() as Hex;

/**
 * The signing domain of `account`: read from chain when it is delegated to `implementation`,
 * computed offline when it has no code yet. Any other code (another delegate, a contract) throws.
 */
export async function getCaliburDomain(
  client: Client,
  params: { account: Address; implementation: Address; chainId: number },
): Promise<CaliburDomain> {
  const code = (await getCode(client, { address: params.account }))?.toLowerCase();
  if (!code || code === "0x") return caliburDomain(params);
  if (code === delegationDesignator(params.implementation)) {
    return readCaliburDomain(client, params.account);
  }
  throw new Error(`Account ${params.account} is not delegated to Calibur ${params.implementation}`);
}
