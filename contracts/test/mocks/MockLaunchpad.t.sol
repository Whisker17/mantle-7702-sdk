// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MockUSD} from "../../src/mocks/MockUSD.sol";
import {MockLaunchpad} from "../../src/mocks/MockLaunchpad.sol";
import {MemeToken} from "../../src/mocks/MemeToken.sol";

/// @notice DESIGN §4.4: every clause the mocks must satisfy, as a test.
contract MockLaunchpadTest is Test {
    MockUSD usd;
    MockLaunchpad lp;
    MemeToken meme;

    address victim = makeAddr("victim");
    address attacker = makeAddr("attacker");

    uint256 constant VICTIM_USD = 1_000e6;
    uint256 constant VICTIM_BUY = 100e6;
    uint256 victimMeme;
    uint256 rate;

    function setUp() public {
        usd = new MockUSD();
        lp = new MockLaunchpad(address(usd));
        meme = MemeToken(lp.createToken("Meme", "MEME"));
        rate = lp.RATE();

        // The victim holds quote and meme, and leaves a standing quote allowance to the
        // launchpad: the worst case for every "pull a victim's assets" attempt below.
        usd.mint(victim, VICTIM_USD + VICTIM_BUY);
        vm.startPrank(victim);
        usd.approve(address(lp), VICTIM_BUY);
        victimMeme = lp.buy(address(meme), VICTIM_BUY, 0, block.timestamp, victim);
        usd.approve(address(lp), type(uint256).max);
        vm.stopPrank();
    }

    function _assertVictimIntact() internal view {
        _assertVictimUsdPlus(0);
    }

    // ---------------------------------------------------------------- ABI pin and fixture

    function test_selectorsMatchCanonicalAbi() public view {
        assertEq(
            MockLaunchpad.buy.selector,
            bytes4(keccak256("buy(address,uint256,uint256,uint256,address)"))
        );
        assertEq(
            MockLaunchpad.sell.selector,
            bytes4(keccak256("sell(address,uint256,uint256,uint256,address)"))
        );
        assertEq(lp.quoteToken.selector, bytes4(keccak256("quoteToken()")));
    }

    /// @dev An immutable lives in the runtime code, not in storage: the quote address is
    /// embedded in the deployed bytecode and no storage slot holds it.
    function test_quoteTokenIsImmutable() public {
        assertEq(lp.quoteToken(), address(usd));
        assertTrue(_contains(address(lp).code, abi.encode(address(usd))), "not in code");

        address other = makeAddr("otherQuote");
        MockLaunchpad lp2 = new MockLaunchpad(other);
        assertEq(lp2.quoteToken(), other);
        assertTrue(_contains(address(lp2).code, abi.encode(other)), "not in code");
        for (uint256 slot; slot < 8; ++slot) {
            assertTrue(vm.load(address(lp2), bytes32(slot)) != bytes32(uint256(uint160(other))));
        }
    }

    function test_mockUsdIsMintableStandardErc20() public {
        assertEq(usd.decimals(), 6);
        usd.mint(attacker, 5);
        assertEq(usd.balanceOf(attacker), 5);
        vm.prank(attacker);
        assertTrue(usd.transfer(victim, 5));
        assertEq(usd.balanceOf(victim), VICTIM_USD + 5);
        assertEq(usd.balanceOf(attacker), 0);
    }

    // ---------------------------------------------------------------- factory and registry

    function test_createTokenRegistersTokenDeployedByLaunchpad() public {
        vm.expectEmit(false, false, false, true, address(lp));
        emit MockLaunchpad.TokenCreated(address(0), "Two", "TWO");
        address t = lp.createToken("Two", "TWO");
        assertTrue(lp.isRegistered(t));
        assertEq(MemeToken(t).launchpad(), address(lp));
        assertEq(MemeToken(t).name(), "Two");
        assertEq(MemeToken(t).symbol(), "TWO");
        // Every token comes from the same fixed implementation.
        assertEq(t.codehash, address(meme).codehash);
    }

    function test_rejectsUnregisteredTokens() public {
        // A look-alike MemeToken deployed by someone else, and the quote asset itself.
        vm.prank(attacker);
        address fake = address(new MemeToken("Meme", "MEME"));
        address[2] memory bad = [fake, address(usd)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(victim);
            vm.expectRevert(MockLaunchpad.UnregisteredToken.selector);
            lp.buy(bad[i], 1e6, 0, block.timestamp, victim);
            vm.prank(victim);
            vm.expectRevert(MockLaunchpad.UnregisteredToken.selector);
            lp.sell(bad[i], 1, 0, block.timestamp, victim);
        }
        _assertVictimIntact();
    }

    // ---------------------------------------------------------------- BUY

    function test_buyPullsFromSenderAndCreditsOnlyThePurchase() public {
        address buyer = makeAddr("buyer");
        address recipient = makeAddr("recipient");
        usd.mint(buyer, 10e6);
        vm.prank(buyer);
        usd.approve(address(lp), 10e6);

        uint256 lpUsd = usd.balanceOf(address(lp));
        vm.expectEmit(true, true, false, true, address(lp));
        emit MockLaunchpad.Bought(buyer, address(meme), recipient, 4e6, 4e6 * rate);
        vm.prank(buyer);
        uint256 out = lp.buy(address(meme), 4e6, 4e6 * rate, block.timestamp, recipient);

        assertEq(out, 4e6 * rate);
        assertEq(meme.balanceOf(recipient), out, "recipient gets exactly this purchase");
        assertEq(usd.balanceOf(recipient), 0, "no other inflow to recipient");
        assertEq(meme.balanceOf(buyer), 0, "nothing to the payer");
        assertEq(usd.balanceOf(buyer), 6e6, "exactly amountIn pulled");
        assertEq(usd.balanceOf(address(lp)), lpUsd + 4e6);
        assertEq(usd.allowance(buyer, address(lp)), 6e6);
        _assertVictimIntact();
    }

    function testFuzz_buyCreditsExactlyAmountOut(uint96 amountIn) public {
        address buyer = makeAddr("buyer");
        usd.mint(buyer, amountIn);
        vm.startPrank(buyer);
        usd.approve(address(lp), amountIn);
        uint256 before = meme.balanceOf(buyer);
        uint256 out = lp.buy(address(meme), amountIn, 0, block.timestamp, buyer);
        vm.stopPrank();
        assertEq(meme.balanceOf(buyer) - before, out);
        assertEq(out, uint256(amountIn) * rate);
        assertEq(usd.balanceOf(buyer), 0);
    }

    function test_buyRevertsOnMinOutAndDeadline() public {
        vm.startPrank(victim);
        vm.expectRevert(MockLaunchpad.InsufficientOutput.selector);
        lp.buy(address(meme), 1e6, 1e6 * rate + 1, block.timestamp, victim);
        vm.expectRevert(MockLaunchpad.Expired.selector);
        lp.buy(address(meme), 1e6, 0, block.timestamp - 1, victim);
        vm.stopPrank();
        _assertVictimIntact();
    }

    // ---------------------------------------------------------------- SELL

    function test_sellNeedsNoApproveAndFillsExactly() public {
        uint256 amount = victimMeme / 4;
        assertEq(meme.allowance(victim, address(lp)), 0);
        address recipient = makeAddr("recipient");
        uint256 lpUsd = usd.balanceOf(address(lp));

        vm.expectEmit(true, true, false, true, address(lp));
        emit MockLaunchpad.Sold(victim, address(meme), recipient, amount, amount / rate);
        vm.prank(victim);
        uint256 out = lp.sell(address(meme), amount, amount / rate, block.timestamp, recipient);

        assertEq(out, amount / rate);
        assertEq(meme.balanceOf(victim), victimMeme - amount, "exactly amount taken");
        assertEq(usd.balanceOf(recipient), out, "proceeds to recipient");
        assertEq(usd.balanceOf(victim), VICTIM_USD, "seller gets nothing when recipient differs");
        assertEq(usd.balanceOf(address(lp)), lpUsd - out);
        assertEq(meme.balanceOf(address(lp)), amount);
    }

    function test_sellMoreThanBalanceRevertsWithNoPartialFill() public {
        vm.prank(victim);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, victim, victimMeme, victimMeme + 1
            )
        );
        lp.sell(address(meme), victimMeme + 1, 0, block.timestamp, victim);
        _assertVictimIntact();
    }

    function testFuzz_sellFillsAmountOrReverts(uint256 amount) public {
        uint256 lpUsd = usd.balanceOf(address(lp));
        vm.prank(victim);
        try lp.sell(address(meme), amount, 0, block.timestamp, victim) returns (uint256 out) {
            assertLe(amount, victimMeme);
            assertEq(meme.balanceOf(victim), victimMeme - amount);
            assertEq(usd.balanceOf(victim), VICTIM_USD + out);
            assertEq(out, amount / rate);
        } catch {
            assertGt(amount, victimMeme);
            _assertVictimIntact();
            assertEq(usd.balanceOf(address(lp)), lpUsd);
        }
    }

    function test_sellRevertsOnMinOutAndDeadline() public {
        vm.startPrank(victim);
        vm.expectRevert(MockLaunchpad.InsufficientOutput.selector);
        lp.sell(address(meme), victimMeme, victimMeme / rate + 1, block.timestamp, victim);
        vm.expectRevert(MockLaunchpad.Expired.selector);
        lp.sell(address(meme), victimMeme, 0, block.timestamp - 1, victim);
        vm.stopPrank();
        _assertVictimIntact();
    }

    // ---------------------------------------------------------------- §4.4 clause 7: attacks

    /// @notice A third party calling `sell` only ever sells its own balance.
    function test_thirdPartySellCannotReduceVictimBalance() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, attacker, 0, victimMeme
            )
        );
        lp.sell(address(meme), victimMeme, 0, block.timestamp, attacker);
        _assertVictimIntact();
    }

    function testFuzz_thirdPartySellCannotReduceVictimBalance(
        uint256 attackerBuy,
        uint256 amount,
        address recipient
    ) public {
        attackerBuy = bound(attackerBuy, 0, 1_000e6);
        usd.mint(attacker, attackerBuy);
        vm.startPrank(attacker);
        usd.approve(address(lp), attackerBuy);
        lp.buy(address(meme), attackerBuy, 0, block.timestamp, attacker);
        try lp.sell(address(meme), amount, 0, block.timestamp, recipient) {} catch {}
        vm.stopPrank();
        if (recipient != victim) _assertVictimIntact();
        else assertEq(meme.balanceOf(victim), victimMeme);
    }

    /// @notice The victim's standing quote allowance to the launchpad cannot be spent by
    /// anyone else's `buy`.
    function test_thirdPartyBuyCannotSpendVictimAllowance() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(lp), 0, 1e6
            )
        );
        lp.buy(address(meme), 1e6, 0, block.timestamp, attacker);
        _assertVictimIntact();
        assertEq(usd.allowance(victim, address(lp)), type(uint256).max);
    }

    /// @notice Naming the victim as `recipient` never makes the victim the payer: funds come
    /// only from `msg.sender`, even with the victim's standing allowance in place.
    function test_victimAsRecipientIsNeverThePayer() public {
        vm.startPrank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, attacker, 0, victimMeme
            )
        );
        lp.sell(address(meme), victimMeme, 0, block.timestamp, victim);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(lp), 0, 1e6
            )
        );
        lp.buy(address(meme), 1e6, 0, block.timestamp, victim);
        vm.stopPrank();
        _assertVictimIntact();
    }

    function test_memePrivilegedEntriesRejectDirectCalls() public {
        address[3] memory callers = [attacker, victim, address(this)];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(MemeToken.NotLaunchpad.selector);
            meme.launchpadTransfer(victim, 1);
            vm.expectRevert(MemeToken.NotLaunchpad.selector);
            meme.mint(callers[i], 1);
            vm.stopPrank();
        }
        _assertVictimIntact();
    }

    /// @notice Every remaining external entry, called by a third party against the victim.
    /// None of the contracts has an owner or admin role, so this is the full entry list:
    /// MockUSD {mint, transfer, transferFrom, approve}, MemeToken {mint, launchpadTransfer
    /// (above), transfer, transferFrom, approve}, MockLaunchpad {createToken, buy, sell (above)}.
    function test_noPublicEntryPullsVictimAssets() public {
        vm.startPrank(attacker);

        usd.mint(attacker, 1);
        _assertVictimIntact();

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, attacker, 0, 1)
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer) -- expected to revert
        usd.transferFrom(victim, attacker, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, attacker, 0, 1)
        );
        // forge-lint: disable-next-line(erc20-unchecked-transfer) -- expected to revert
        meme.transferFrom(victim, attacker, 1);

        assertTrue(usd.approve(victim, 1));
        assertTrue(meme.approve(victim, 1));
        assertTrue(usd.transfer(victim, 1));
        _assertVictimUsdPlus(1);

        lp.createToken("Victim", "VIC");
        vm.stopPrank();
        _assertVictimUsdPlus(1);
    }

    function _assertVictimUsdPlus(uint256 extra) internal view {
        assertEq(usd.balanceOf(victim), VICTIM_USD + extra, "victim quote");
        assertEq(meme.balanceOf(victim), victimMeme, "victim meme");
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool ok = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
