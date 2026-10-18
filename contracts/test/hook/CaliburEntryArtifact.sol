// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// Compiles CaliburEntry (via-IR, because of its ERC7739 base) on its own so tests can deploy it
// with `deployCode("CaliburEntry.sol:CaliburEntry")`. Importing it next to the hook would also
// compile the hook and the mocks under via-IR, leaving two artifacts per contract.
import {CaliburEntry} from "calibur/CaliburEntry.sol";
