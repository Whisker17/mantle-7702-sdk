// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {VmSafe} from "forge-std/Vm.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IValidationHook, PackedUserOperation} from "calibur/interfaces/IValidationHook.sol";
import {IAgentPolicyHook} from "../src/interfaces/IAgentPolicyHook.sol";
import {AgentPolicyHookTestBase} from "./hook/AgentPolicyHookTestBase.sol";

/// @notice afterValidateUserOp, afterVerifySignature, afterIsValidSignature, and the
///         validation-time storage-access proof (reads only the Summary and calldata).
contract AgentPolicyHookValidationTest is AgentPolicyHookTestBase {
    function setUp() public override {
        super.setUp();
        grant(K1, defaultPolicy());
    }

    function userOp(bytes memory paymasterAndData, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = address(acct);
        op.callData = callData;
        op.paymasterAndData = paymasterAndData;
    }

    function goodOp() internal view returns (PackedUserOperation memory) {
        return userOp(
            abi.encodePacked(PAYMASTER, uint128(100_000), uint128(50_000), hex"c0ffee"),
            abi.encodeWithSelector(IAccountExecute.executeUserOp.selector, hex"1234")
        );
    }

    function validate(bytes32 keyHash, PackedUserOperation memory op) internal returns (bytes4) {
        vm.prank(address(acct));
        return hook.afterValidateUserOp(keyHash, op, bytes32(0), 0, "");
    }

    /// @dev ERC-7562 associated slot: keccak(account || keccak(keyHash || 0)) + 0.
    function summarySlot(bytes32 keyHash, address account) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, keccak256(abi.encode(keyHash, uint256(0)))));
    }

    // ---------------- afterValidateUserOp ----------------

    function test_validateUserOp_acceptsActiveKeyOurPaymasterExecuteUserOp() public {
        assertEq(validate(K1, goodOp()), IValidationHook.afterValidateUserOp.selector);
    }

    function test_validateUserOp_acceptsExactly20BytePaymasterField() public {
        PackedUserOperation memory op = goodOp();
        op.paymasterAndData = abi.encodePacked(PAYMASTER);
        assertEq(validate(K1, op), IValidationHook.afterValidateUserOp.selector);
    }

    function test_validateUserOp_rejectsUnknownKey() public {
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        validate(K2, goodOp());
    }

    function test_validateUserOp_rejectsRevokedKey() public {
        revokeKey(K1);
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        validate(K1, goodOp());
    }

    function test_validateUserOp_rejectsMissingPaymaster() public {
        PackedUserOperation memory op = goodOp();
        op.paymasterAndData = "";
        vm.expectRevert(err(IAgentPolicyHook.WrongPaymaster.selector));
        validate(K1, op);
    }

    function test_validateUserOp_rejectsShortPaymasterField() public {
        PackedUserOperation memory op = goodOp();
        op.paymasterAndData = abi.encodePacked(bytes19(bytes20(PAYMASTER)));
        vm.expectRevert(err(IAgentPolicyHook.WrongPaymaster.selector));
        validate(K1, op);
    }

    function test_validateUserOp_rejectsOtherPaymaster() public {
        PackedUserOperation memory op = goodOp();
        op.paymasterAndData = abi.encodePacked(bob, uint128(1), uint128(1));
        vm.expectRevert(err(IAgentPolicyHook.WrongPaymaster.selector));
        validate(K1, op);
    }

    function test_validateUserOp_rejectsShortCallData() public {
        PackedUserOperation memory op = goodOp();
        op.callData = abi.encodePacked(bytes3(IAccountExecute.executeUserOp.selector));
        vm.expectRevert(err(IAgentPolicyHook.WrongCallData.selector));
        validate(K1, op);
    }

    function test_validateUserOp_rejectsOtherSelector() public {
        PackedUserOperation memory op = goodOp();
        op.callData = abi.encodeWithSignature("execute(bytes32,bytes)", bytes32(0), "");
        vm.expectRevert(err(IAgentPolicyHook.WrongCallData.selector));
        validate(K1, op);
    }

    // ---------------- afterVerifySignature ----------------

    function test_verifySignature_acceptsActiveKey() public {
        vm.prank(address(acct));
        assertEq(
            hook.afterVerifySignature(K1, bytes32(0), ""),
            IValidationHook.afterVerifySignature.selector
        );
    }

    function test_verifySignature_rejectsUnknownKey() public {
        vm.prank(address(acct));
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        hook.afterVerifySignature(K2, bytes32(0), "");
    }

    function test_verifySignature_rejectsRevokedKey() public {
        revokeKey(K1);
        vm.prank(address(acct));
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        hook.afterVerifySignature(K1, bytes32(0), "");
    }

    // ---------------- afterIsValidSignature ----------------

    function test_isValidSignature_alwaysRejectsEvenActiveKey() public {
        vm.prank(address(acct));
        vm.expectRevert(err(IAgentPolicyHook.SessionKeySignatureRejected.selector));
        hook.afterIsValidSignature(K1, keccak256("permit"), "");
    }

    // ---------------- ERC-7562: reads only the Summary ----------------

    function test_summarySlotIsAccountAssociated() public view {
        // initialized (byte 0) and active (byte 1) set; revoked (byte 2) clear.
        assertEq(vm.load(address(hook), summarySlot(K1, address(acct))), bytes32(uint256(0x0101)));
    }

    function test_validateUserOp_readsOnlyTheSummarySlot() public {
        PackedUserOperation memory op = goodOp();
        vm.record();
        validate(K1, op);
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(hook));
        assertEq(reads.length, 1, "storage reads");
        assertEq(reads[0], summarySlot(K1, address(acct)), "slot");
        assertEq(writes.length, 0, "storage writes");
    }

    function test_validateUserOp_touchesNoOtherAccountOrStorage() public {
        PackedUserOperation memory op = goodOp();
        vm.startStateDiffRecording();
        validate(K1, op);
        assertOnlySummaryRead(vm.stopAndReturnStateDiff(), K1);
    }

    function test_validateUserOp_rejectionAlsoReadsOnlyTheSummary() public {
        PackedUserOperation memory op = goodOp();
        op.paymasterAndData = abi.encodePacked(bob);
        vm.startStateDiffRecording();
        vm.prank(address(acct));
        try hook.afterValidateUserOp(K1, op, bytes32(0), 0, "") {
            fail();
        } catch {}
        assertOnlySummaryRead(vm.stopAndReturnStateDiff(), K1);
    }

    function test_verifySignature_touchesNoOtherAccountOrStorage() public {
        vm.startStateDiffRecording();
        vm.prank(address(acct));
        hook.afterVerifySignature(K1, bytes32(0), "");
        assertOnlySummaryRead(vm.stopAndReturnStateDiff(), K1);
    }

    function test_validateUserOp_executesNoErc7562ForbiddenOpcode() public {
        PackedUserOperation memory op = goodOp();
        startOpcodeRecording();
        validate(K1, op);
        assertOpcodesValidationSafe(vm.stopAndReturnDebugTraceRecording(), K1);
    }

    function test_validateUserOp_rejectionExecutesNoErc7562ForbiddenOpcode() public {
        PackedUserOperation memory op = goodOp();
        op.callData = hex"deadbeef";
        startOpcodeRecording();
        vm.prank(address(acct));
        try hook.afterValidateUserOp(K1, op, bytes32(0), 0, "") {
            fail();
        } catch {}
        assertOpcodesValidationSafe(vm.stopAndReturnDebugTraceRecording(), K1);
    }

    function test_verifySignature_executesNoErc7562ForbiddenOpcode() public {
        startOpcodeRecording();
        vm.prank(address(acct));
        hook.afterVerifySignature(K1, bytes32(0), "");
        assertOpcodesValidationSafe(vm.stopAndReturnDebugTraceRecording(), K1);
    }

    /// @dev The debug tracer exists only at -vvv or above (CI runs `forge test -vvv`); without it
    ///      these opcode tests skip, and the storage-access tests above still apply.
    function startOpcodeRecording() internal {
        try vm.startDebugTraceRecording() {}
        catch {
            vm.skip(true, "opcode recording needs forge test -vvv");
        }
    }

    /// @dev Opcode-level check of every step executed in the hook's code: no environment reads
    ///      (TIMESTAMP, NUMBER, BALANCE, SELFBALANCE, ORIGIN, GASPRICE, COINBASE, …), no GAS, no
    ///      EXTCODE*, no calls or creates, no transient storage, no SSTORE; exactly one SLOAD, of the
    ///      Summary slot.
    function assertOpcodesValidationSafe(VmSafe.DebugStep[] memory steps, bytes32 keyHash)
        internal
        view
    {
        bytes memory forbidden = hex"31323a3b3c3f4041424344454748494a5a5c5d55f0f1f2f4f5faff";
        uint256 sloads;
        uint256 hookSteps;
        for (uint256 i; i < steps.length; ++i) {
            if (steps[i].contractAddr != address(hook)) continue;
            ++hookSteps;
            uint8 op = steps[i].opcode;
            for (uint256 j; j < forbidden.length; ++j) {
                assertTrue(
                    op != uint8(forbidden[j]),
                    string.concat(
                        "forbidden opcode ", vm.toString(op), " depth ", vm.toString(steps[i].depth)
                    )
                );
            }
            if (op == 0x54) {
                ++sloads;
                assertEq(
                    bytes32(steps[i].stack[0]), summarySlot(keyHash, address(acct)), "SLOAD slot"
                );
            }
        }
        assertGt(hookSteps, 0, "no hook steps recorded");
        assertEq(sloads, 1, "SLOAD count");
    }

    /// @dev Apart from the cheatcode call (`vm.prank`): exactly one account access (the static
    ///      call into the hook), so no balance / code reads of other accounts and no nested calls;
    ///      and one storage access: a read of the Summary slot.
    function assertOnlySummaryRead(VmSafe.AccountAccess[] memory accesses, bytes32 keyHash)
        internal
        view
    {
        uint256 n;
        VmSafe.AccountAccess memory a;
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].account == address(vm)) continue;
            a = accesses[i];
            ++n;
        }
        assertEq(n, 1, "account accesses");
        assertEq(a.account, address(hook), "accessed account");
        assertEq(a.accessor, address(acct), "caller");
        assertEq(uint256(a.kind), uint256(VmSafe.AccountAccessKind.StaticCall), "kind");
        assertEq(a.storageAccesses.length, 1, "storage accesses");
        assertEq(a.storageAccesses[0].slot, summarySlot(keyHash, address(acct)), "slot");
        assertFalse(a.storageAccesses[0].isWrite, "write");
    }
}
