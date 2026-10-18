// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {CaliburEntry} from "calibur/CaliburEntry.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {PackedUserOperation} from "calibur/interfaces/IValidationHook.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {Settings} from "calibur/libraries/SettingsLib.sol";
import {SignedBatchedCall, SignedBatchedCallLib} from "calibur/libraries/SignedBatchedCallLib.sol";
import {Static} from "calibur/libraries/Static.sol";
import {IAgentPolicyHook} from "../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {AgentPolicyHookTestBase} from "./hook/AgentPolicyHookTestBase.sol";

/// @notice Smoke test through a real CaliburEntry v1.1.0 delegated from an EOA: confirms the hook
///         callback signatures, `msg.sender` = account, and the hook rules on the direct, ERC-7821,
///         SignedBatchedCall and validateUserOp entries. The full entry-point matrix is out of scope.
contract AgentPolicyHookCaliburTest is AgentPolicyHookTestBase {
    uint256 internal constant ROOT_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xA6E47;
    address internal root;
    address internal agent;
    address internal relayer = makeAddr("relayer");
    bytes32 internal keyHash;
    CaliburEntry internal account;

    function setUp() public override {
        super.setUp();
        root = vm.addr(ROOT_PK);
        agent = vm.addr(AGENT_PK);
        CaliburEntry impl = new CaliburEntry();
        vm.etch(root, bytes.concat(hex"ef0100", abi.encodePacked(address(impl))));
        account = CaliburEntry(payable(root));
        usd.mint(root, 10_000e18);

        Key memory key = Key(KeyType.Secp256k1, abi.encode(agent));
        keyHash = keccak256(abi.encode(key.keyType, keccak256(key.publicKey)));
        uint256 expiry = block.timestamp + 1 days;
        Settings settings = Settings.wrap(uint256(uint160(address(hook))) | (expiry << 160));

        Call[] memory calls = new Call[](3);
        calls[0] = Call(root, 0, abi.encodeCall(IKeyManagement.register, (key)));
        calls[1] = Call(root, 0, abi.encodeCall(IKeyManagement.update, (keyHash, settings)));
        calls[2] = Call(
            address(hook), 0, abi.encodeCall(IAgentPolicyHook.setPolicy, (keyHash, defaultPolicy()))
        );
        vm.prank(root);
        account.execute(BatchedCall(calls, true));
        assertTrue(hook.getSummary(keyHash, root).active);
    }

    function _agentExec(Call[] memory calls, bool revertOnFailure) internal {
        vm.prank(agent);
        account.execute(BatchedCall(calls, revertOnFailure));
    }

    function _buyCalls(uint256 amount) internal view returns (Call[] memory calls) {
        calls = new Call[](2);
        calls[0] = Call(address(usd), 0, abi.encodeCall(IERC20.approve, (address(pad), amount)));
        calls[1] = Call(
            address(pad),
            0,
            abi.encodeCall(ILaunchpad.buy, (address(meme), amount, 0, block.timestamp + 60, root))
        );
    }

    function _one(address to, bytes memory data) internal pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call(to, 0, data);
    }

    function test_directExecute_approveBuySell() public {
        _agentExec(_buyCalls(100e18), true);
        assertEq(hook.inventory(keyHash, root, address(meme)), 100e18);
        assertEq(hook.getSpent(keyHash, root, address(usd)).total, 100e18);
        _agentExec(
            _one(
                address(pad),
                abi.encodeCall(ILaunchpad.sell, (address(meme), 100e18, 0, block.timestamp, root))
            ),
            true
        );
        assertEq(hook.inventory(keyHash, root, address(meme)), 0);
        assertEq(meme.balanceOf(root), 0);
    }

    function test_directExecute_rejectsTargetIsHook() public {
        Call[] memory calls =
            _one(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (bytes32(0))));
        vm.expectRevert(err(IAgentPolicyHook.TargetIsHook.selector));
        _agentExec(calls, true);
    }

    function test_directExecute_failedCallRevertsEvenWithRevertOnFailureFalse() public {
        Call[] memory calls = _one(address(cb), abi.encodeWithSignature("fail()"));
        vm.expectRevert(err(IAgentPolicyHook.CallFailed.selector));
        _agentExec(calls, false);
    }

    function test_directExecute_rejectsSellBeyondInventory() public {
        meme.mint(root, 1_000e18); // the human's own position
        Call[] memory calls = _one(
            address(pad),
            abi.encodeCall(ILaunchpad.sell, (address(meme), 1, 0, block.timestamp, root))
        );
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.InventoryExceeded.selector, address(meme), 0)
        );
        _agentExec(calls, true);
    }

    function test_erc7821Execute_isHooked() public {
        Call[] memory calls = _one(address(usd), abi.encodeCall(IERC20.transfer, (bob, 401e18)));
        bytes32 mode = 0x0101000000000000000000000000000000000000000000000000000000000000;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        account.execute(mode, abi.encode(calls));
    }

    function test_signedBatchedCall_acceptedThenRejectedAfterRevoke() public {
        _relay(_one(bob, ""), 0, "");
        assertEq(hook.getSpent(keyHash, root, address(0)).total, 0);

        vm.prank(root);
        account.execute(
            BatchedCall(
                _one(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (keyHash))), true
            )
        );
        // The Calibur key is still registered and the signature is valid: the hook refuses it.
        _relay(_one(bob, ""), 1, err(IAgentPolicyHook.SessionInactive.selector));
    }

    function _relay(Call[] memory calls, uint256 nonce, bytes memory expectedRevert) internal {
        SignedBatchedCall memory sbc = SignedBatchedCall({
            batchedCall: BatchedCall(calls, true),
            nonce: nonce,
            keyHash: keyHash,
            executor: relayer,
            deadline: block.timestamp + 120
        });
        bytes32 digest = account.hashTypedData(SignedBatchedCallLib.hash(sbc));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);
        vm.prank(relayer);
        if (expectedRevert.length != 0) vm.expectRevert(expectedRevert);
        account.execute(sbc, abi.encode(abi.encodePacked(r, s, v), bytes("")));
    }

    function _userOp(address paymaster) internal view returns (PackedUserOperation memory op) {
        op.sender = root;
        op.callData = abi.encodeWithSelector(
            IAccountExecute.executeUserOp.selector, abi.encode(BatchedCall(_one(bob, ""), true))
        );
        op.paymasterAndData = abi.encodePacked(paymaster, uint128(100_000), uint128(50_000));
        bytes32 userOpHash = keccak256("userOpHash");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, userOpHash);
        op.signature = abi.encode(keyHash, abi.encodePacked(r, s, v), bytes(""));
    }

    function test_validateUserOp_ourPaymasterAccepted_readsOnlySummary() public {
        PackedUserOperation memory op = _userOp(PAYMASTER);
        vm.record();
        vm.prank(Static.ENTRY_POINT_V_0_8);
        uint256 validationData = account.validateUserOp(op, keccak256("userOpHash"), 0);
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(hook));
        assertEq(validationData, (block.timestamp + 1 days) << 160); // valid; expiry from Calibur
        assertEq(reads.length, 1);
        assertEq(reads[0], keccak256(abi.encode(root, keccak256(abi.encode(keyHash, uint256(0))))));
        assertEq(writes.length, 0);
    }

    function test_validateUserOp_wrongPaymasterReverts() public {
        PackedUserOperation memory op = _userOp(bob);
        vm.prank(Static.ENTRY_POINT_V_0_8);
        vm.expectRevert(err(IAgentPolicyHook.WrongPaymaster.selector));
        account.validateUserOp(op, keccak256("userOpHash"), 0);
    }

    function test_rootIsNotHooked() public {
        vm.prank(root);
        account.execute(
            BatchedCall(_one(address(usd), abi.encodeCall(IERC20.transfer, (bob, 5_000e18))), true)
        );
        assertEq(usd.balanceOf(bob), 5_000e18);
    }
}
