// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

/// @notice Base for tests that run against a Mantle Sepolia fork.
/// Forks from `MANTLE_SEPOLIA_RPC_URL`; every test of the inheriting contract is skipped
/// when the variable is unset.
abstract contract MantleSepoliaForkTest is Test {
    uint256 internal constant MANTLE_SEPOLIA_CHAIN_ID = 5003;
    address internal constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    function setUp() public virtual {
        string memory rpcUrl = vm.envOr("MANTLE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true, "MANTLE_SEPOLIA_RPC_URL is not set; skipping Mantle Sepolia fork test");
            return;
        }
        vm.createSelectFork(rpcUrl);
        assertEq(block.chainid, MANTLE_SEPOLIA_CHAIN_ID, "RPC is not Mantle Sepolia");
    }
}
