// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {SignedBatchedCall, SignedBatchedCallLib} from "calibur/libraries/SignedBatchedCallLib.sol";
import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {SpikeTarget} from "../../src/spike/SpikeTarget.sol";
import {SpikeBase} from "./SpikeBase.sol";

/// @notice Relayer path (DESIGN §7.1 / §7.2) on Mantle Sepolia. The broadcasting key is the
///         relayer (the SignedBatchedCall `executor`); the root and the session key only sign.
/// Env: ROOT_PRIVATE_KEY, SESSION_PRIVATE_KEY, SPIKE_CALIBUR, SPIKE_HOOK, SPIKE_TARGET.
contract SpikeRelayer is SpikeBase {
    /// @notice Type-4 transaction: the root's authorization (delegate = CaliburEntry,
    ///         chainId 5003) plus a root SignedBatchedCall that registers the session key,
    ///         attaches the hook with an expiry and sets its policy.
    function grant() external {
        _requireMantleSepolia();
        uint256 rootPk = vm.envUint("ROOT_PRIVATE_KEY");
        address root = vm.addr(rootPk);
        address session = vm.addr(vm.envUint("SESSION_PRIVATE_KEY"));
        address calibur = vm.envAddress("SPIKE_CALIBUR");
        require(root.code.length == 0, "root already delegated");

        Call[] memory calls = _grantCalls(root, session);
        SignedBatchedCall memory sbc = SignedBatchedCall({
            batchedCall: BatchedCall(calls, true),
            nonce: 0, // root lane 0, sequence 0 (fresh account)
            keyHash: bytes32(0),
            executor: msg.sender,
            deadline: block.timestamp + 10 minutes
        });
        bytes memory sig = _sign(rootPk, _caliburDigest(root, calibur, sbc));

        vm.startBroadcast();
        vm.signAndAttachDelegation(calibur, rootPk);
        ICalibur(root).execute(sbc, abi.encode(sig, bytes("")));
        vm.stopBroadcast();

        require(
            keccak256(root.code) == keccak256(abi.encodePacked(hex"ef0100", calibur)), "delegation"
        );
        bytes32 keyHash = _keyHash(session);
        require(
            AgentPolicyHook(vm.envAddress("SPIKE_HOOK")).getSummary(keyHash, root).active,
            "session not active"
        );
        console.log("SPIKE_ROOT=%s", root);
        console.log("SPIKE_KEY_HASH=%s", vm.toString(keyHash));
    }

    /// @notice A session SignedBatchedCall on the session's nonce lane: `SpikeTarget.ping(tag)`.
    function sessionCall(uint256 tag) external {
        _requireMantleSepolia();
        uint256 sessionPk = vm.envUint("SESSION_PRIVATE_KEY");
        address root = vm.addr(vm.envUint("ROOT_PRIVATE_KEY"));
        address calibur = vm.envAddress("SPIKE_CALIBUR");
        address target = vm.envAddress("SPIKE_TARGET");
        bytes32 keyHash = _keyHash(vm.addr(sessionPk));
        uint192 lane = _lane(keyHash);

        Call[] memory calls = new Call[](1);
        calls[0] = Call(target, 0, abi.encodeCall(SpikeTarget.ping, (tag)));
        SignedBatchedCall memory sbc = SignedBatchedCall({
            batchedCall: BatchedCall(calls, true),
            nonce: (uint256(lane) << 64) | ICalibur(root).getSeq(lane),
            keyHash: keyHash,
            executor: msg.sender,
            deadline: block.timestamp + 2 minutes
        });
        bytes32 digest = _caliburDigest(root, calibur, sbc);
        // The offline domain (used for the grant, before delegation) matches the account's own.
        require(
            digest == ICalibur(root).hashTypedData(SignedBatchedCallLib.hash(sbc)),
            "offline digest != on-chain digest"
        );
        bytes memory sig = _sign(sessionPk, digest);

        vm.startBroadcast();
        ICalibur(root).execute(sbc, abi.encode(sig, bytes("")));
        vm.stopBroadcast();
    }
}
