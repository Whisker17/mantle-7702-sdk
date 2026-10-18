import { readFileSync } from "node:fs";
import { type Address, getAddress, isAddress } from "viem";

/** The subset of a `deployments/<network>.json` record the SDK reads. */
export interface DeploymentRecord {
  chainId: number;
  CaliburEntry: { address: string };
  VerifyingPaymaster: { address: string; entryPoint: string };
  AgentPolicyHook: { address: string };
  MockUSD: { address: string };
  MockLaunchpad: { address: string };
  MemeToken: { address: string };
}

export interface AddressBook {
  chainId: number;
  caliburEntry: Address;
  verifyingPaymaster: Address;
  entryPoint: Address;
  agentPolicyHook: Address;
  mockUsd: Address;
  mockLaunchpad: Address;
  /** The AMEME token created by MockLaunchpad. */
  memeToken: Address;
}

const MANTLE_SEPOLIA_FILE = new URL("../../../deployments/mantle-sepolia.json", import.meta.url);

/**
 * Load an address book from a deployment record, a path to one, or (by default) the committed
 * `deployments/mantle-sepolia.json`. Every address is validated and checksummed.
 */
export function loadDeployments(
  source: string | URL | DeploymentRecord = MANTLE_SEPOLIA_FILE,
): AddressBook {
  const record: DeploymentRecord =
    typeof source === "string" || source instanceof URL
      ? JSON.parse(readFileSync(source, "utf8"))
      : source;
  if (!Number.isSafeInteger(record?.chainId)) throw new Error("Deployment record has no chainId");
  const address = (field: string, value: unknown): Address => {
    if (typeof value !== "string" || !isAddress(value, { strict: false })) {
      throw new Error(`Deployment record has no valid ${field} address`);
    }
    return getAddress(value);
  };
  return {
    chainId: record.chainId,
    caliburEntry: address("CaliburEntry", record.CaliburEntry?.address),
    verifyingPaymaster: address("VerifyingPaymaster", record.VerifyingPaymaster?.address),
    entryPoint: address("VerifyingPaymaster.entryPoint", record.VerifyingPaymaster?.entryPoint),
    agentPolicyHook: address("AgentPolicyHook", record.AgentPolicyHook?.address),
    mockUsd: address("MockUSD", record.MockUSD?.address),
    mockLaunchpad: address("MockLaunchpad", record.MockLaunchpad?.address),
    memeToken: address("MemeToken", record.MemeToken?.address),
  };
}
