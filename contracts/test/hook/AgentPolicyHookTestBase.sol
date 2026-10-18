// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IExecutionHook} from "calibur/interfaces/IExecutionHook.sol";
import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind
} from "../../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {CallbackTarget, FakeLaunchpad, MiniAccount, TestToken} from "./HookTestHelpers.sol";

/// @notice Shared fixture: one hook at a flagged address, a MiniAccount, a quote asset (USD),
///         a launchpad quoting USD, meme tokens and a default policy.
abstract contract AgentPolicyHookTestBase is Test {
    address internal constant PAYMASTER = address(0xFA11);
    address internal bob = makeAddr("bob");
    bytes32 internal constant K1 = keccak256("session-key-1");
    bytes32 internal constant K2 = keccak256("session-key-2");
    uint32 internal constant DAY = 1 days;
    uint256 internal constant T0 = 1_700_000_000;

    AgentPolicyHook internal hook;
    MiniAccount internal acct;
    TestToken internal usd;
    TestToken internal usdt;
    TestToken internal meme;
    TestToken internal meme2;
    FakeLaunchpad internal pad;
    CallbackTarget internal cb;

    function setUp() public virtual {
        vm.warp(T0);
        hook = deployHook(PAYMASTER);
        acct = new MiniAccount(IExecutionHook(address(hook)));
        usd = new TestToken("USD");
        usdt = new TestToken("USDT");
        meme = new TestToken("MEME");
        meme2 = new TestToken("MEME2");
        pad = new FakeLaunchpad(address(usd));
        cb = new CallbackTarget();
        usd.mint(address(acct), 10_000e18);
        vm.deal(address(acct), 100 ether);
    }

    function flaggedAddress(string memory seed) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(seed)))) | 0x1f);
    }

    function deployHook(address paymaster) internal returns (AgentPolicyHook) {
        address at = flaggedAddress("AgentPolicyHook");
        deployCodeTo("AgentPolicyHook.sol:AgentPolicyHook", abi.encode(paymaster), at);
        return AgentPolicyHook(at);
    }

    /// @dev Default policy: MNT 1/call, 3 total, 2 per day; USD 1000 total, 400 per day;
    ///      approve(USD → pad), buy, sell, plain MNT to bob, USD transfer, callbacks, failing call.
    function defaultPolicy() internal view returns (Policy memory p) {
        p.maxValuePerCall = 1 ether;
        p.mntLimit = QuoteLimit(address(0), 3 ether, 2 ether);
        p.quoteLimits = new QuoteLimit[](1);
        p.quoteLimits[0] = QuoteLimit(address(usd), 1000e18, 400e18);
        p.periodLength = DAY;
        p.permissions = new CallPermission[](8);
        p.permissions[0] =
            CallPermission(address(usd), IERC20.approve.selector, RuleKind.ERC20_APPROVE);
        p.permissions[1] =
            CallPermission(address(pad), ILaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY);
        p.permissions[2] =
            CallPermission(address(pad), ILaunchpad.sell.selector, RuleKind.LAUNCHPAD_SELL);
        p.permissions[3] = CallPermission(bob, bytes4(0), RuleKind.NONE);
        p.permissions[4] = CallPermission(address(usd), IERC20.transfer.selector, RuleKind.NONE);
        p.permissions[5] = CallPermission(address(cb), CallbackTarget.run.selector, RuleKind.NONE);
        p.permissions[6] = CallPermission(address(cb), CallbackTarget.fail.selector, RuleKind.NONE);
        p.permissions[7] =
            CallPermission(address(cb), CallbackTarget.tryRun.selector, RuleKind.NONE);
        p.trustedSpenders = new address[](1);
        p.trustedSpenders[0] = address(pad);
        p.maxDeadlineWindow = 600;
    }

    // ---- root (unhooked) management through the account ----

    function grant(bytes32 keyHash, Policy memory p) internal {
        acct.root(address(hook), abi.encodeCall(IAgentPolicyHook.setPolicy, (keyHash, p)));
    }

    function update(bytes32 keyHash, Policy memory p) internal {
        acct.root(address(hook), abi.encodeCall(IAgentPolicyHook.updatePolicy, (keyHash, p)));
    }

    function revokeKey(bytes32 keyHash) internal {
        acct.root(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (keyHash)));
    }

    function release(bytes32 keyHash, address token, uint256 amount) internal {
        acct.root(
            address(hook),
            abi.encodeCall(IAgentPolicyHook.releaseInventory, (keyHash, token, amount))
        );
    }

    // ---- session calls (hooked) ----

    function approveData(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    function buyData(address token, uint256 amountIn) internal view returns (bytes memory) {
        return
            abi.encodeCall(
                ILaunchpad.buy, (token, amountIn, 0, block.timestamp + 60, address(acct))
            );
    }

    function sellData(address token, uint256 amount) internal view returns (bytes memory) {
        return
            abi.encodeCall(ILaunchpad.sell, (token, amount, 0, block.timestamp + 60, address(acct)));
    }

    function approveAndBuy(bytes32 keyHash, address token, uint256 amountIn) internal {
        MiniAccount.Call[] memory calls = new MiniAccount.Call[](2);
        calls[0] = MiniAccount.Call(address(usd), 0, approveData(address(pad), amountIn));
        calls[1] = MiniAccount.Call(address(pad), 0, buyData(token, amountIn));
        acct.exec(keyHash, calls);
    }

    function sell(bytes32 keyHash, address token, uint256 amount) internal {
        acct.exec1(keyHash, address(pad), 0, sellData(token, amount));
    }

    function transferUsd(bytes32 keyHash, uint256 amount) internal {
        acct.exec1(keyHash, address(usd), 0, abi.encodeCall(IERC20.transfer, (bob, amount)));
    }

    function err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }
}
