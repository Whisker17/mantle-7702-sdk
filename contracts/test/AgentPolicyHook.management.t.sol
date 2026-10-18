// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentPolicyHook} from "../src/AgentPolicyHook.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind,
    Spent,
    Summary
} from "../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../src/interfaces/ILaunchpad.sol";
import {AgentPolicyHookTestBase} from "./hook/AgentPolicyHookTestBase.sol";
import {CallbackTarget, FakeLaunchpad, MiniAccount, TestToken} from "./hook/HookTestHelpers.sol";

/// @notice Management functions, policy validity checks, size limits, constants, constructor.
contract AgentPolicyHookManagementTest is AgentPolicyHookTestBase {
    // ---------------- constants and constructor ----------------

    function test_selectorsMatchCanonicalSignatures() public view {
        assertEq(
            hook.BUY_SELECTOR(), bytes4(keccak256("buy(address,uint256,uint256,uint256,address)"))
        );
        assertEq(
            hook.SELL_SELECTOR(), bytes4(keccak256("sell(address,uint256,uint256,uint256,address)"))
        );
        assertEq(hook.APPROVE_SELECTOR(), bytes4(keccak256("approve(address,uint256)")));
        assertEq(
            hook.INCREASE_ALLOWANCE_SELECTOR(),
            bytes4(keccak256("increaseAllowance(address,uint256)"))
        );
        assertEq(ILaunchpad.quoteToken.selector, bytes4(keccak256("quoteToken()")));
    }

    function test_sizeConstants() public view {
        assertEq(hook.MAX_SESSIONS(), 8);
        assertEq(hook.MAX_QUOTE_LIMITS(), 4);
        assertEq(hook.MAX_TRUSTED_SPENDERS(), 4);
        assertEq(hook.MAX_PERMISSIONS(), 16);
    }

    function test_constructor_storesPaymasterAsImmutable() public view {
        assertEq(hook.PAYMASTER(), PAYMASTER);
    }

    function test_constructor_rejectsZeroPaymaster() public {
        vm.expectRevert(err(IAgentPolicyHook.ZeroPaymaster.selector));
        new AgentPolicyHook{salt: _salt(true)}(address(0));
    }

    function test_constructor_acceptsAddressWithAllFiveFlagBits() public {
        AgentPolicyHook h = new AgentPolicyHook{salt: _salt(true)}(PAYMASTER);
        assertEq(uint160(address(h)) & 0x1f, 0x1f);
    }

    function test_constructor_rejectsAddressWithoutAllFlagBits() public {
        vm.expectRevert(err(IAgentPolicyHook.HookAddressFlags.selector));
        new AgentPolicyHook{salt: _salt(false)}(PAYMASTER);
    }

    /// @dev First salt whose CREATE2 address has (or lacks) all five low flag bits.
    function _salt(bool flagged) internal view returns (bytes32 salt) {
        bytes32 initHash =
            keccak256(abi.encodePacked(type(AgentPolicyHook).creationCode, abi.encode(PAYMASTER)));
        bytes32 zeroHash =
            keccak256(abi.encodePacked(type(AgentPolicyHook).creationCode, abi.encode(address(0))));
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            bool a = uint160(vm.computeCreate2Address(salt, initHash, address(this))) & 0x1f == 0x1f;
            bool b = uint160(vm.computeCreate2Address(salt, zeroHash, address(this))) & 0x1f == 0x1f;
            if (a == flagged && b == flagged) return salt;
        }
    }

    // ---------------- setPolicy ----------------

    function test_setPolicy_writesPolicyAnchorAndSummary() public {
        vm.expectEmit(address(hook));
        emit IAgentPolicyHook.PolicySet(address(acct), K1, uint40(T0));
        grant(K1, defaultPolicy());
        Summary memory s = hook.getSummary(K1, address(acct));
        assertTrue(s.initialized && s.active && !s.revoked);
        (Policy memory p, uint40 anchor) = hook.getPolicy(K1, address(acct));
        assertEq(anchor, T0);
        assertEq(p.quoteLimits[0].token, address(usd));
        assertEq(p.permissions.length, 8);
        assertEq(hook.activeSessions(address(acct)), 1);
    }

    function test_setPolicy_isScopedToCallingAccount() public {
        grant(K1, defaultPolicy());
        // Another caller writes only its own namespace.
        vm.prank(bob);
        hook.setPolicy(K2, defaultPolicy());
        assertFalse(hook.getSummary(K2, address(acct)).initialized);
        assertTrue(hook.getSummary(K2, bob).active);
        assertEq(hook.activeSessions(address(acct)), 1);
    }

    function test_setPolicy_rejectsInitializedKey() public {
        grant(K1, defaultPolicy());
        vm.expectRevert(err(IAgentPolicyHook.SessionExists.selector));
        grant(K1, defaultPolicy());
    }

    function test_setPolicy_rejectsRevokedKey_forever() public {
        grant(K1, defaultPolicy());
        revokeKey(K1);
        vm.expectRevert(err(IAgentPolicyHook.SessionRevoked.selector));
        grant(K1, defaultPolicy());
        vm.warp(T0 + 365 days);
        vm.expectRevert(err(IAgentPolicyHook.SessionRevoked.selector));
        grant(K1, defaultPolicy());
    }

    function test_setPolicy_rejectsPreemptivelyTombstonedKey() public {
        revokeKey(K1);
        vm.expectRevert(err(IAgentPolicyHook.SessionRevoked.selector));
        grant(K1, defaultPolicy());
    }

    // ---------------- management refuses during an execution ----------------

    function _reenterManagement(bytes memory call) internal {
        grant(K1, defaultPolicy());
        bytes memory inner = abi.encodeCall(MiniAccount.root, (address(hook), call));
        acct.exec1(
            K1, address(cb), 0, abi.encodeCall(CallbackTarget.tryRun, (address(acct), inner))
        );
        assertEq(cb.lastError(), err(IAgentPolicyHook.Reentrancy.selector));
    }

    function test_setPolicy_rejectedDuringExecution() public {
        _reenterManagement(abi.encodeCall(IAgentPolicyHook.setPolicy, (K2, defaultPolicy())));
        assertFalse(hook.getSummary(K2, address(acct)).initialized);
    }

    function test_updatePolicy_rejectedDuringExecution() public {
        _reenterManagement(abi.encodeCall(IAgentPolicyHook.updatePolicy, (K1, defaultPolicy())));
    }

    function test_revoke_rejectedDuringExecution() public {
        _reenterManagement(abi.encodeCall(IAgentPolicyHook.revoke, (K1)));
        assertTrue(hook.getSummary(K1, address(acct)).active);
    }

    function test_releaseInventory_rejectedDuringExecution() public {
        _reenterManagement(
            abi.encodeCall(IAgentPolicyHook.releaseInventory, (K1, address(meme), 0))
        );
    }

    function test_management_allowedAfterExecutionInSameTx() public {
        grant(K1, defaultPolicy());
        acct.exec1(K1, bob, 0, "");
        grant(K2, defaultPolicy()); // the lock was released by afterExecute
        assertTrue(hook.getSummary(K2, address(acct)).active);
    }

    // ---------------- updatePolicy ----------------

    function test_updatePolicy_lowersCapsAddsAssetKeepsAnchorAndCounters() public {
        grant(K1, defaultPolicy());
        transferUsd(K1, 100e18);
        vm.warp(T0 + 3 hours);
        Policy memory p = defaultPolicy();
        p.quoteLimits = new QuoteLimit[](2);
        p.quoteLimits[0] = QuoteLimit(address(usdt), 50e18, 10e18);
        p.quoteLimits[1] = QuoteLimit(address(usd), 900e18, 300e18);
        p.maxDeadlineWindow = 60;
        vm.expectEmit(address(hook));
        emit IAgentPolicyHook.PolicyUpdated(address(acct), K1);
        update(K1, p);
        (Policy memory stored, uint40 anchor) = hook.getPolicy(K1, address(acct));
        assertEq(anchor, T0);
        assertEq(stored.quoteLimits.length, 2);
        assertEq(stored.maxDeadlineWindow, 60);
        Spent memory s = hook.getSpent(K1, address(acct), address(usd));
        assertEq(s.total, 100e18);
        assertEq(s.period, 100e18);
        assertEq(hook.remainingLimit(K1, address(acct), address(usd)), 200e18);
    }

    function test_updatePolicy_capBelowSpentBlocksSpending() public {
        grant(K1, defaultPolicy());
        transferUsd(K1, 300e18);
        Policy memory p = defaultPolicy();
        p.quoteLimits[0].totalCap = 200e18;
        update(K1, p);
        assertEq(hook.remainingLimit(K1, address(acct), address(usd)), 0);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        transferUsd(K1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd))
        );
        acct.exec1(K1, address(usd), 0, approveData(address(pad), 1));
    }

    function test_updatePolicy_canRemovePermissions() public {
        grant(K1, defaultPolicy());
        Policy memory p = defaultPolicy();
        p.permissions = new CallPermission[](0);
        update(K1, p);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.CallNotPermitted.selector, bob, bytes4(0))
        );
        acct.exec1(K1, bob, 0, "");
    }

    function test_updatePolicy_rejectsUnknownKey() public {
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        update(K1, defaultPolicy());
    }

    function test_updatePolicy_rejectsRevokedKey() public {
        grant(K1, defaultPolicy());
        revokeKey(K1);
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        update(K1, defaultPolicy());
    }

    function test_updatePolicy_rejectsPeriodLengthChange() public {
        grant(K1, defaultPolicy());
        Policy memory p = defaultPolicy();
        p.periodLength = DAY + 1;
        vm.expectRevert(err(IAgentPolicyHook.PeriodLengthChanged.selector));
        update(K1, p);
    }

    function test_updatePolicy_rejectsRemovingQuoteAsset() public {
        grant(K1, defaultPolicy());
        Policy memory p = _noTradePolicy();
        p.quoteLimits[0].token = address(usdt);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.QuoteAssetRemoved.selector, address(usd))
        );
        update(K1, p);
    }

    function test_updatePolicy_rejectsRemovingLimitButKeepingBuy() public {
        grant(K1, defaultPolicy());
        Policy memory p = defaultPolicy();
        p.quoteLimits = new QuoteLimit[](0);
        p.permissions[0] = p.permissions[3]; // drop approve so the BUY check is the one that fires
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.LaunchpadQuoteNotLimited.selector, address(pad), address(usd)
            )
        );
        update(K1, p);
    }

    function test_updatePolicy_rejectsRaisingTotalCap() public {
        grant(K1, defaultPolicy());
        Policy memory p = defaultPolicy();
        p.quoteLimits[0].totalCap += 1;
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.CapRaised.selector, address(usd)));
        update(K1, p);
    }

    function test_updatePolicy_rejectsRaisingPeriodCap() public {
        grant(K1, defaultPolicy());
        Policy memory p = defaultPolicy();
        p.quoteLimits[0].periodCap += 1;
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.CapRaised.selector, address(usd)));
        update(K1, p);
    }

    function test_updatePolicy_rejectsRaisingMntCap() public {
        grant(K1, defaultPolicy());
        Policy memory p = defaultPolicy();
        p.mntLimit.totalCap += 1;
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.CapRaised.selector, address(0)));
        update(K1, p);
    }

    function test_updatePolicy_runsValidityChecks() public {
        grant(K1, defaultPolicy());
        Policy memory p = defaultPolicy();
        p.trustedSpenders = new address[](5);
        vm.expectRevert(err(IAgentPolicyHook.TooManySpenders.selector));
        update(K1, p);
    }

    // ---------------- revoke ----------------

    function test_revoke_tombstonesAndFreezesInventory() public {
        grant(K1, defaultPolicy());
        approveAndBuy(K1, address(meme), 100e18);
        vm.expectEmit(address(hook));
        emit IAgentPolicyHook.Revoked(address(acct), K1);
        revokeKey(K1);
        Summary memory s = hook.getSummary(K1, address(acct));
        assertTrue(s.initialized && !s.active && s.revoked);
        assertEq(hook.activeSessions(address(acct)), 0);
        // O(1): inventory, reserved and the balance are untouched; the old key cannot sell.
        assertEq(hook.inventory(K1, address(acct), address(meme)), 100e18);
        assertEq(hook.reserved(address(acct), address(meme)), 100e18);
        assertEq(meme.balanceOf(address(acct)), 100e18);
        vm.expectRevert(err(IAgentPolicyHook.SessionInactive.selector));
        sell(K1, address(meme), 1);
    }

    function test_revoke_otherKeysStillSellTheirOwnInventory() public {
        grant(K1, defaultPolicy());
        grant(K2, defaultPolicy());
        approveAndBuy(K1, address(meme), 100e18);
        approveAndBuy(K2, address(meme), 50e18);
        revokeKey(K1);
        sell(K2, address(meme), 50e18);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.InventoryExceeded.selector, address(meme), 0)
        );
        sell(K2, address(meme), 1);
    }

    function test_revoke_isIdempotentAndAcceptsUnknownKeys() public {
        grant(K1, defaultPolicy());
        revokeKey(K1);
        revokeKey(K1);
        revokeKey(K2); // never granted: still tombstoned, never reverts (panic must not block)
        assertEq(hook.activeSessions(address(acct)), 0);
        assertTrue(hook.getSummary(K2, address(acct)).revoked);
    }

    // ---------------- releaseInventory ----------------

    function test_releaseInventory_reducesOnlyNamedKey() public {
        grant(K1, defaultPolicy());
        grant(K2, defaultPolicy());
        meme.mint(address(acct), 30e18); // unallocated
        approveAndBuy(K1, address(meme), 100e18);
        approveAndBuy(K2, address(meme), 50e18);
        revokeKey(K1);
        vm.expectEmit(address(hook));
        emit IAgentPolicyHook.InventoryReleased(address(acct), K1, address(meme), 40e18);
        release(K1, address(meme), 40e18);
        assertEq(hook.inventory(K1, address(acct), address(meme)), 60e18);
        assertEq(hook.inventory(K2, address(acct), address(meme)), 50e18);
        assertEq(hook.reserved(address(acct), address(meme)), 110e18);
        assertEq(meme.balanceOf(address(acct)), 180e18); // unallocated grew 30 -> 70
    }

    function test_releaseInventory_worksForActiveKey() public {
        grant(K1, defaultPolicy());
        approveAndBuy(K1, address(meme), 100e18);
        release(K1, address(meme), 100e18);
        assertEq(hook.reserved(address(acct), address(meme)), 0);
    }

    function test_releaseInventory_rejectsMoreThanInventory() public {
        grant(K1, defaultPolicy());
        approveAndBuy(K1, address(meme), 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.InventoryExceeded.selector, address(meme), 100e18
            )
        );
        release(K1, address(meme), 100e18 + 1);
    }

    // ---------------- policy validity checks ----------------

    function test_validity_acceptsBuyWhenLaunchpadQuoteIsLimited() public {
        grant(K1, defaultPolicy());
    }

    function test_validity_rejectsBuyWhenLaunchpadQuoteNotLimited() public {
        FakeLaunchpad padT = new FakeLaunchpad(address(usdt));
        Policy memory p = defaultPolicy();
        p.permissions[1].target = address(padT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.LaunchpadQuoteNotLimited.selector, address(padT), address(usdt)
            )
        );
        grant(K1, p);
    }

    function test_validity_rejectsBuyOnTargetWithoutQuoteToken() public {
        Policy memory p = defaultPolicy();
        p.permissions[1].target = address(cb); // no quoteToken(): fail closed
        vm.expectRevert();
        grant(K1, p);
    }

    function test_validity_acceptsNoValueWithoutMntLimit() public {
        Policy memory p = defaultPolicy();
        p.maxValuePerCall = 0;
        p.mntLimit = QuoteLimit(address(0), 0, 0);
        grant(K1, p);
        vm.expectRevert(abi.encodeWithSelector(IAgentPolicyHook.ValueExceeded.selector, 1, 0));
        acct.exec1(K1, bob, 1, "");
    }

    function test_validity_rejectsValueWithoutMntLimit() public {
        Policy memory p = defaultPolicy();
        p.mntLimit.totalCap = 0;
        vm.expectRevert(err(IAgentPolicyHook.MntLimitMissing.selector));
        grant(K1, p);
    }

    function test_validity_rejectsTokenInMntLimit() public {
        Policy memory p = defaultPolicy();
        p.mntLimit.token = address(usd);
        vm.expectRevert(err(IAgentPolicyHook.InvalidMntLimit.selector));
        grant(K1, p);
    }

    function test_validity_rejectsApproveOnNonQuoteTarget() public {
        Policy memory p = defaultPolicy();
        p.permissions[0].target = address(usdt);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.ApproveTargetNotQuote.selector, address(usdt))
        );
        grant(K1, p);
    }

    function test_validity_rejectsZeroQuoteAsset() public {
        Policy memory p = defaultPolicy();
        p.quoteLimits[0].token = address(0);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.InvalidQuoteAsset.selector, address(0))
        );
        grant(K1, p);
    }

    function test_validity_rejectsDuplicateQuoteAsset() public {
        Policy memory p = defaultPolicy();
        p.quoteLimits = new QuoteLimit[](2);
        p.quoteLimits[0] = QuoteLimit(address(usd), 1, 1);
        p.quoteLimits[1] = QuoteLimit(address(usd), 2, 2);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.DuplicateQuoteAsset.selector, address(usd))
        );
        grant(K1, p);
    }

    function test_validity_rejectsQuoteAssetHoldingSessionInventory() public {
        grant(K1, defaultPolicy());
        approveAndBuy(K1, address(meme), 10e18);
        Policy memory p = defaultPolicy();
        p.quoteLimits = new QuoteLimit[](2);
        p.quoteLimits[0] = QuoteLimit(address(usd), 1000e18, 400e18);
        p.quoteLimits[1] = QuoteLimit(address(meme), 1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAgentPolicyHook.QuoteAssetHasInventory.selector, address(meme))
        );
        update(K1, p);
        release(K1, address(meme), 10e18);
        update(K1, p);
    }

    function test_validity_rejectsApproveSelectorWithoutApproveRule() public {
        _expectRuleMismatch(address(usd), IERC20.approve.selector, RuleKind.NONE);
    }

    function test_validity_rejectsBuySelectorWithoutBuyRule() public {
        _expectRuleMismatch(address(pad), ILaunchpad.buy.selector, RuleKind.NONE);
    }

    function test_validity_rejectsSellSelectorWithoutSellRule() public {
        _expectRuleMismatch(address(pad), ILaunchpad.sell.selector, RuleKind.LAUNCHPAD_BUY);
    }

    function test_validity_rejectsRuleOnOtherSelector() public {
        _expectRuleMismatch(address(usd), IERC20.transfer.selector, RuleKind.ERC20_APPROVE);
    }

    function test_validity_rejectsIncreaseAllowancePermission() public {
        _expectRuleMismatch(address(usd), hook.INCREASE_ALLOWANCE_SELECTOR(), RuleKind.NONE);
    }

    function _expectRuleMismatch(address target, bytes4 selector, RuleKind kind) internal {
        Policy memory p = defaultPolicy();
        p.permissions[3] = CallPermission(target, selector, kind);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAgentPolicyHook.RuleSelectorMismatch.selector, target, selector, kind
            )
        );
        grant(K1, p);
    }

    // ---------------- size limits ----------------

    function test_size_acceptsFourQuoteLimits() public {
        grant(K1, _withQuoteLimits(4));
    }

    function test_size_rejectsFiveQuoteLimits() public {
        Policy memory p = _withQuoteLimits(5);
        vm.expectRevert(err(IAgentPolicyHook.TooManyQuoteLimits.selector));
        grant(K1, p);
    }

    function test_size_acceptsFourTrustedSpenders() public {
        Policy memory p = defaultPolicy();
        p.trustedSpenders = new address[](4);
        grant(K1, p);
    }

    function test_size_rejectsFiveTrustedSpenders() public {
        Policy memory p = defaultPolicy();
        p.trustedSpenders = new address[](5);
        vm.expectRevert(err(IAgentPolicyHook.TooManySpenders.selector));
        grant(K1, p);
    }

    function test_size_acceptsSixteenPermissions() public {
        grant(K1, _withPermissions(16));
    }

    function test_size_rejectsSeventeenPermissions() public {
        vm.expectRevert(err(IAgentPolicyHook.TooManyPermissions.selector));
        grant(K1, _withPermissions(17));
    }

    function test_size_acceptsEightSessions_rejectsNinth_untilOneIsRevoked() public {
        for (uint256 i; i < 8; ++i) {
            grant(bytes32(i + 1), defaultPolicy());
        }
        assertEq(hook.activeSessions(address(acct)), 8);
        vm.expectRevert(err(IAgentPolicyHook.TooManySessions.selector));
        grant(bytes32(uint256(9)), defaultPolicy());
        revokeKey(bytes32(uint256(1)));
        grant(bytes32(uint256(9)), defaultPolicy());
        assertEq(hook.activeSessions(address(acct)), 8);
    }

    function _withQuoteLimits(uint256 n) internal returns (Policy memory p) {
        p = defaultPolicy();
        p.quoteLimits = new QuoteLimit[](n);
        p.quoteLimits[0] = QuoteLimit(address(usd), 1000e18, 400e18);
        for (uint256 i = 1; i < n; ++i) {
            p.quoteLimits[i] = QuoteLimit(address(new TestToken("Q")), 1, 1);
        }
    }

    function _withPermissions(uint256 n) internal view returns (Policy memory p) {
        p = defaultPolicy();
        p.permissions = new CallPermission[](n);
        for (uint256 i; i < n; ++i) {
            p.permissions[i] = CallPermission(bob, bytes4(uint32(i + 1)), RuleKind.NONE);
        }
    }

    /// @dev Default policy without approve / buy / sell rules.
    function _noTradePolicy() internal view returns (Policy memory p) {
        p = defaultPolicy();
        p.permissions = new CallPermission[](1);
        p.permissions[0] = CallPermission(bob, bytes4(0), RuleKind.NONE);
    }
}
