// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgentPolicyHook, Policy, Spent} from "../src/interfaces/IAgentPolicyHook.sol";
import {AgentPolicyHookTestBase} from "./hook/AgentPolicyHookTestBase.sol";
import {CallbackTarget, MiniAccount} from "./hook/HookTestHelpers.sol";

/// @notice beforeExecute steps 1–7 and afterExecute steps 1–5.
contract AgentPolicyHookExecuteTest is AgentPolicyHookTestBase {
    function setUp() public override {
        super.setUp();
        grant(K1, defaultPolicy());
    }

    // ---------------- before 1 / after 5: re-entrancy lock ----------------

    function test_lock_releasedAfterEachCall_sequentialCallsInOneTx() public {
        // The whole test runs in one transaction, so a lock left behind would block the next call.
        acct.exec1(K1, bob, 0.5 ether, "");
        acct.exec1(K1, bob, 0.5 ether, "");
        transferUsd(K1, 1e18);
        approveAndBuy(K1, address(meme), 10e18);
        assertEq(bob.balance, 1 ether);
    }

    function test_lock_rejectsReentrySameKey() public {
        bytes memory inner = abi.encodeCall(MiniAccount.exec1, (K1, bob, 0.5 ether, ""));
        // Propagated: the failed target makes the whole call revert.
        vm.expectRevert(err(IAgentPolicyHook.CallFailed.selector));
        acct.exec1(K1, address(cb), 0, abi.encodeCall(CallbackTarget.run, (address(acct), inner)));
        // Swallowed by the target: the nested call was still refused by the lock.
        acct.exec1(
            K1, address(cb), 0, abi.encodeCall(CallbackTarget.tryRun, (address(acct), inner))
        );
        assertEq(cb.lastError(), err(IAgentPolicyHook.Reentrancy.selector));
        assertEq(bob.balance, 0);
    }

    function test_lock_rejectsReentryOtherKey() public {
        grant(K2, defaultPolicy());
        bytes memory inner = abi.encodeCall(MiniAccount.exec1, (K2, bob, 0.5 ether, ""));
        acct.exec1(
            K1, address(cb), 0, abi.encodeCall(CallbackTarget.tryRun, (address(acct), inner))
        );
        assertEq(cb.lastError(), err(IAgentPolicyHook.Reentrancy.selector));
        assertEq(bob.balance, 0);
    }

    function test_afterExecute_rejectsWithoutBeforeExecute() public {
        vm.prank(address(acct));
        vm.expectRevert(err(IAgentPolicyHook.NotInExecution.selector));
        hook.afterExecute(K1, true, "", "");
    }

    // ---------------- before 2: summary.active ----------------

    function test_active_acceptsActiveKey() public {
        acct.exec1(K1, bob, 0, "");
    }

    function test_active_rejectsUnknownKey() public {
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        acct.exec1(K2, bob, 0, "");
    }

    function test_active_rejectsRevokedKey() public {
        revokeKey(K1);
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        acct.exec1(K1, bob, 0, "");
    }

    function test_active_isPerAccount() public {
        // Same keyHash, different account: the other account never granted it.
        MiniAccount other = new MiniAccount(acct.hook());
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        other.exec1(K1, bob, 0, "");
    }

    // ---------------- before 3: to == hook ----------------

    function test_targetIsHook_rejectedEvenIfPermitted() public {
        Policy memory p = defaultPolicy();
        p.permissions[3].target = address(hook);
        p.permissions[3].selector = IAgentPolicyHook.updatePolicy.selector;
        grant(K2, p);
        vm.expectRevert(err(IAgentPolicyHook.TargetIsHook.selector));
        acct.exec1(
            K2,
            address(hook),
            0,
            abi.encodeCall(IAgentPolicyHook.updatePolicy, (K2, defaultPolicy()))
        );
    }

    function test_targetIsHook_rejectsRevokeOfOwnTombstone() public {
        vm.expectRevert(err(IAgentPolicyHook.TargetIsHook.selector));
        acct.exec1(K1, address(hook), 0, abi.encodeCall(IAgentPolicyHook.revoke, (K1)));
    }

    // ---------------- before 4: permission match ----------------

    function test_permission_acceptsListedTargetAndSelector() public {
        transferUsd(K1, 1e18);
        assertEq(usd.balanceOf(bob), 1e18);
    }

    function test_permission_rejectsUnlistedSelectorOnListedTarget() public {
        bytes memory data = abi.encodeCall(IERC20.transferFrom, (address(acct), bob, 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector,
                address(usd),
                IERC20.transferFrom.selector
            )
        );
        acct.exec1(K1, address(usd), 0, data);
    }

    function test_permission_rejectsListedSelectorOnUnlistedTarget() public {
        bytes memory data = abi.encodeCall(IERC20.transfer, (bob, 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector, address(usdt), IERC20.transfer.selector
            )
        );
        acct.exec1(K1, address(usdt), 0, data);
    }

    function test_permission_emptyCalldataNeedsSelectorZeroPermission() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector, address(cb), bytes4(0)
            )
        );
        acct.exec1(K1, address(cb), 0, "");
    }

    function test_permission_rejectsIncreaseAllowance() public {
        bytes memory data =
            abi.encodeWithSelector(hook.INCREASE_ALLOWANCE_SELECTOR(), address(pad), uint256(1));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector,
                address(usd),
                hook.INCREASE_ALLOWANCE_SELECTOR()
            )
        );
        acct.exec1(K1, address(usd), 0, data);
    }

    // ---------------- before 5: value cap and MNT metering ----------------

    function test_value_acceptsAtMaxAndChargesExactly() public {
        acct.exec1(K1, bob, 1 ether, "");
        Spent memory s = hook.getSpent(K1, address(acct), address(0));
        assertEq(s.total, 1 ether);
        assertEq(s.period, 1 ether);
        assertEq(bob.balance, 1 ether);
    }

    function test_value_zeroValueChargesNothing() public {
        acct.exec1(K1, bob, 0, "");
        assertEq(hook.getSpent(K1, address(acct), address(0)).total, 0);
    }

    function test_value_rejectsAboveMaxValuePerCall() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.ValueExceeded.selector, 1 ether + 1, 1 ether)
        );
        acct.exec1(K1, bob, 1 ether + 1, "");
    }

    function test_mnt_rejectsOverPeriodCap() public {
        acct.exec1(K1, bob, 1 ether, "");
        acct.exec1(K1, bob, 1 ether, "");
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(0)));
        acct.exec1(K1, bob, 1, "");
    }

    function test_mnt_periodResetsInNextWindow_totalDoesNot() public {
        acct.exec1(K1, bob, 1 ether, "");
        acct.exec1(K1, bob, 1 ether, "");
        vm.warp(T0 + DAY);
        acct.exec1(K1, bob, 1 ether, "");
        assertEq(hook.getSpent(K1, address(acct), address(0)).total, 3 ether);
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(0)));
        acct.exec1(K1, bob, 1, "");
    }

    function test_mnt_refundDoesNotRestoreLimit() public {
        // The target sends the 1 MNT straight back; the key is still charged 1 MNT.
        bytes memory refund = abi.encodeCall(CallbackTarget.run, (address(acct), ""));
        acct.exec1(K1, address(cb), 1 ether, refund);
        assertEq(address(acct).balance, 100 ether);
        assertEq(hook.getSpent(K1, address(acct), address(0)).total, 1 ether);
    }

    function testFuzz_mnt_chargedExactlyByValue(uint256 value) public {
        value = bound(value, 1, 1 ether);
        acct.exec1(K1, bob, value, "");
        assertEq(hook.getSpent(K1, address(acct), address(0)).total, value);
        assertEq(hook.remainingLimit(K1, address(acct), address(0)), 2 ether - value);
    }

    // ---------------- before 6: ERC20_APPROVE ----------------

    function test_approve_acceptsExactRemainingToTrustedSpender() public {
        acct.exec1(K1, address(usd), 0, approveData(address(pad), 400e18));
        assertEq(usd.allowance(address(acct), address(pad)), 400e18);
    }

    function test_approve_rejectsAbovePeriodRemaining() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        acct.exec1(K1, address(usd), 0, approveData(address(pad), 400e18 + 1));
    }

    function test_approve_rejectsAboveTotalRemaining() public {
        Policy memory p = defaultPolicy();
        p.quoteLimits[0].totalCap = 300e18; // total remainder below the period cap
        grant(K2, p);
        acct.exec1(K2, address(usd), 0, approveData(address(pad), 300e18));
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        acct.exec1(K2, address(usd), 0, approveData(address(pad), 300e18 + 1));
    }

    function test_approve_remainingShrinksWithSpending() public {
        transferUsd(K1, 300e18);
        acct.exec1(K1, address(usd), 0, approveData(address(pad), 100e18));
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        acct.exec1(K1, address(usd), 0, approveData(address(pad), 100e18 + 1));
    }

    function test_approve_zeroAlwaysAllowedWhenExhausted() public {
        transferUsd(K1, 400e18);
        acct.exec1(K1, address(usd), 0, approveData(address(pad), 0));
    }

    function test_approve_rejectsUntrustedSpender() public {
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.UntrustedSpender.selector, bob));
        acct.exec1(K1, address(usd), 0, approveData(bob, 1));
    }

    // ---------------- before 6: LAUNCHPAD_BUY ----------------

    function test_buy_acceptsRecipientSelfAndDeadlineBounds() public {
        acct.exec1(K1, address(usd), 0, approveData(address(pad), 20e18));
        bytes memory atNow =
            abi.encodeCall(pad.buy, (address(meme), 10e18, 0, block.timestamp, address(acct)));
        acct.exec1(K1, address(pad), 0, atNow);
        bytes memory atMax = abi.encodeCall(
            pad.buy, (address(meme), 10e18, 0, block.timestamp + 600, address(acct))
        );
        acct.exec1(K1, address(pad), 0, atMax);
        assertEq(hook.inventory(K1, address(acct), address(meme)), 20e18);
    }

    function test_buy_rejectsOtherRecipient() public {
        bytes memory data = abi.encodeCall(pad.buy, (address(meme), 1, 0, block.timestamp, bob));
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.RecipientNotAccount.selector, bob));
        acct.exec1(K1, address(pad), 0, data);
    }

    function test_buy_rejectsPastDeadline() public {
        uint256 d = block.timestamp - 1;
        bytes memory data = abi.encodeCall(pad.buy, (address(meme), 1, 0, d, address(acct)));
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.DeadlineOutOfRange.selector, d));
        acct.exec1(K1, address(pad), 0, data);
    }

    function test_buy_rejectsDeadlineBeyondWindow() public {
        uint256 d = block.timestamp + 601;
        bytes memory data = abi.encodeCall(pad.buy, (address(meme), 1, 0, d, address(acct)));
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.DeadlineOutOfRange.selector, d));
        acct.exec1(K1, address(pad), 0, data);
    }

    function test_buy_rejectsQuoteAssetAsToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.QuoteAssetNotTradable.selector, address(usd))
        );
        acct.exec1(K1, address(pad), 0, buyData(address(usd), 1));
    }

    // ---------------- before 6: LAUNCHPAD_SELL ----------------

    function test_sell_acceptsWithinInventory() public {
        approveAndBuy(K1, address(meme), 100e18);
        uint256 usdBefore = usd.balanceOf(address(acct));
        sell(K1, address(meme), 60e18);
        assertEq(hook.inventory(K1, address(acct), address(meme)), 40e18);
        assertEq(hook.reserved(address(acct), address(meme)), 40e18);
        assertEq(usd.balanceOf(address(acct)), usdBefore + 60e18);
    }

    function test_sell_rejectsAboveInventory() public {
        approveAndBuy(K1, address(meme), 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.InventoryExceeded.selector, address(meme), 100e18
            )
        );
        sell(K1, address(meme), 100e18 + 1);
    }

    function test_sell_cannotSellHumansPriorHoldings() public {
        meme.mint(address(acct), 500e18); // the human's own position, never attributed
        approveAndBuy(K1, address(meme), 100e18);
        assertEq(hook.inventory(K1, address(acct), address(meme)), 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.InventoryExceeded.selector, address(meme), 100e18
            )
        );
        sell(K1, address(meme), 101e18);
    }

    function test_sell_cannotSellOtherKeysInventory() public {
        grant(K2, defaultPolicy());
        approveAndBuy(K1, address(meme), 100e18);
        approveAndBuy(K2, address(meme), 50e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.InventoryExceeded.selector, address(meme), 50e18
            )
        );
        sell(K2, address(meme), 51e18);
        sell(K1, address(meme), 100e18);
        sell(K2, address(meme), 50e18);
        assertEq(hook.reserved(address(acct), address(meme)), 0);
    }

    function test_sell_failsClosedOnAttributionGap_untilRootReleases() public {
        approveAndBuy(K1, address(meme), 100e18);
        // Root moves attributed meme away without a release: balance 50 < reserved 100.
        acct.root(address(meme), abi.encodeCall(IERC20.transfer, (bob, 50e18)));
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.AttributionGap.selector, address(meme))
        );
        sell(K1, address(meme), 10e18);
        release(K1, address(meme), 50e18);
        sell(K1, address(meme), 10e18);
        assertEq(hook.inventory(K1, address(acct), address(meme)), 40e18);
    }

    function test_sell_rejectsOtherRecipient() public {
        approveAndBuy(K1, address(meme), 10e18);
        bytes memory data = abi.encodeCall(pad.sell, (address(meme), 1, 0, block.timestamp, bob));
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.RecipientNotAccount.selector, bob));
        acct.exec1(K1, address(pad), 0, data);
    }

    function test_sell_rejectsDeadlineOutOfRange() public {
        approveAndBuy(K1, address(meme), 10e18);
        uint256 d = block.timestamp + 601;
        bytes memory data = abi.encodeCall(pad.sell, (address(meme), 1, 0, d, address(acct)));
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.DeadlineOutOfRange.selector, d));
        acct.exec1(K1, address(pad), 0, data);
    }

    function test_sell_rejectsQuoteAssetAsToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.QuoteAssetNotTradable.selector, address(usd))
        );
        sell(K1, address(usd), 1);
    }

    // ---------------- after 1: success == false ----------------

    function test_after_acceptsSuccessfulCall() public {
        acct.exec1(K1, address(cb), 0, abi.encodeCall(CallbackTarget.run, (bob, "")));
    }

    function test_after_rejectsFailedCall() public {
        vm.expectRevert(err(IAgentPolicyHook.CallFailed.selector));
        acct.exec1(K1, address(cb), 0, abi.encodeCall(CallbackTarget.fail, ()));
    }

    // ---------------- after 2: ERC20 quote-asset net outflow ----------------

    function test_quote_chargesOutflow() public {
        transferUsd(K1, 300e18);
        Spent memory s = hook.getSpent(K1, address(acct), address(usd));
        assertEq(s.total, 300e18);
        assertEq(s.period, 300e18);
        assertEq(hook.remainingLimit(K1, address(acct), address(usd)), 100e18);
    }

    function test_quote_rejectsOverPeriodCap() public {
        transferUsd(K1, 400e18);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        transferUsd(K1, 1);
    }

    function test_quote_rejectsOverTotalCap_acrossWindows() public {
        transferUsd(K1, 400e18);
        vm.warp(T0 + DAY);
        transferUsd(K1, 400e18);
        vm.warp(T0 + 2 * DAY);
        transferUsd(K1, 200e18);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        transferUsd(K1, 1);
    }

    function test_quote_windowBoundaryAllowsTwoPeriodCaps() public {
        vm.warp(T0 + DAY - 1);
        transferUsd(K1, 400e18);
        vm.warp(T0 + DAY);
        transferUsd(K1, 400e18);
        assertEq(hook.getSpent(K1, address(acct), address(usd)).total, 800e18);
    }

    function test_quote_inflowDoesNotRestoreUsage() public {
        transferUsd(K1, 400e18);
        usd.mint(address(acct), 400e18); // inflow across calls
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        transferUsd(K1, 1);
    }

    function test_quote_sellProceedsDoNotRestoreUsage() public {
        approveAndBuy(K1, address(meme), 400e18);
        sell(K1, address(meme), 400e18); // 400 USD flows back in
        assertEq(hook.getSpent(K1, address(acct), address(usd)).total, 400e18);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        transferUsd(K1, 1);
    }

    function test_quote_buyUsingRootAllowanceIsStillMetered() public {
        // An allowance this key did not grant (root's here) cannot be spent unmetered.
        acct.root(address(usd), approveData(address(pad), type(uint256).max));
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        acct.exec1(K1, address(pad), 0, buyData(address(meme), 400e18 + 1));
    }

    function testFuzz_quote_outflowNeverExceedsCaps(uint256[6] memory amounts, uint8 warps) public {
        uint256 charged;
        for (uint256 i; i < amounts.length; ++i) {
            if ((warps >> i) & 1 == 1) vm.warp(block.timestamp + DAY);
            uint256 amount = bound(amounts[i], 0, 500e18);
            uint256 left = hook.remainingLimit(K1, address(acct), address(usd));
            try acct.exec1(K1, address(cb), 0, transferUsdData(amount)) {
                assertLe(amount, left);
                charged += amount;
            } catch {
                assertGt(amount, left); // only an over-limit outflow is refused
            }
            Spent memory s = hook.getSpent(K1, address(acct), address(usd));
            assertEq(s.total, charged);
            assertLe(s.total, 1000e18);
            assertLe(s.period, 400e18);
        }
        assertEq(usd.balanceOf(bob), charged);
    }

    // ---------------- after 3: BUY attribution ----------------

    function test_buyCreditsExactDeltaToInventoryAndReserved() public {
        meme.mint(address(acct), 7e18); // prior balance is not attributed
        approveAndBuy(K1, address(meme), 100e18);
        assertEq(hook.inventory(K1, address(acct), address(meme)), 100e18);
        assertEq(hook.reserved(address(acct), address(meme)), 100e18);
        assertEq(hook.getSpent(K1, address(acct), address(usd)).total, 100e18);
    }

    function test_buyWithZeroDeltaCreditsNothing() public {
        approveAndBuy(K1, address(meme), 0);
        assertEq(hook.inventory(K1, address(acct), address(meme)), 0);
    }

    // ---------------- after 4: SELL exact amount ----------------

    function test_sell_rejectsPartialFill() public {
        approveAndBuy(K1, address(meme), 100e18);
        pad.setFillPercent(50);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.PartialFill.selector, address(meme))
        );
        sell(K1, address(meme), 100e18);
    }

    function test_sell_rejectsOverfill() public {
        meme.mint(address(acct), 100e18);
        approveAndBuy(K1, address(meme), 100e18);
        pad.setFillPercent(150);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.PartialFill.selector, address(meme))
        );
        sell(K1, address(meme), 100e18);
    }
}
