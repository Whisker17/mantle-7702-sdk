import { parseAbi } from "viem";

/** The subset of the Calibur v1.1.0 account ABI the SDK calls (`contracts/lib/calibur`). */
export const caliburAbi = parseAbi([
  "struct Key { uint8 keyType; bytes publicKey; }",
  "struct Call { address to; uint256 value; bytes data; }",
  "struct BatchedCall { Call[] calls; bool revertOnFailure; }",
  "struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }",
  "function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable",
  "function register(Key key)",
  "function update(bytes32 keyHash, uint256 settings)",
  "function revoke(bytes32 keyHash)",
  "function keyCount() view returns (uint256)",
  "function keyAt(uint256 i) view returns (Key)",
  "function isRegistered(bytes32 keyHash) view returns (bool)",
  "function getKeySettings(bytes32 keyHash) view returns (uint256)",
  "function getSeq(uint256 key) view returns (uint256)",
  "function approveNative(address spender, uint256 amount) returns (bool)",
  "function nativeAllowance(address spender) view returns (uint256)",
]);

/** `AgentPolicyHook` (`contracts/src/interfaces/IAgentPolicyHook.sol`). */
export const agentPolicyHookAbi = parseAbi([
  "struct QuoteLimit { address token; uint256 totalCap; uint256 periodCap; }",
  "struct CallPermission { address target; bytes4 selector; uint8 ruleKind; }",
  "struct Policy { uint256 maxValuePerCall; QuoteLimit mntLimit; QuoteLimit[] quoteLimits; uint32 periodLength; CallPermission[] permissions; address[] trustedSpenders; uint32 maxDeadlineWindow; }",
  "struct Summary { bool initialized; bool active; bool revoked; }",
  "function setPolicy(bytes32 keyHash, Policy policy)",
  "function updatePolicy(bytes32 keyHash, Policy policy)",
  "function revoke(bytes32 keyHash)",
  "function releaseInventory(bytes32 keyHash, address token, uint256 amount)",
  "function getSummary(bytes32 keyHash, address account) view returns (Summary)",
  "function getPolicy(bytes32 keyHash, address account) view returns (Policy, uint40)",
  "function remainingLimit(bytes32 keyHash, address account, address token) view returns (uint256)",
  "function inventory(bytes32 keyHash, address account, address token) view returns (uint256)",
  "function reserved(address account, address token) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const launchpadAbi = parseAbi([
  "function buy(address token, uint256 amountIn, uint256 minOut, uint256 deadline, address recipient) returns (uint256)",
  "function sell(address token, uint256 amount, uint256 minOut, uint256 deadline, address recipient) returns (uint256)",
]);
