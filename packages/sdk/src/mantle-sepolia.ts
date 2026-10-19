import type { DeploymentRecord } from "./deployments.js";

/**
 * The fields of the committed `deployments/mantle-sepolia.json` that the SDK reads, shipped inside
 * the package so the default address book works when the SDK is installed from npm. A test fails
 * if this copy drifts from the committed file.
 */
export const MANTLE_SEPOLIA: DeploymentRecord = {
  chainId: 5003,
  CaliburEntry: { address: "0x000000005c84F8Fd50b21CAC312528A64437030e" },
  VerifyingPaymaster: {
    address: "0x301813D34cBebdf90FEBf32929CfB323c9eF3B4C",
    entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  },
  AgentPolicyHook: { address: "0xdC99279cc8858a109A0dE31b021D54EBe30aDd7F" },
  MockUSD: { address: "0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526" },
  MockLaunchpad: { address: "0x63614eAb4365EcA8c674D649fF2d3beb1a1cC7E9" },
  MemeToken: { address: "0xAb2D3B4cD4770e2669fe2BA781D449A214EF958f" },
};
