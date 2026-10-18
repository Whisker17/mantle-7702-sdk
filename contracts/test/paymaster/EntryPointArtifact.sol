// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// Compiles the eth-infinitism v0.8.0 EntryPoint so tests can place it at its canonical address
// with `deployCodeTo("EntryPoint.sol:EntryPoint", ENTRY_POINT_V08)`.
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
