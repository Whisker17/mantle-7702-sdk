// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {IERC7914} from "calibur/interfaces/IERC7914.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {INonceManager} from "calibur/interfaces/INonceManager.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {SignedBatchedCall} from "calibur/libraries/SignedBatchedCallLib.sol";
import {IAgentPolicyHook, Policy} from "../../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {CaliburSessionBase, NativePuller} from "../hook/CaliburSessionBase.sol";
import {CallbackTarget} from "../hook/HookTestHelpers.sol";

/// @notice DESIGN §4.1 entry-point matrix / §8 "Entry-point matrix": every applicable I1–I13
///         restriction, through a real CaliburEntry v1.1.0, on each execution entry:
///         `execute(BatchedCall)`, ERC-7821 `execute(mode, data)`, `execute(SignedBatchedCall)`
///         and `executeUserOp` executed by the real EntryPoint v0.8 `handleOps` (sponsored by the
///         VerifyingPaymaster), plus ERC-1271 `isValidSignature`.
/// @dev Each rejection is asserted with its exact revert data and without side effects, and is
///      paired with a control: the same calls succeed through CONTROL_PK, a key registered
///      without the hook, so the hook (not the target, Calibur or the fixture) is what rejects.
///      I10 (paymaster binding) is covered end to end by `VerifyingPaymasterE2ETest`
///      (`test_e2e_noPaymaster_rejected_accountPaysNothing`,
///      `test_e2e_otherPaymaster_rejected_accountPaysNothing`); I13 is a management-time rule,
///      entry-independent, covered in `D1MeteringAttackTest`. I6/I7 are SDK / script guards.
contract EntryPointMatrixTest is CaliburSessionBase {
    struct State {
        uint256 usdBalance;
        uint256 mntBalance;
        uint256 memeBalance;
        uint256 usdSpent;
        uint256 mntSpent;
        uint256 inventory;
        uint256 reserved;
        uint256 padAllowance;
        uint256 attackerAllowance;
        uint256 attackerUsd;
        uint256 attackerMnt;
    }

    /// @dev Calibur BaseAuthorization.Unauthorized().
    bytes4 internal constant UNAUTHORIZED = bytes4(keccak256("Unauthorized()"));

    bytes32 internal kh;

    function setUp() public override {
        super.setUp();
        kh = initAccount();
        grantControlKey();
    }

    function snapshot() internal view returns (State memory s) {
        s.usdBalance = usd.balanceOf(root);
        s.mntBalance = root.balance;
        s.memeBalance = IERC20(meme).balanceOf(root);
        s.usdSpent = hook.getSpent(kh, root, address(usd)).total;
        s.mntSpent = hook.getSpent(kh, root, address(0)).total;
        s.inventory = hook.inventory(kh, root, meme);
        s.reserved = hook.reserved(root, meme);
        s.padAllowance = usd.allowance(root, address(pad));
        s.attackerAllowance = usd.allowance(root, attacker);
        s.attackerUsd = usd.balanceOf(attacker);
        s.attackerMnt = attacker.balance;
    }

    function assertUnchanged(State memory a, string memory where) internal view {
        State memory b = snapshot();
        assertEq(b.usdBalance, a.usdBalance, where);
        assertEq(b.mntBalance, a.mntBalance, where);
        assertEq(b.memeBalance, a.memeBalance, where);
        assertEq(b.usdSpent, a.usdSpent, where);
        assertEq(b.mntSpent, a.mntSpent, where);
        assertEq(b.inventory, a.inventory, where);
        assertEq(b.reserved, a.reserved, where);
        assertEq(b.padAllowance, a.padAllowance, where);
        assertEq(b.attackerAllowance, a.attackerAllowance, where);
        assertEq(b.attackerUsd, a.attackerUsd, where);
        assertEq(b.attackerMnt, a.attackerMnt, where);
    }

    /// @dev `calls` by AGENT are rejected with exactly `expected` on every execution entry and
    ///      change nothing. Each entry runs from the same state.
    function assertRejectedOnEveryEntry(Call[] memory calls, bool rof, bytes memory expected)
        internal
    {
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            Entry e = Entry(i);
            uint256 snap = vm.snapshotState();
            State memory before = snapshot();
            (bool ok, bytes memory ret) = exec(e, AGENT_PK, calls, rof);
            assertFalse(ok, entryName(e));
            assertEq(ret, expected, entryName(e));
            assertUnchanged(before, entryName(e));
            vm.revertToState(snap);
        }
    }

    function assertRejectedOnEveryEntry(Call[] memory calls, bytes memory expected) internal {
        assertRejectedOnEveryEntry(calls, true, expected);
    }

    /// @dev Control: the same calls go through when the key has no hook.
    function assertControlSucceeds(Call[] memory calls, bool rof) internal {
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = exec(Entry.Direct, CONTROL_PK, calls, rof);
        assertTrue(ok, vm.toString(ret));
        vm.revertToState(snap);
    }

    function assertControlSucceeds(Call[] memory calls) internal {
        assertControlSucceeds(calls, true);
    }

    function humanBuysMeme() internal {
        rootExec(approveAndBuy(meme, HUMAN_MEME / pad.RATE()));
        assertEq(IERC20(meme).balanceOf(root), HUMAN_MEME);
    }

    // ---------------------------------------------------------------------------------------
    // Positive baseline: the allowed path executes and is metered identically on every entry
    // ---------------------------------------------------------------------------------------

    function test_matrix_allowedBatch_executesAndIsMeteredOnEveryEntry() public {
        Call[] memory calls = new Call[](3);
        calls[0] = approveCall(address(pad), 10e6);
        calls[1] = buyCall(meme, 10e6);
        calls[2] = Call(bob, 1 ether, "");
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            Entry e = Entry(i);
            uint256 snap = vm.snapshotState();
            uint256 mntBefore = root.balance;
            (bool ok, bytes memory ret) = exec(e, AGENT_PK, calls);
            assertTrue(ok, string.concat(entryName(e), ": ", vm.toString(ret)));
            assertEq(usd.balanceOf(root), 10_000e6 - 10e6, entryName(e));
            assertEq(hook.getSpent(kh, root, address(usd)).total, 10e6, entryName(e));
            assertEq(hook.getSpent(kh, root, address(0)).total, 1 ether, entryName(e));
            assertEq(root.balance, mntBefore - 1 ether, entryName(e)); // gas is sponsored
            assertEq(hook.inventory(kh, root, meme), 10e6 * pad.RATE(), entryName(e));
            assertEq(hook.reserved(root, meme), 10e6 * pad.RATE(), entryName(e));
            vm.revertToState(snap);
        }
    }

    // ---------------------------------------------------------------------------------------
    // I1: no (target, selector) outside `permissions`
    // ---------------------------------------------------------------------------------------

    function test_matrix_I1_selectorOutsidePermissionsOnPermittedTarget() public {
        Call[] memory calls = one(address(usd), 0, abi.encodeCall(IERC20.transfer, (attacker, 1e6)));
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls,
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector, address(usd), IERC20.transfer.selector
            )
        );

        calls = one(address(pad), 0, abi.encodeCall(pad.createToken, ("Evil", "EVIL")));
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls,
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector, address(pad), pad.createToken.selector
            )
        );
    }

    function test_matrix_I1_targetOutsidePermissions() public {
        Call[] memory calls = one(attacker, 0, "");
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls,
            abi.encodeWithSelector(IAgentPolicyHook.CallNotPermitted.selector, attacker, bytes4(0))
        );

        // A selector permitted on one target, called on another instance of the same contract.
        address otherPad = address(new CallbackTarget());
        calls = one(otherPad, 0, abi.encodeCall(CallbackTarget.fail, ()));
        assertRejectedOnEveryEntry(
            calls,
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector, otherPad, CallbackTarget.fail.selector
            )
        );
    }

    // ---------------------------------------------------------------------------------------
    // I2: quote-asset net outflow within the total / period caps; MNT metered by value
    // ---------------------------------------------------------------------------------------

    function test_matrix_I2_approveAboveRemainingLimit() public {
        Call[] memory calls = one(approveCall(address(pad), 50e6 + 1));
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
    }

    /// @dev §8 "over-limit buy": the root left a standing allowance to the launchpad, so the buy
    ///      needs no approve and only the outflow metering stops it.
    function test_matrix_I2_buyAboveLimitThroughRootStandingAllowance() public {
        rootExec1(address(usd), abi.encodeCall(IERC20.approve, (address(pad), type(uint256).max)));
        Call[] memory calls = one(buyCall(meme, 50e6 + 1));
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
    }

    function test_matrix_I2_outflowThroughAllowlistedTargetAboveLimit() public {
        Call[] memory calls = one(pullCall(50e6 + 1, attacker));
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
    }

    function test_matrix_I2_mntAboveMaxValuePerCall() public {
        Call[] memory calls = one(bob, 1 ether + 1, "");
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls,
            abi.encodeWithSelector(IAgentPolicyHook.ValueExceeded.selector, 1 ether + 1, 1 ether)
        );
    }

    function test_matrix_I2_mntAbovePeriodCap() public {
        Call[] memory calls = new Call[](3);
        for (uint256 i; i < 3; ++i) {
            calls[i] = Call(bob, 1 ether, "");
        }
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(0))
        );
    }

    // ---------------------------------------------------------------------------------------
    // I3: no policy change by a session
    // ---------------------------------------------------------------------------------------

    function test_matrix_I3_targetIsHook() public {
        Policy memory raised = sessionPolicy();
        raised.quoteLimits[0].totalCap = type(uint128).max;
        bytes[4] memory datas = [
            abi.encodeCall(IAgentPolicyHook.updatePolicy, (kh, raised)),
            abi.encodeCall(IAgentPolicyHook.setPolicy, (keyHashOf(0xBAD), raised)),
            abi.encodeCall(IAgentPolicyHook.revoke, (keyHashOf(AGENT2_PK))),
            abi.encodeCall(IAgentPolicyHook.releaseInventory, (kh, meme, 0))
        ];
        for (uint256 i; i < datas.length; ++i) {
            assertRejectedOnEveryEntry(
                one(address(hook), 0, datas[i]), err(IAgentPolicyHook.TargetIsHook.selector)
            );
        }
        // Control: without the hook a non-admin key can write this account's hook state.
        assertControlSucceeds(one(address(hook), 0, datas[1]));
    }

    function test_matrix_I3_selfCallRejectedByCalibur() public {
        Key memory key = Key(KeyType.Secp256k1, abi.encode(attacker));
        bytes[5] memory datas = [
            abi.encodeCall(IKeyManagement.register, (key)),
            abi.encodeCall(IKeyManagement.update, (kh, settingsFor(address(0), 0))),
            abi.encodeCall(IERC7914.approveNative, (attacker, type(uint256).max)),
            abi.encodeCall(INonceManager.invalidateNonce, (uint256(1) << 64 | 5)),
            abi.encodeCall(IKeyManagement.revoke, (keyHashOf(AGENT2_PK)))
        ];
        for (uint256 i; i < datas.length; ++i) {
            assertRejectedOnEveryEntry(
                one(root, 0, datas[i]), err(IKeyManagement.OnlyAdminCanSelfCall.selector)
            );
            // ERC-7821: address(0) means the account itself.
            assertRejectedOnEveryEntry(
                one(address(0), 0, datas[i]), err(IKeyManagement.OnlyAdminCanSelfCall.selector)
            );
        }
    }

    function test_matrix_I3_entryPointCallRejectedByCalibur() public {
        assertRejectedOnEveryEntry(
            one(
                address(entryPoint),
                0,
                abi.encodeCall(IStakeManager.withdrawTo, (payable(attacker), 0))
            ),
            err(IKeyManagement.OnlyAdminCanCallEntryPoint.selector)
        );
    }

    // ---------------------------------------------------------------------------------------
    // I4: no ERC-1271 signature from a session key
    // ---------------------------------------------------------------------------------------

    function test_matrix_I4_erc1271_sessionSignatureRejected() public view {
        bytes32 digest = keccak256("permit2 order");
        (bool ok, bytes memory ret) = session1271(AGENT_PK, digest);
        assertFalse(ok);
        assertEq(ret, err(IAgentPolicyHook.SessionKeySignatureRejected.selector));

        // Control: the same construction from the unhooked key is a valid signature.
        (ok,) = session1271(CONTROL_PK, digest);
        assertTrue(ok);
        // And the root's raw signature stays valid.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ROOT_PK, digest);
        assertEq(account.isValidSignature(digest, abi.encodePacked(r, s, v)), MAGIC_1271);
    }

    // ---------------------------------------------------------------------------------------
    // I5: approve only trusted spenders, exact amount within the remaining limit
    // ---------------------------------------------------------------------------------------

    function test_matrix_I5_approveUntrustedSpender() public {
        Call[] memory calls = one(approveCall(attacker, 1e6));
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.UntrustedSpender.selector, attacker)
        );
    }

    function test_matrix_I5_incrementalApproval() public {
        bytes4 sel = bytes4(keccak256("increaseAllowance(address,uint256)"));
        assertRejectedOnEveryEntry(
            one(address(usd), 0, abi.encodeWithSelector(sel, address(pad), 1e6)),
            abi.encodeWithSelector(IAgentPolicyHook.CallNotPermitted.selector, address(usd), sel)
        );
    }

    // ---------------------------------------------------------------------------------------
    // I8: no native MNT through ERC-7914 (init batch revoked ERC20ETH's default allowance)
    // ---------------------------------------------------------------------------------------

    function test_matrix_I8_nativePullByAllowlistedErc20Eth() public {
        bytes memory inner = err(IERC7914.AllowanceExceeded.selector);
        assertEq(account.nativeAllowance(ERC20ETH), 0);
        assertRejectedOnEveryEntry(
            one(nativePullCall(1 ether)), err(IAgentPolicyHook.CallFailed.selector)
        );
        assertRejectedOnEveryEntry(
            one(nativePullCall(1 ether)), false, err(IAgentPolicyHook.CallFailed.selector)
        );
        // Through a second allowlisted hop the puller is not ERC20ETH: allowance 0 by default.
        bytes memory viaCb = abi.encodeCall(
            CallbackTarget.run,
            (ERC20ETH, abi.encodeCall(NativePuller.pull, (root, attacker, 1 ether)))
        );
        assertRejectedOnEveryEntry(
            one(address(cb), 0, viaCb), err(IAgentPolicyHook.CallFailed.selector)
        );
        // The underlying failure is the ERC-7914 allowance, also for an unhooked key.
        vm.prank(ERC20ETH);
        vm.expectRevert(inner);
        IERC7914(root).transferFromNative(root, attacker, 1);
    }

    // ---------------------------------------------------------------------------------------
    // I9: SELL only the session's own attributed inventory; fail closed on a gap
    // ---------------------------------------------------------------------------------------

    function test_matrix_I9_sellHumansPriorHoldings() public {
        humanBuysMeme();
        Call[] memory calls = one(sellCall(meme, 1));
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.InventoryExceeded.selector, meme, 0)
        );
    }

    function test_matrix_I9_sellBeyondOwnInventory() public {
        humanBuysMeme();
        (bool ok,) = exec(Entry.Direct, AGENT_PK, approveAndBuy(meme, 10e6));
        assertTrue(ok);
        uint256 held = 10e6 * pad.RATE();
        assertRejectedOnEveryEntry(
            one(sellCall(meme, held + 1)),
            abi.encodeWithSelector(IAgentPolicyHook.InventoryExceeded.selector, meme, held)
        );
    }

    function test_matrix_I9_sellFailsClosedOnAttributionGap() public {
        humanBuysMeme();
        (bool ok,) = exec(Entry.Direct, AGENT_PK, approveAndBuy(meme, 10e6));
        assertTrue(ok);
        // The root disposes of everything without a release tuple: balance < reserved.
        rootExec1(meme, abi.encodeCall(IERC20.transfer, (bob, IERC20(meme).balanceOf(root))));
        assertRejectedOnEveryEntry(
            one(sellCall(meme, 1)),
            abi.encodeWithSelector(IAgentPolicyHook.AttributionGap.selector, meme)
        );
    }

    // ---------------------------------------------------------------------------------------
    // §8 overreach: deadline out of range, recipient ≠ self, expired key
    // ---------------------------------------------------------------------------------------

    function test_matrix_deadlineOutOfRange() public {
        uint256[2] memory deadlines = [block.timestamp + 601, block.timestamp - 1];
        for (uint256 i; i < 2; ++i) {
            Call[] memory calls = two(
                approveCall(address(pad), 1e6),
                Call(
                    address(pad),
                    0,
                    abi.encodeCall(ILaunchpad.buy, (meme, 1e6, 0, deadlines[i], root))
                )
            );
            if (i == 0) assertControlSucceeds(calls); // the launchpad itself accepts it
            assertRejectedOnEveryEntry(
                calls,
                abi.encodeWithSelector(IAgentPolicyHook.DeadlineOutOfRange.selector, deadlines[i])
            );
        }
    }

    function test_matrix_recipientNotSelf() public {
        Call[] memory calls = two(
            approveCall(address(pad), 1e6),
            Call(
                address(pad),
                0,
                abi.encodeCall(ILaunchpad.buy, (meme, 1e6, 0, block.timestamp + 60, attacker))
            )
        );
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.RecipientNotAccount.selector, attacker)
        );

        (bool ok,) = exec(Entry.Direct, AGENT_PK, approveAndBuy(meme, 10e6));
        assertTrue(ok);
        calls = one(
            address(pad),
            0,
            abi.encodeCall(ILaunchpad.sell, (meme, 1e18, 0, block.timestamp + 60, attacker))
        );
        assertControlSucceeds(calls);
        assertRejectedOnEveryEntry(
            calls, abi.encodeWithSelector(IAgentPolicyHook.RecipientNotAccount.selector, attacker)
        );
    }

    /// @dev Calibur Settings are the only source of expiry (DESIGN §4.1).
    function test_matrix_expiredKey() public {
        vm.warp(uint256(expiry) + 1);
        Call[] memory calls = one(bob, 0, "");
        bytes[4] memory expected = [
            err(UNAUTHORIZED),
            err(UNAUTHORIZED),
            abi.encodeWithSelector(IKeyManagement.KeyExpired.selector, expiry),
            failedOp("AA22 expired or not due")
        ];
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            (bool ok, bytes memory ret) = exec(Entry(i), AGENT_PK, calls);
            assertFalse(ok, entryName(Entry(i)));
            assertEq(ret, expected[i], entryName(Entry(i)));
        }
        (bool ok1271, bytes memory ret1271) = session1271(AGENT_PK, keccak256("m"));
        assertFalse(ok1271);
        assertEq(ret1271, abi.encodeWithSelector(IKeyManagement.KeyExpired.selector, expiry));
    }

    // ---------------------------------------------------------------------------------------
    // I11: a revoked keyHash never executes again, even while Calibur still accepts it
    // ---------------------------------------------------------------------------------------

    function test_matrix_I11_hookTombstone_rejectsOnEveryEntry() public {
        // Only the hook tombstone: the Calibur key stays registered and its signatures verify.
        rootExec1(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (kh)));
        assertTrue(account.isRegistered(kh));
        assertRevokedEverywhere();
    }

    function test_matrix_I11_reRegisteredAfterFullRevoke_staysDead() public {
        address[] memory spenders = new address[](1);
        spenders[0] = address(pad);
        rootExec(revokeCalls(kh, spenders));
        // The root re-registers the same key with the hook: the hook refuses a new policy...
        Call[] memory regrant = grantCalls(AGENT_PK, sessionPolicy(), expiry);
        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICalibur.CallFailed.selector, err(IAgentPolicyHook.SessionRevoked.selector)
            )
        );
        account.execute(BatchedCall(regrant, true));
        // ...and with only the Calibur part re-done, the key is registered but dead.
        Call[] memory caliburOnly = new Call[](2);
        caliburOnly[0] = regrant[0];
        caliburOnly[1] = regrant[1];
        rootExec(caliburOnly);
        assertTrue(account.isRegistered(kh));
        assertRevokedEverywhere();
    }

    function assertRevokedEverywhere() internal {
        Call[] memory calls = one(bob, 0, "");
        bytes memory inactive = err(IAgentPolicyHook.SessionInactive.selector);
        bytes[4] memory expected =
            [inactive, inactive, inactive, failedOpWithRevert("AA23 reverted", inactive)];
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            (bool ok, bytes memory ret) = exec(Entry(i), AGENT_PK, calls);
            assertFalse(ok, entryName(Entry(i)));
            assertEq(ret, expected[i], entryName(Entry(i)));
        }
        (bool ok1271,) = session1271(AGENT_PK, keccak256("m"));
        assertFalse(ok1271);
    }

    // ---------------------------------------------------------------------------------------
    // I12: a failed target or a re-entry reverts everything
    // ---------------------------------------------------------------------------------------

    function test_matrix_I12_failedCallRevertsEvenWithRevertOnFailureFalse() public {
        Call[] memory calls =
            two(pullCall(10e6, bob), Call(address(cb), 0, abi.encodeCall(CallbackTarget.fail, ())));
        // Control: an unhooked key's batch tolerates the failure and the pull goes through.
        assertControlSucceeds(calls, false);
        assertRejectedOnEveryEntry(calls, false, err(IAgentPolicyHook.CallFailed.selector));
        assertRejectedOnEveryEntry(calls, true, err(IAgentPolicyHook.CallFailed.selector));
    }

    /// @dev An allowlisted target re-enters the account with a relayable batch (same key or
    ///      another key) while the first call is executing. `tryRun` swallows the inner failure,
    ///      so the outer batch succeeds and the inner one must have done nothing.
    function test_matrix_I12_reentryThroughAllowlistedTarget() public {
        grant(AGENT2_PK, sessionPolicy());
        uint256[2] memory innerKeys = [AGENT_PK, AGENT2_PK];
        for (uint256 k; k < 2; ++k) {
            bytes32 innerKh = keyHashOf(innerKeys[k]);
            (SignedBatchedCall memory sbc, bytes memory sig) = signedBatch(
                innerKeys[k],
                innerKh,
                one(pullCall(10e6, attacker)),
                true,
                laneOf(innerKh) + 1, // another lane than any outer batch
                address(cb)
            );
            bytes memory reenter = abi.encodeCall(
                CallbackTarget.tryRun, (root, abi.encodeWithSignature(SIGNED_EXECUTE, sbc, sig))
            );
            for (uint256 i; i < ENTRY_COUNT; ++i) {
                uint256 snap = vm.snapshotState();
                (bool ok, bytes memory ret) = exec(Entry(i), AGENT_PK, one(address(cb), 0, reenter));
                assertTrue(ok, vm.toString(ret));
                assertEq(
                    cb.lastError(), err(IAgentPolicyHook.Reentrancy.selector), entryName(Entry(i))
                );
                assertEq(usd.balanceOf(attacker), 0, entryName(Entry(i)));
                assertEq(hook.getSpent(innerKh, root, address(usd)).total, 0, entryName(Entry(i)));
                vm.revertToState(snap);
            }
            // Control: outside an execution the same relayable batch is valid and executes.
            vm.prank(address(cb));
            account.execute(sbc, sig);
            assertEq(usd.balanceOf(attacker), 10e6);
            vm.prank(attacker);
            assertTrue(usd.transfer(bob, 10e6));
        }
    }

    string internal constant SIGNED_EXECUTE =
        "execute((((address,uint256,bytes)[],bool),uint256,bytes32,address,uint256),bytes)";
}
