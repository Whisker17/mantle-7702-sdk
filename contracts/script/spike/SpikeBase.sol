// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyLib, KeyType} from "calibur/libraries/KeyLib.sol";
import {Settings} from "calibur/libraries/SettingsLib.sol";
import {SignedBatchedCall, SignedBatchedCallLib} from "calibur/libraries/SignedBatchedCallLib.sol";
import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {CallPermission, Policy, RuleKind} from "../../src/interfaces/IAgentPolicyHook.sol";
import {SpikeTarget} from "../../src/spike/SpikeTarget.sol";

/// @notice Shared helpers for the Mantle Sepolia feasibility-spike scripts (throwaway).
abstract contract SpikeBase is Script {
    address internal constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    uint256 internal constant MANTLE_SEPOLIA_CHAIN_ID = 5003;

    /// @dev Calibur EIP-712 domain typehash (EIP712Domain with name, version, chainId,
    ///      verifyingContract, salt).
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
    );

    function _requireMantleSepolia() internal view {
        require(block.chainid == MANTLE_SEPOLIA_CHAIN_ID, "not Mantle Sepolia (5003)");
    }

    function _sessionKey(address signer) internal pure returns (Key memory) {
        return Key(KeyType.Secp256k1, abi.encode(signer));
    }

    function _keyHash(address signer) internal pure returns (bytes32) {
        return KeyLib.hash(_sessionKey(signer));
    }

    /// @dev DESIGN §4.1 nonce lane: `uint192(uint256(keyHash) >> 64)`; root lane is 0.
    function _lane(bytes32 keyHash) internal pure returns (uint192) {
        return uint192(uint256(keyHash) >> 64);
    }

    /// @dev Calibur's SignedBatchedCall digest for `account`, computed offline from the
    ///      implementation address (salt prefix 0), so it can be signed before delegation.
    function _caliburDigest(address account, address calibur, SignedBatchedCall memory sbc)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("Calibur"),
                keccak256("1.0.0"),
                block.chainid,
                account,
                bytes32(uint256(uint160(calibur)))
            )
        );
        return
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, SignedBatchedCallLib.hash(sbc)));
    }

    /// @dev Root management batch (DESIGN §7.1, without the ERC20ETH step): register the
    ///      session key, attach the hook (env SPIKE_HOOK) with a 7-day expiry, and set a policy
    ///      whose only permission is `SpikeTarget.ping` (env SPIKE_TARGET).
    function _grantCalls(address root, address session)
        internal
        view
        returns (Call[] memory calls)
    {
        AgentPolicyHook hook = AgentPolicyHook(vm.envAddress("SPIKE_HOOK"));
        bytes32 keyHash = _keyHash(session);
        uint256 expiry = block.timestamp + 7 days;
        Settings settings = Settings.wrap(uint256(uint160(address(hook))) | (expiry << 160));
        Policy memory policy;
        policy.permissions = new CallPermission[](1);
        policy.permissions[0] =
            CallPermission(vm.envAddress("SPIKE_TARGET"), SpikeTarget.ping.selector, RuleKind.NONE);

        calls = new Call[](3);
        calls[0] = Call(root, 0, abi.encodeCall(IKeyManagement.register, (_sessionKey(session))));
        calls[1] = Call(root, 0, abi.encodeCall(IKeyManagement.update, (keyHash, settings)));
        calls[2] = Call(address(hook), 0, abi.encodeCall(hook.setPolicy, (keyHash, policy)));
    }

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
