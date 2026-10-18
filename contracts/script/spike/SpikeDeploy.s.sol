// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {SpikePaymaster} from "../../src/spike/SpikePaymaster.sol";
import {SpikeTarget} from "../../src/spike/SpikeTarget.sol";
import {SpikeBase} from "./SpikeBase.sol";

/// @notice Deploys the spike contracts on Mantle Sepolia from the broadcasting key:
///         CaliburEntry v1.1.0 (plain CREATE), SpikePaymaster (plain CREATE, funded deposit),
///         the real AgentPolicyHook through the CREATE2 deployer at a mined `…1f` address, and
///         SpikeTarget.
/// Env: PMSIGNER_ADDRESS (paymaster signer), PAYMASTER_DEPOSIT_WEI (default 0.3 MNT).
contract SpikeDeploy is SpikeBase {
    /// @dev Calibur's hook flags: all five low address bits set.
    uint160 internal constant ALL_HOOK_FLAGS = 0x1f;

    function run() external {
        _requireMantleSepolia();
        address signer = vm.envAddress("PMSIGNER_ADDRESS");
        uint256 deposit = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(0.3 ether));

        vm.startBroadcast();
        address calibur = deployCode("CaliburEntry.sol:CaliburEntry");
        SpikePaymaster paymaster = new SpikePaymaster(IEntryPoint(ENTRY_POINT_V08), calibur, signer);
        bytes32 salt = _mineHookSalt(address(paymaster));
        AgentPolicyHook hook = new AgentPolicyHook{salt: salt}(address(paymaster));
        SpikeTarget target = new SpikeTarget();
        paymaster.deposit{value: deposit}();
        vm.stopBroadcast();

        require(uint160(address(hook)) & ALL_HOOK_FLAGS == ALL_HOOK_FLAGS, "hook flags");
        require(hook.PAYMASTER() == address(paymaster), "hook paymaster");
        console.log("SPIKE_CALIBUR=%s", calibur);
        console.log("SPIKE_PAYMASTER=%s", address(paymaster));
        console.log("SPIKE_HOOK=%s", address(hook));
        console.log("SPIKE_HOOK_SALT=%s", vm.toString(salt));
        console.log("SPIKE_TARGET=%s", address(target));
    }

    /// @dev First salt whose CREATE2 address (through the deterministic deployer) carries all
    ///      five hook flags and has no code yet.
    function _mineHookSalt(address paymaster) internal view returns (bytes32 salt) {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(AgentPolicyHook).creationCode, abi.encode(paymaster)));
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            address at = vm.computeCreate2Address(salt, initCodeHash);
            if (uint160(at) & ALL_HOOK_FLAGS == ALL_HOOK_FLAGS && at.code.length == 0) return salt;
        }
    }
}
