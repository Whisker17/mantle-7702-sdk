// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MantleSepoliaForkTest} from "./MantleSepoliaForkTest.sol";

contract EntryPointForkTest is MantleSepoliaForkTest {
    function test_entryPointV08IsDeployed() public view {
        assertGt(ENTRY_POINT_V08.code.length, 0, "EntryPoint v0.8 has no code");
    }
}
