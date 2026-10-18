// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {IERC7914} from "calibur/interfaces/IERC7914.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {INonceManager} from "calibur/interfaces/INonceManager.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {SignedBatchedCall} from "calibur/libraries/SignedBatchedCallLib.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind
} from "../../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {MemeToken} from "../../src/mocks/MemeToken.sol";
import {MockLaunchpad} from "../../src/mocks/MockLaunchpad.sol";
import {CaliburSessionBase} from "../hook/CaliburSessionBase.sol";
import {CallbackTarget} from "../hook/HookTestHelpers.sol";
import {
    FeeLaunchpad,
    FeeToken,
    LyingToken,
    RevertingBalanceToken,
    Swapper
} from "./AttackHelpers.sol";

/// @notice DESIGN §9 attack list (the general part; the D1 / metering part is in
///         `D1MeteringAttackTest`), through a real 7702-delegated CaliburEntry v1.1.0, the real
///         EntryPoint v0.8 and the VerifyingPaymaster. Each test names the protection it relies
///         on; where useful, an unhooked control key shows that the hook is what stops it.
contract SessionAttackTest is CaliburSessionBase {
    bytes4 internal constant UNAUTHORIZED = bytes4(keccak256("Unauthorized()"));

    bytes32 internal kh;

    function setUp() public override {
        super.setUp();
        kh = initAccount();
    }

    function withPermission(Policy memory p, CallPermission memory extra)
        internal
        pure
        returns (Policy memory)
    {
        CallPermission[] memory perms = new CallPermission[](p.permissions.length + 1);
        for (uint256 i; i < p.permissions.length; ++i) {
            perms[i] = p.permissions[i];
        }
        perms[p.permissions.length] = extra;
        p.permissions = perms;
        return p;
    }

    function spentUsd(bytes32 k) internal view returns (uint256) {
        return hook.getSpent(k, root, address(usd)).total;
    }

    function execOk(Entry e, uint256 pk, Call[] memory calls) internal {
        (bool ok, bytes memory ret) = exec(e, pk, calls);
        assertTrue(ok, vm.toString(ret));
    }

    // ---------------------------------------------------------------------------------------
    // Allowances
    // ---------------------------------------------------------------------------------------

    /// @notice §9 "approve-only followed by an external pull". The session approves the trusted
    ///         launchpad and stops; nobody outside an account call can use that allowance
    ///         (§4.4: the launchpad pulls only from msg.sender), and when a later session call
    ///         does use it, the outflow is metered there.
    function test_attack_approveOnlyThenExternalPull() public {
        execOk(Entry.Direct, AGENT_PK, one(approveCall(address(pad), 40e6)));
        assertEq(usd.allowance(root, address(pad)), 40e6);
        assertEq(spentUsd(kh), 0);

        vm.startPrank(attacker);
        vm.expectRevert();
        pad.buy(meme, 40e6, 0, block.timestamp, attacker);
        vm.expectRevert();
        assertFalse(usd.transferFrom(root, attacker, 40e6));
        vm.stopPrank();
        assertEq(usd.balanceOf(root), 10_000e6);

        // The session spends the leftover allowance later, without a new approve: metered.
        execOk(Entry.Signed, AGENT_PK, one(buyCall(meme, 40e6)));
        assertEq(spentUsd(kh), 40e6);
        assertEq(usd.balanceOf(root), 10_000e6 - 40e6);
        assertEq(hook.remainingLimit(kh, root, address(usd)), 10e6);
    }

    /// @notice §9 "pull after revoke": the SDK revoke batch (Calibur revoke + hook tombstone +
    ///         allowance reset) leaves no allowance and no key; nothing can pull afterwards.
    function test_attack_pullAfterRevoke() public {
        execOk(Entry.Direct, AGENT_PK, one(approveCall(address(pad), 40e6)));
        address[] memory spenders = new address[](1);
        spenders[0] = address(pad);
        rootExec(revokeCalls(kh, spenders));
        assertEq(usd.allowance(root, address(pad)), 0);
        assertTrue(hook.getSummary(kh, root).revoked);

        (bool ok, bytes memory ret) = exec(Entry.Direct, AGENT_PK, one(buyCall(meme, 40e6)));
        assertFalse(ok);
        assertEq(ret, err(UNAUTHORIZED));
        vm.prank(attacker);
        vm.expectRevert();
        pad.buy(meme, 40e6, 0, block.timestamp, attacker);
        assertEq(usd.balanceOf(root), 10_000e6);
    }

    /// @notice Without the reset, a revoked key's leftover allowance can only be spent by another
    ///         active key's own call, and that key's limit pays for it.
    function test_attack_leftoverAllowanceOfRevokedKey_isMeteredToTheKeyThatSpendsIt() public {
        bytes32 kh2 = grant(AGENT2_PK, sessionPolicy());
        execOk(Entry.Direct, AGENT_PK, one(approveCall(address(pad), 40e6)));
        rootExec1(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (kh)));

        execOk(Entry.UserOp, AGENT2_PK, one(buyCall(meme, 40e6)));
        assertEq(spentUsd(kh), 0);
        assertEq(spentUsd(kh2), 40e6);
        assertEq(hook.inventory(kh2, root, meme), 40e6 * pad.RATE());
    }

    /// @notice §9 "leftover allowance after a failed buy": approve + a buy that fails at the
    ///         launchpad reverts as a whole, on every entry and whatever `revertOnFailure` says.
    function test_attack_failedBuyLeavesNoAllowance() public {
        Call[] memory calls = two(
            approveCall(address(pad), 10e6),
            Call(
                address(pad),
                0,
                abi.encodeCall(
                    ILaunchpad.buy, (meme, 10e6, type(uint256).max, block.timestamp + 60, root)
                )
            )
        );
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            for (uint256 rof; rof < 2; ++rof) {
                (bool ok, bytes memory ret) = exec(Entry(i), AGENT_PK, calls, rof == 1);
                assertFalse(ok, entryName(Entry(i)));
                assertEq(ret, err(IAgentPolicyHook.CallFailed.selector), entryName(Entry(i)));
                assertEq(usd.allowance(root, address(pad)), 0, entryName(Entry(i)));
                assertEq(spentUsd(kh), 0, entryName(Entry(i)));
            }
        }
        // Control: an unhooked key with revertOnFailure = false keeps the approval.
        grantControlKey();
        (bool okc,) = exec(Entry.Direct, CONTROL_PK, calls, false);
        assertTrue(okc);
        assertEq(usd.allowance(root, address(pad)), 10e6);
    }

    // ---------------------------------------------------------------------------------------
    // Metering: inflows and outflows
    // ---------------------------------------------------------------------------------------

    /// @notice §9 "inflow and outflow within one call and across calls": a call is charged its
    ///         own net balance decrease; an inflow (in the same call, an earlier call of the
    ///         batch or another transaction) never restores past usage.
    function test_attack_inflowAndOutflow_withinOneCallAndAcrossCalls() public {
        Swapper swapper = new Swapper();
        usd.mint(address(swapper), 1_000e6);
        rootExec1(
            address(usd), abi.encodeCall(IERC20.approve, (address(swapper), type(uint256).max))
        );
        bytes32 kh2 = grant(
            AGENT2_PK,
            withPermission(
                sessionPolicy(),
                CallPermission(address(swapper), Swapper.swap.selector, RuleKind.NONE)
            )
        );

        // Within one call: out 40, back 15 → charged 25.
        execOk(Entry.Direct, AGENT2_PK, one(swapCall(swapper, 40e6, 15e6)));
        assertEq(spentUsd(kh2), 25e6);
        // A net inflow call charges nothing and restores nothing.
        execOk(Entry.Direct, AGENT2_PK, one(swapCall(swapper, 10e6, 30e6)));
        assertEq(spentUsd(kh2), 25e6);
        // Another transaction's inflow restores nothing either.
        usd.mint(root, 500e6);
        assertEq(hook.remainingLimit(kh2, root, address(usd)), 25e6);

        // Across calls of one batch: an inflow first, then an outflow of 26 > the 25 left. The
        // batch is a net inflow (+4), yet the second call alone exceeds the period cap.
        Call[] memory batch = two(swapCall(swapper, 0, 30e6), swapCall(swapper, 26e6, 0));
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            (bool ok, bytes memory ret) = exec(Entry(i), AGENT2_PK, batch);
            assertFalse(ok, entryName(Entry(i)));
            assertEq(
                ret,
                abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, address(usd)),
                entryName(Entry(i))
            );
        }
        assertEq(spentUsd(kh2), 25e6);
    }

    function swapCall(Swapper swapper, uint256 out, uint256 back)
        internal
        view
        returns (Call memory)
    {
        return Call(address(swapper), 0, abi.encodeCall(Swapper.swap, (usd, root, out, back)));
    }

    // ---------------------------------------------------------------------------------------
    // Abnormal tokens
    // ---------------------------------------------------------------------------------------

    /// @notice §9 "abnormal balanceOf": the BUY/SELL `token` is chosen by the session. A token
    ///         whose balanceOf reverts fails the call closed; a lying token is not registered at
    ///         the launchpad (§4.4), so its buy fails and nothing is attributed.
    function test_attack_abnormalBalanceOf_failsClosed() public {
        RevertingBalanceToken broken = new RevertingBalanceToken();
        (bool ok, bytes memory ret) =
            exec(Entry.Direct, AGENT_PK, approveAndBuy(address(broken), 1e6));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSignature("Error(string)", "balanceOf disabled"));

        LyingToken liar = new LyingToken();
        liar.setReported(1e30);
        (ok, ret) = exec(Entry.Direct, AGENT_PK, approveAndBuy(address(liar), 1e6));
        assertFalse(ok);
        assertEq(ret, err(IAgentPolicyHook.CallFailed.selector));
        (ok, ret) = exec(Entry.Direct, AGENT_PK, one(sellCall(address(liar), 1)));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(IAgentPolicyHook.InventoryExceeded.selector, address(liar), 0)
        );
        assertEq(hook.inventory(kh, root, address(liar)), 0);
        assertEq(spentUsd(kh), 0);
    }

    /// @notice §9 "fee-on-transfer tokens (rejected / unsupported)". A FOT meme is attributed only
    ///         what actually arrived and cannot be sold (the account would lose more than
    ///         `amount`: PartialFill). See also `test_attack_feeOnTransferQuote_chargedWithFee`.
    function test_attack_feeOnTransferMeme_notSellable() public {
        FeeToken fot = new FeeToken();
        FeeLaunchpad fotPad = new FeeLaunchpad(address(usd));
        usd.mint(address(fotPad), 1_000e6);
        Policy memory p = sessionPolicy();
        p = withPermission(
            p, CallPermission(address(fotPad), ILaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY)
        );
        p = withPermission(
            p, CallPermission(address(fotPad), ILaunchpad.sell.selector, RuleKind.LAUNCHPAD_SELL)
        );
        p.trustedSpenders = new address[](2);
        p.trustedSpenders[0] = address(pad);
        p.trustedSpenders[1] = address(fotPad);
        bytes32 kh2 = grant(AGENT2_PK, p);

        Call[] memory buy = two(
            approveCall(address(fotPad), 10e6),
            Call(
                address(fotPad),
                0,
                abi.encodeCall(ILaunchpad.buy, (address(fot), 10e6, 0, block.timestamp + 60, root))
            )
        );
        execOk(Entry.Direct, AGENT2_PK, buy);
        assertEq(hook.inventory(kh2, root, address(fot)), 10e6);
        fot.mint(root, 1_000e6); // the human's own position covers the fee
        Call[] memory sell = one(
            address(fotPad),
            0,
            abi.encodeCall(ILaunchpad.sell, (address(fot), 10e6, 0, block.timestamp + 60, root))
        );
        (bool ok, bytes memory ret) = exec(Entry.Direct, AGENT2_PK, sell);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IAgentPolicyHook.PartialFill.selector, address(fot)));
    }

    /// @notice FOT as a quote asset: pulling 10 costs the account 10.1 and is charged 10.1.
    function test_attack_feeOnTransferQuote_chargedWithFee() public {
        FeeToken fot = new FeeToken();
        fot.mint(root, 1_000e6);
        Policy memory q = sessionPolicy();
        q.quoteLimits[0] = QuoteLimit(address(fot), 100e6, 50e6);
        q.permissions = new CallPermission[](1);
        q.permissions[0] = CallPermission(address(cb), CallbackTarget.run.selector, RuleKind.NONE);
        q.trustedSpenders = new address[](0);
        q.maxValuePerCall = 0;
        bytes32 kh3 = grant(0xF07, q);
        rootExec1(address(fot), abi.encodeCall(IERC20.approve, (address(cb), type(uint256).max)));
        uint256 before = fot.balanceOf(root);
        bytes memory pull = abi.encodeCall(IERC20.transferFrom, (root, bob, 10e6));
        execOk(
            Entry.Direct,
            0xF07,
            one(address(cb), 0, abi.encodeCall(CallbackTarget.run, (address(fot), pull)))
        );
        assertEq(before - fot.balanceOf(root), 10.1e6);
        assertEq(hook.getSpent(kh3, root, address(fot)).total, 10.1e6);
    }

    // ---------------------------------------------------------------------------------------
    // Re-entry and native pulls (the matrix covers them on every entry)
    // ---------------------------------------------------------------------------------------

    /// @notice §9 "re-entry through allowlisted callbacks", via the EntryPoint: during a session
    ///         call an allowlisted target submits another key's sponsored UserOp for this account.
    ///         Validation passes (it reads only the Summary) but its execution hits the account
    ///         lock, so the inner op does nothing.
    function test_attack_reentryThroughHandleOps_innerOpDoesNothing() public {
        bytes32 kh2 = grant(AGENT2_PK, sessionPolicy());
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp(AGENT2_PK, one(pullCall(10e6, attacker)), true);
        bytes32 innerHash = entryPoint.getUserOpHash(ops[0]);
        bytes memory reenter = abi.encodeCall(
            CallbackTarget.tryRun,
            (address(entryPoint), abi.encodeCall(IEntryPoint.handleOps, (ops, beneficiary)))
        );

        vm.expectEmit(true, true, false, true, address(entryPoint));
        emit IEntryPoint.UserOperationRevertReason(
            innerHash, root, ops[0].nonce, err(IAgentPolicyHook.Reentrancy.selector)
        );
        execOk(Entry.Direct, AGENT_PK, one(address(cb), 0, reenter));
        assertEq(usd.balanceOf(attacker), 0);
        assertEq(spentUsd(kh2), 0);
    }

    // ---------------------------------------------------------------------------------------
    // Third parties
    // ---------------------------------------------------------------------------------------

    /// @notice §9 "a third party calling sell to pull a victim's balance", and the other public
    ///         entries a third party can reach.
    function test_attack_thirdPartyCannotTouchVictim() public {
        rootExec(approveAndBuy(meme, HUMAN_MEME / pad.RATE()));
        execOk(Entry.Direct, AGENT_PK, approveAndBuy(meme, 10e6));
        uint256 memeBefore = IERC20(meme).balanceOf(root);
        uint256 inv = hook.inventory(kh, root, meme);

        vm.startPrank(attacker);
        vm.expectRevert();
        pad.sell(meme, inv, 0, block.timestamp, attacker);
        vm.expectRevert(MemeToken.NotLaunchpad.selector);
        MemeToken(meme).launchpadTransfer(root, inv);
        vm.expectRevert(err(UNAUTHORIZED));
        account.execute(
            BatchedCall(one(meme, 0, abi.encodeCall(IERC20.transfer, (attacker, 1))), true)
        );
        vm.expectRevert(err(UNAUTHORIZED));
        account.execute(MODE_REVERT, abi.encode(one(bob, 0, "")));
        vm.expectRevert(err(UNAUTHORIZED));
        IERC7914(root).approveNative(attacker, 1 ether);
        vm.expectRevert(IERC7914.AllowanceExceeded.selector);
        IERC7914(root).transferFromNative(root, attacker, 1);
        // The hook keys everything by msg.sender: these touch only the attacker's own namespace.
        hook.revoke(kh);
        hook.releaseInventory(kh, meme, 0);
        vm.expectRevert(err(IAgentPolicyHook.NotInExecution.selector));
        hook.afterExecute(kh, true, "", "");
        vm.stopPrank();

        assertEq(IERC20(meme).balanceOf(root), memeBefore);
        assertEq(hook.inventory(kh, root, meme), inv);
        assertTrue(hook.getSummary(kh, root).active);
        assertFalse(hook.getSummary(kh, root).revoked);
        execOk(Entry.Direct, AGENT_PK, one(sellCall(meme, inv)));
    }

    // ---------------------------------------------------------------------------------------
    // Nonces, replay, authorizations, grants
    // ---------------------------------------------------------------------------------------

    /// @notice §9 "cross-lane nonce consumption" — a known Calibur limitation (DESIGN §4.1): the
    ///         nonce is not bound to the keyHash, so one session can consume another key's lane.
    ///         Recorded here: it is a DoS only; the consuming key still runs under its own policy
    ///         and limits, the victim key's ledger is untouched. The sponsor rejects such requests.
    function test_knownLimitation_crossLaneNonceConsumption() public {
        bytes32 kh2 = grant(AGENT2_PK, sessionPolicy());
        uint192 lane2 = laneOf(kh2);

        // Relayer path: AGENT2 pre-signs on its lane; AGENT burns that sequence first.
        (SignedBatchedCall memory victim, bytes memory victimSig) =
            signedBatch(AGENT2_PK, kh2, one(bob, 0, ""), true, lane2, relayer);
        (SignedBatchedCall memory thief, bytes memory thiefSig) =
            signedBatch(AGENT_PK, kh, one(pullCall(5e6, bob)), true, lane2, relayer);
        (bool ok,) = relay(thief, thiefSig);
        assertTrue(ok);
        assertEq(spentUsd(kh), 5e6); // charged to the key that signed
        assertEq(spentUsd(kh2), 0);
        bytes memory ret;
        (ok, ret) = relay(victim, victimSig);
        assertFalse(ok);
        assertEq(ret, err(INonceManager.InvalidNonce.selector));

        // Bundler path: same on the EntryPoint nonce lanes.
        PackedUserOperation memory victimOp = unsignedUserOp(kh2, one(bob, 0, ""), true);
        sponsorOp(victimOp, pm, uint48(block.timestamp + 1 hours), 0);
        signUserOp(victimOp, AGENT2_PK, kh2);
        PackedUserOperation memory thiefOp = unsignedUserOp(kh2, one(pullCall(5e6, bob)), true);
        sponsorOp(thiefOp, pm, uint48(block.timestamp + 1 hours), 0);
        signUserOp(thiefOp, AGENT_PK, kh);
        (ok,) = handle(thiefOp);
        assertTrue(ok);
        assertEq(spentUsd(kh), 10e6);
        assertEq(spentUsd(kh2), 0);
        (ok, ret) = handle(victimOp);
        assertFalse(ok);
        assertEq(ret, failedOp("AA25 invalid account nonce"));
    }

    /// @notice §9 "cross-path replay": a relayer signature is not a UserOp signature and vice
    ///         versa (different digests), and each path rejects its own replay.
    function test_attack_crossPathReplay() public {
        Call[] memory calls = one(pullCall(5e6, bob));
        (SignedBatchedCall memory sbc, bytes memory sbcSig) =
            signedBatch(AGENT_PK, kh, calls, true, laneOf(kh), relayer);
        PackedUserOperation memory op = userOp(AGENT_PK, calls, true);

        // UserOp carrying the relayer signature: the account reports SIG_VALIDATION_FAILED.
        PackedUserOperation memory forged = unsignedUserOp(kh, calls, true);
        sponsorOp(forged, pm, uint48(block.timestamp + 1 hours), 0);
        (bytes memory rawSbcSig,) = abi.decode(sbcSig, (bytes, bytes));
        forged.signature = abi.encode(kh, rawSbcSig, bytes(""));
        (bool ok, bytes memory ret) = handle(forged);
        assertFalse(ok);
        assertEq(ret, failedOp("AA24 signature error"));

        // Relayer batch carrying the UserOp signature.
        (, bytes memory rawOpSig,) = abi.decode(op.signature, (bytes32, bytes, bytes));
        (ok, ret) = relay(sbc, abi.encode(rawOpSig, bytes("")));
        assertFalse(ok);
        assertEq(ret, err(ICalibur.InvalidSignature.selector));

        // Each executes once; a replay on the same path is refused.
        (ok,) = relay(sbc, sbcSig);
        assertTrue(ok);
        (ok, ret) = relay(sbc, sbcSig);
        assertFalse(ok);
        assertEq(ret, err(INonceManager.InvalidNonce.selector));
        (ok,) = handle(op);
        assertTrue(ok);
        (ok, ret) = handle(op);
        assertFalse(ok);
        assertEq(ret, failedOp("AA25 invalid account nonce"));
        assertEq(spentUsd(kh), 10e6);
    }

    /// @notice §9 "a front-run authorization": anyone can land the root's signed EIP-7702
    ///         authorization first. It only installs the implementation the root chose; Calibur
    ///         has no initializer, so the attacker gains no key and no control, and the root's own
    ///         init batch still works afterwards.
    function test_attack_frontRunAuthorization_givesNothing() public {
        uint256 victimPk = 0xB0B0;
        address victim = vm.addr(victimPk);
        usd.mint(victim, 100e6);
        assertEq(victim.code.length, 0);

        vm.signAndAttachDelegation(calibur, victimPk);
        vm.prank(attacker);
        (bool sent,) = victim.call("");
        assertTrue(sent);
        assertEq(victim.code, delegation(calibur));

        ICalibur v = ICalibur(victim);
        assertEq(v.keyCount(), 0);
        Key memory evil = Key(KeyType.Secp256k1, abi.encode(attacker));
        vm.startPrank(attacker);
        vm.expectRevert(err(UNAUTHORIZED));
        v.register(evil);
        vm.expectRevert(err(UNAUTHORIZED));
        v.execute(
            BatchedCall(one(address(usd), 0, abi.encodeCall(IERC20.transfer, (attacker, 1))), true)
        );
        vm.expectRevert(err(UNAUTHORIZED));
        v.updateEntryPoint(attacker);
        vm.stopPrank();
        assertEq(usd.balanceOf(victim), 100e6);

        // The root's init batch (no second authorization needed) still grants its key.
        Call[] memory calls = new Call[](2);
        Key memory agentKey = Key(KeyType.Secp256k1, abi.encode(vm.addr(AGENT_PK)));
        calls[0] = Call(victim, 0, abi.encodeCall(IKeyManagement.register, (agentKey)));
        calls[1] = Call(victim, 0, abi.encodeCall(IERC7914.approveNative, (ERC20ETH, 0)));
        vm.prank(victim);
        v.execute(BatchedCall(calls, true));
        assertTrue(v.isRegistered(keyHashOf(AGENT_PK)));
    }

    /// @notice §9 "retry after a failed grant": an atomic grant that fails leaves nothing; a
    ///         non-atomic one that fails in `setPolicy` leaves a hooked key that cannot execute
    ///         (fail closed) until the root retries `setPolicy`; a tombstone ends it for good.
    function test_attack_retryAfterFailedGrant() public {
        Policy memory bad = sessionPolicy();
        bad.quoteLimits = new QuoteLimit[](0); // BUY without its quote limit; approve not quote
        Call[] memory g = grantCalls(AGENT2_PK, bad, expiry);
        bytes32 kh2 = keyHashOf(AGENT2_PK);

        vm.prank(root);
        vm.expectRevert();
        account.execute(BatchedCall(g, true));
        assertFalse(account.isRegistered(kh2));
        assertFalse(hook.getSummary(kh2, root).initialized);

        // revertOnFailure = false: Calibur key + hook attached, policy missing.
        vm.prank(root);
        account.execute(BatchedCall(g, false));
        assertTrue(account.isRegistered(kh2));
        assertFalse(hook.getSummary(kh2, root).initialized);
        bytes memory inactive = err(IAgentPolicyHook.SessionInactive.selector);
        bytes[4] memory expected =
            [inactive, inactive, inactive, failedOpWithRevert("AA23 reverted", inactive)];
        for (uint256 i; i < ENTRY_COUNT; ++i) {
            (bool ok, bytes memory ret) = exec(Entry(i), AGENT2_PK, one(bob, 0, ""));
            assertFalse(ok, entryName(Entry(i)));
            assertEq(ret, expected[i], entryName(Entry(i)));
        }

        // Retry only the policy: the key works.
        rootExec1(address(hook), abi.encodeCall(IAgentPolicyHook.setPolicy, (kh2, sessionPolicy())));
        execOk(Entry.Signed, AGENT2_PK, one(bob, 1 ether, ""));

        // A key whose grant is abandoned can be tombstoned pre-emptively: never grantable.
        bytes32 kh3 = keyHashOf(0xDEAD);
        rootExec1(address(hook), abi.encodeCall(IAgentPolicyHook.revoke, (kh3)));
        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(
                ICalibur.CallFailed.selector, err(IAgentPolicyHook.SessionRevoked.selector)
            )
        );
        account.execute(BatchedCall(grantCalls(0xDEAD, sessionPolicy(), expiry), true));
    }
}

/// @notice I8 control: the init batch's `approveNative(ERC20ETH, 0)` is the protection. On an
///         account initialised without it, the allowlisted ERC20ETH pulls native MNT out of the
///         account unmetered (the hook meters MNT by call value only, DESIGN §4.2.3 step 5).
contract NativePullWithoutInitRevocationTest is CaliburSessionBase {
    function test_I8_control_withoutInitRevocation_erc20EthPullsNativeUnmetered() public {
        bytes32 kh = initAccount(false);
        assertEq(account.nativeAllowance(ERC20ETH), type(uint256).max);
        (bool ok, bytes memory ret) = exec(Entry.Direct, AGENT_PK, one(nativePullCall(50 ether)));
        assertTrue(ok, vm.toString(ret));
        assertEq(attacker.balance, 50 ether);
        assertEq(hook.getSpent(kh, root, address(0)).total, 0);
    }
}
