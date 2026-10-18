// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind
} from "../../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {MockUSD} from "../../src/mocks/MockUSD.sol";
import {CaliburSessionBase} from "../hook/CaliburSessionBase.sol";
import {CallbackTarget, FakeLaunchpad, TestToken} from "../hook/HookTestHelpers.sol";

/// @notice DESIGN §9 "D1 / metering" attack list, through a real 7702-delegated CaliburEntry
///         v1.1.0 with the acceptance mocks: meme inventory attribution (§4.2.6), limit
///         semantics (§4.2.4), policy validity (I13) and the size limits.
contract D1MeteringAttackTest is CaliburSessionBase {
    bytes32 internal kh;
    bytes32 internal kh2;
    uint256 internal unit; // meme bought by 1 MockUSD (1e6 units)

    function setUp() public override {
        super.setUp();
        kh = initAccount();
        kh2 = grant(AGENT2_PK, sessionPolicy());
        unit = 1e6 * pad.RATE();
    }

    function buy(uint256 pk, uint256 usdAmount) internal {
        execOk(Entry.Direct, pk, approveAndBuy(meme, usdAmount));
    }

    function execOk(Entry e, uint256 pk, Call[] memory calls) internal {
        (bool ok, bytes memory ret) = exec(e, pk, calls);
        assertTrue(ok, vm.toString(ret));
    }

    function sellRejected(uint256 pk, uint256 amount, bytes memory expected) internal {
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            (bool ok, bytes memory ret) = exec(Entry(i), pk, one(sellCall(meme, amount)));
            assertFalse(ok, entryName(Entry(i)));
            assertEq(ret, expected, entryName(Entry(i)));
        }
    }

    function inventoryExceeded(uint256 held) internal view returns (bytes memory) {
        return abi.encodeWithSelector(IAgentPolicyHook.InventoryExceeded.selector, meme, held);
    }

    function inv(bytes32 k) internal view returns (uint256) {
        return hook.inventory(k, root, meme);
    }

    function reserved() internal view returns (uint256) {
        return hook.reserved(root, meme);
    }

    function memeBalance() internal view returns (uint256) {
        return IERC20(meme).balanceOf(root);
    }

    /// @dev The human's prior position: bought by the root itself (unhooked).
    function humanBuys(uint256 usdAmount) internal {
        rootExec(approveAndBuy(meme, usdAmount));
    }

    /// @dev Meme sent to the account from outside (an airdrop / direct transfer).
    function airdrop(uint256 usdAmount) internal {
        usd.mint(bob, usdAmount);
        vm.startPrank(bob);
        usd.approve(address(pad), usdAmount);
        pad.buy(meme, usdAmount, 0, block.timestamp, bob);
        assertTrue(IERC20(meme).transfer(root, usdAmount * pad.RATE()));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------
    // Inventory attribution
    // ---------------------------------------------------------------------------------------

    function test_D1_severalKeysHoldingTheSameToken_eachSellsOnlyItsOwn() public {
        buy(AGENT_PK, 10e6);
        buy(AGENT2_PK, 5e6);
        assertEq(inv(kh), 10 * unit);
        assertEq(inv(kh2), 5 * unit);
        assertEq(reserved(), 15 * unit);
        assertEq(memeBalance(), 15 * unit);

        // The account holds enough, but each key is bounded by its own attribution.
        sellRejected(AGENT_PK, 10 * unit + 1, inventoryExceeded(10 * unit));
        sellRejected(AGENT2_PK, 5 * unit + 1, inventoryExceeded(5 * unit));

        execOk(Entry.Signed, AGENT2_PK, one(sellCall(meme, 5 * unit)));
        sellRejected(AGENT2_PK, 1, inventoryExceeded(0));
        execOk(Entry.UserOp, AGENT_PK, one(sellCall(meme, 10 * unit)));
        assertEq(reserved(), 0);
        assertEq(memeBalance(), 0);
    }

    function test_D1_humanHoldingsAndAirdropsAreNeverAttributed() public {
        humanBuys(1_000e6);
        airdrop(300e6);
        // An inflow during a session's non-BUY call (an allowlisted target sends meme in).
        usd.mint(address(cb), 200e6);
        vm.startPrank(address(cb));
        usd.approve(address(pad), 200e6);
        pad.buy(meme, 200e6, 0, block.timestamp, address(cb));
        vm.stopPrank();
        bytes memory push = abi.encodeCall(IERC20.transfer, (root, 200 * unit));
        execOk(
            Entry.Direct,
            AGENT_PK,
            one(address(cb), 0, abi.encodeCall(CallbackTarget.run, (meme, push)))
        );

        assertEq(memeBalance(), 1_500 * unit);
        assertEq(inv(kh), 0);
        assertEq(inv(kh2), 0);
        assertEq(reserved(), 0);
        sellRejected(AGENT_PK, 1, inventoryExceeded(0));

        // A BUY is attributed exactly its own delta, nothing of the unallocated balance.
        buy(AGENT_PK, 3e6);
        assertEq(inv(kh), 3 * unit);
        assertEq(reserved(), 3 * unit);
        sellRejected(AGENT_PK, 3 * unit + 1, inventoryExceeded(3 * unit));
    }

    /// @notice The root moves attributed meme without a release tuple: every session SELL of
    ///         that token fails closed (the first key to act cannot take another key's balance)
    ///         until the root repairs the gap with `releaseInventory`.
    function test_D1_sellFailsClosedAfterRootMovesAttributedTokensWithoutRelease() public {
        buy(AGENT_PK, 10e6);
        buy(AGENT2_PK, 10e6);
        rootExec1(meme, abi.encodeCall(IERC20.transfer, (bob, 10 * unit)));
        assertLt(memeBalance(), reserved());

        bytes memory gap = abi.encodeWithSelector(IAgentPolicyHook.AttributionGap.selector, meme);
        sellRejected(AGENT_PK, 1, gap);
        sellRejected(AGENT2_PK, 10 * unit, gap);

        // The root states which key's attribution it disposed of.
        rootExec1(
            address(hook), abi.encodeCall(IAgentPolicyHook.releaseInventory, (kh, meme, 10 * unit))
        );
        assertEq(memeBalance(), reserved());
        execOk(Entry.Direct, AGENT2_PK, one(sellCall(meme, 10 * unit)));
        sellRejected(AGENT_PK, 1, inventoryExceeded(0));
    }

    function test_D1_afterRevoke_ledgerFrozen_oldKeyCannotSell() public {
        humanBuys(100e6);
        buy(AGENT_PK, 10e6);
        uint256 balanceBefore = memeBalance();
        // Hook tombstone only: Calibur would still accept the key's signatures.
        rootExec1(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (kh)));

        assertEq(inv(kh), 10 * unit);
        assertEq(reserved(), 10 * unit);
        assertEq(memeBalance(), balanceBefore);
        bytes memory inactive = err(IAgentPolicyHook.SessionInactive.selector);
        bytes[4] memory expected =
            [inactive, inactive, inactive, failedOpWithRevert("AA23 reverted", inactive)];
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            (bool ok, bytes memory ret) = exec(Entry(i), AGENT_PK, one(sellCall(meme, 10 * unit)));
            assertFalse(ok, entryName(Entry(i)));
            assertEq(ret, expected[i], entryName(Entry(i)));
        }
        assertEq(inv(kh), 10 * unit);
        assertEq(memeBalance(), balanceBefore);
    }

    function test_D1_afterRevoke_otherActiveKeysStillSellTheirOwnInventory() public {
        buy(AGENT_PK, 10e6);
        buy(AGENT2_PK, 4e6);
        address[] memory spenders = new address[](1);
        spenders[0] = address(pad);
        rootExec(revokeCalls(kh, spenders));

        // The frozen inventory of the revoked key is not available to the other key.
        sellRejected(AGENT2_PK, 4 * unit + 1, inventoryExceeded(4 * unit));
        execOk(Entry.ERC7821, AGENT2_PK, one(sellCall(meme, 4 * unit)));
        assertEq(inv(kh2), 0);
        assertEq(inv(kh), 10 * unit);
        assertEq(reserved(), 10 * unit);
        assertEq(memeBalance(), 10 * unit);
    }

    /// @notice An explicit root release for a revoked key reduces only that key's inventory and
    ///         `reserved`, by the same amount; the balance is unchanged and the unallocated part
    ///         grows by that amount. Then only the root can dispose of it.
    function test_D1_rootReleaseOfRevokedKey_reducesOnlyThatInventory() public {
        humanBuys(100e6);
        buy(AGENT_PK, 10e6);
        buy(AGENT2_PK, 6e6);
        rootExec1(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (kh)));
        uint256 balance = memeBalance();
        uint256 unallocated = balance - reserved();

        rootExec1(
            address(hook), abi.encodeCall(IAgentPolicyHook.releaseInventory, (kh, meme, 4 * unit))
        );
        assertEq(inv(kh), 6 * unit);
        assertEq(inv(kh2), 6 * unit);
        assertEq(reserved(), 12 * unit);
        assertEq(memeBalance(), balance);
        assertEq(memeBalance() - reserved(), unallocated + 4 * unit);
        sellRejected(AGENT2_PK, 6 * unit + 1, inventoryExceeded(6 * unit));

        // Releasing more than the key holds is refused.
        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(ICalibur.CallFailed.selector, inventoryExceeded(6 * unit))
        );
        account.execute(
            BatchedCall(
                one(
                    address(hook),
                    0,
                    abi.encodeCall(IAgentPolicyHook.releaseInventory, (kh, meme, 6 * unit + 1))
                ),
                true
            )
        );
    }

    /// @notice With several keys and an unallocated balance of one token, a release names one
    ///         key and touches only that key.
    function test_D1_severalKeysAndUnallocated_onlyTheNamedKeyIsReleased() public {
        humanBuys(50e6);
        buy(AGENT_PK, 7e6);
        buy(AGENT2_PK, 9e6);
        rootExec1(
            address(hook), abi.encodeCall(IAgentPolicyHook.releaseInventory, (kh2, meme, 3 * unit))
        );
        assertEq(inv(kh), 7 * unit);
        assertEq(inv(kh2), 6 * unit);
        assertEq(reserved(), 13 * unit);
        assertEq(memeBalance(), 66 * unit);
        execOk(Entry.Direct, AGENT_PK, one(sellCall(meme, 7 * unit)));
        sellRejected(AGENT2_PK, 6 * unit + 1, inventoryExceeded(6 * unit));
    }

    /// @notice Partial fills and overfills are rejected (§4.2.3 afterExecute step 4).
    function test_D1_partialFillAndOverfillRejected() public {
        FakeLaunchpad fake = new FakeLaunchpad(address(usd));
        TestToken token = new TestToken("FAKE");
        Policy memory p = sessionPolicy();
        p.permissions[1] =
            CallPermission(address(fake), ILaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY);
        p.permissions[2] =
            CallPermission(address(fake), ILaunchpad.sell.selector, RuleKind.LAUNCHPAD_SELL);
        p.trustedSpenders[0] = address(fake);
        uint256 pk3 = 0xFA4E;
        bytes32 kh3 = grant(pk3, p);
        token.mint(root, 1_000e6); // the human's own position (for the overfill)

        Call[] memory buyCalls = two(
            approveCall(address(fake), 10e6),
            Call(
                address(fake),
                0,
                abi.encodeCall(
                    ILaunchpad.buy, (address(token), 10e6, 0, block.timestamp + 60, root)
                )
            )
        );
        execOk(Entry.Direct, pk3, buyCalls);
        assertEq(hook.inventory(kh3, root, address(token)), 10e6);

        Call[] memory sell = one(
            address(fake),
            0,
            abi.encodeCall(ILaunchpad.sell, (address(token), 10e6, 0, block.timestamp + 60, root))
        );
        bytes memory partialFill =
            abi.encodeWithSelector(IAgentPolicyHook.PartialFill.selector, address(token));
        uint256[2] memory fills = [uint256(50), 101];
        for (uint256 f; f < 2; ++f) {
            fake.setFillPercent(fills[f]);
            for (uint256 i; i < ENTRY_COUNT; ++i) {
                (bool ok, bytes memory ret) = exec(Entry(i), pk3, sell);
                assertFalse(ok, entryName(Entry(i)));
                assertEq(ret, partialFill, entryName(Entry(i)));
            }
        }
        fake.setFillPercent(100);
        execOk(Entry.Direct, pk3, sell);
        assertEq(hook.inventory(kh3, root, address(token)), 0);
    }

    // ---------------------------------------------------------------------------------------
    // Metering
    // ---------------------------------------------------------------------------------------

    /// @notice Sending 1 MNT charges exactly 1 MNT of limit; a native refund restores nothing.
    function test_metering_oneMntChargesExactlyOneMnt() public {
        uint256 before = root.balance;
        execOk(Entry.Signed, AGENT_PK, one(bob, 1 ether, ""));
        assertEq(hook.getSpent(kh, root, address(0)).total, 1 ether);
        assertEq(hook.getSpent(kh, root, address(0)).period, 1 ether);
        assertEq(before - root.balance, 1 ether);
        assertEq(hook.remainingLimit(kh, root, address(0)), 1 ether);

        vm.prank(bob);
        (bool refunded,) = root.call{value: 1 ether}("");
        assertTrue(refunded);
        assertEq(hook.remainingLimit(kh, root, address(0)), 1 ether);
        (bool ok, bytes memory ret) = exec(Entry.Direct, AGENT_PK, one(bob, 1 ether + 1, ""));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(IAgentPolicyHook.ValueExceeded.selector, 1 ether + 1, 1 ether)
        );
        execOk(Entry.Direct, AGENT_PK, one(bob, 1 ether, ""));
        (ok, ret) = exec(Entry.Direct, AGENT_PK, one(bob, 1, ""));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(0)));
    }

    /// @notice "Another key approved but this key has no quote limit" is rejected at grant time;
    ///         a key that does have a limit pays for the other key's leftover allowance itself.
    function test_metering_otherKeysApproval_withoutOwnQuoteLimit_rejected() public {
        execOk(Entry.Direct, AGENT_PK, one(approveCall(address(pad), 40e6)));

        Policy memory noLimit;
        noLimit.permissions = new CallPermission[](1);
        noLimit.permissions[0] =
            CallPermission(address(pad), ILaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY);
        noLimit.maxDeadlineWindow = 600;
        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICalibur.CallFailed.selector,
                abi.encodeWithSelector(
                    IAgentPolicyHook.LaunchpadQuoteNotLimited.selector, address(pad), address(usd)
                )
            )
        );
        account.execute(BatchedCall(grantCalls(0xB1, noLimit, expiry), true));

        Policy memory small = noLimit;
        small.quoteLimits = new QuoteLimit[](1);
        small.quoteLimits[0] = QuoteLimit(address(usd), 5e6, 5e6);
        small.periodLength = 1 days;
        bytes32 kh3 = grant(0xB2, small);
        (bool ok, bytes memory ret) = exec(Entry.Direct, 0xB2, one(buyCall(meme, 40e6)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd)));
        execOk(Entry.Direct, 0xB2, one(buyCall(meme, 5e6)));
        assertEq(hook.getSpent(kh3, root, address(usd)).total, 5e6);
        assertEq(hook.getSpent(kh, root, address(usd)).total, 0);
    }

    /// @notice "Update removes a limit but keeps BUY" is rejected (I13), whether the quote asset
    ///         is dropped or swapped for another one.
    function test_metering_updateRemovingLimitButKeepingBuy_rejected() public {
        Policy memory p = sessionPolicy();
        CallPermission[] memory perms = new CallPermission[](2);
        perms[0] = p.permissions[1]; // buy
        perms[1] = p.permissions[2]; // sell
        p.permissions = perms;
        p.maxValuePerCall = 0;

        p.quoteLimits = new QuoteLimit[](0);
        expectUpdateRejected(
            p,
            abi.encodeWithSelector(
                IAgentPolicyHook.LaunchpadQuoteNotLimited.selector, address(pad), address(usd)
            )
        );
        MockUSD other = new MockUSD();
        p.quoteLimits = new QuoteLimit[](1);
        p.quoteLimits[0] = QuoteLimit(address(other), 1e6, 1e6);
        expectUpdateRejected(
            p,
            abi.encodeWithSelector(
                IAgentPolicyHook.LaunchpadQuoteNotLimited.selector, address(pad), address(usd)
            )
        );
        // Without BUY, dropping the asset is still refused: counters must survive.
        p.permissions = new CallPermission[](0);
        p.quoteLimits = new QuoteLimit[](0);
        expectUpdateRejected(
            p, abi.encodeWithSelector(IAgentPolicyHook.QuoteAssetRemoved.selector, address(usd))
        );
    }

    function expectUpdateRejected(Policy memory p, bytes memory inner) internal {
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(ICalibur.CallFailed.selector, inner));
        account.execute(
            BatchedCall(
                one(address(hook), 0, abi.encodeCall(IAgentPolicyHook.updatePolicy, (kh, p))), true
            )
        );
    }

    // ---------------------------------------------------------------------------------------
    // Size limits (the panic bound depends on them)
    // ---------------------------------------------------------------------------------------

    function test_size_setPolicyBeyondLimits_rejected() public {
        Policy memory p = sessionPolicy();
        p.quoteLimits = new QuoteLimit[](5);
        for (uint256 i; i < 5; ++i) {
            p.quoteLimits[i] = QuoteLimit(address(new MockUSD()), 1e6, 1e6);
        }
        p.quoteLimits[0].token = address(usd);
        expectGrantRejected(p, err(IAgentPolicyHook.TooManyQuoteLimits.selector));

        p = sessionPolicy();
        p.trustedSpenders = new address[](5);
        for (uint256 i; i < 5; ++i) {
            p.trustedSpenders[i] = makeAddr(string.concat("spender", vm.toString(i)));
        }
        expectGrantRejected(p, err(IAgentPolicyHook.TooManySpenders.selector));

        p = sessionPolicy();
        p.permissions = new CallPermission[](17);
        for (uint256 i; i < 17; ++i) {
            p.permissions[i] = CallPermission(
                makeAddr(string.concat("target", vm.toString(i))), bytes4(0), RuleKind.NONE
            );
        }
        expectGrantRejected(p, err(IAgentPolicyHook.TooManyPermissions.selector));

        // Sessions: two exist; six more fit; the ninth is refused.
        for (uint256 i; i < 6; ++i) {
            grant(0x7000 + i, sessionPolicy());
        }
        assertEq(hook.activeSessions(root), 8);
        expectGrantRejected(sessionPolicy(), err(IAgentPolicyHook.TooManySessions.selector));
    }

    function expectGrantRejected(Policy memory p, bytes memory inner) internal {
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(ICalibur.CallFailed.selector, inner));
        account.execute(BatchedCall(grantCalls(0x9999, p, expiry), true));
    }
}
