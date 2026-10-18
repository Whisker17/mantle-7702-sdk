// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {VerifyingPaymaster} from "../../src/VerifyingPaymaster.sol";

/// @notice Shared fixture: the v0.8.0 EntryPoint at its canonical address (Calibur hard-codes
///         it), a CaliburEntry v1.1.0 implementation and a VerifyingPaymaster bound to both.
abstract contract PaymasterTestBase is Test {
    address internal constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    uint256 internal constant SPONSOR_PK = 0x5905502;
    uint256 internal constant ROOT_PK = 0xA11CE;
    uint256 internal constant T0 = 1_700_000_000;
    uint128 internal constant PM_VERIFICATION_GAS = 100_000;
    uint128 internal constant PM_POSTOP_GAS = 0;

    IEntryPoint internal entryPoint;
    address internal calibur;
    address internal sponsor;
    address internal root;
    VerifyingPaymaster internal pm;

    function setUp() public virtual {
        vm.warp(T0);
        deployCodeTo("EntryPoint.sol:EntryPoint", ENTRY_POINT_V08);
        entryPoint = IEntryPoint(ENTRY_POINT_V08);
        calibur = deployCode("CaliburEntry.sol:CaliburEntry");
        sponsor = vm.addr(SPONSOR_PK);
        root = vm.addr(ROOT_PK);
        pm = new VerifyingPaymaster(entryPoint, sponsor, calibur);
    }

    function delegation(address impl) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"ef0100", impl);
    }

    /// @dev Sets `paymasterAndData` = paymaster ‖ gas limits ‖ (validUntil, validAfter) ‖
    ///      the sponsor's EIP-191 signature over `p.getHash`.
    function sponsorOp(
        PackedUserOperation memory op,
        VerifyingPaymaster p,
        uint48 validUntil,
        uint48 validAfter
    ) internal view {
        op.paymasterAndData = abi.encodePacked(
            address(p), PM_VERIFICATION_GAS, PM_POSTOP_GAS, abi.encode(validUntil, validAfter)
        );
        bytes32 digest =
            MessageHashUtils.toEthSignedMessageHash(p.getHash(op, validUntil, validAfter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SPONSOR_PK, digest);
        op.paymasterAndData = bytes.concat(op.paymasterAndData, abi.encodePacked(r, s, v));
    }
}
