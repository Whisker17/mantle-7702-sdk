// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {DeployHook} from "../../script/DeployHook.s.sol";

/// @notice The mined salt yields a CREATE2 address with all five hook flags, and the script
///         deploys the hook there with the book's paymaster.
contract DeployHookTest is Test {
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Runtime code of the CREATE2 deterministic deployer (Arachnid).
    bytes internal constant DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    DeployHook internal script = new DeployHook();

    function testFuzz_mineSaltSetsAllFlags(bytes32 initCodeHash) public view {
        (bytes32 salt, address hook) = script.mineSalt(initCodeHash);
        assertEq(uint160(hook) & 0x1f, 0x1f);
        assertEq(hook, vm.computeCreate2Address(salt, initCodeHash, DETERMINISTIC_DEPLOYER));
    }

    function test_runDeploysHookAtFlaggedAddress() public {
        vm.etch(DETERMINISTIC_DEPLOYER, DEPLOYER_CODE);
        address paymaster = makeAddr("paymaster");
        vm.etch(paymaster, hex"00");
        vm.setEnv(
            "ADDRESS_BOOK",
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"VerifyingPaymaster":{"address":"',
                vm.toString(paymaster),
                '"}}'
            )
        );

        (address hook,) = script.run();

        assertEq(uint160(hook) & 0x1f, 0x1f);
        assertGt(hook.code.length, 0);
        assertEq(AgentPolicyHook(hook).PAYMASTER(), paymaster);
    }
}
