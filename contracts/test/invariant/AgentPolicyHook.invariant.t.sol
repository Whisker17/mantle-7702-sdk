// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC7914} from "calibur/interfaces/IERC7914.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {Settings} from "calibur/libraries/SettingsLib.sol";
import {SignedBatchedCall} from "calibur/libraries/SignedBatchedCallLib.sol";
import {IAgentPolicyHook, Policy} from "../../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {MemeToken} from "../../src/mocks/MemeToken.sol";
import {CaliburSessionBase} from "../hook/CaliburSessionBase.sol";
import {CallbackTarget} from "../hook/HookTestHelpers.sol";

/// @notice Stateful invariants DESIGN §4.2.5 I1–I5, I8–I13 against a real 7702-delegated
///         CaliburEntry v1.1.0, the real EntryPoint v0.8 and the VerifyingPaymaster. The fuzzer
///         drives three session keys (on all four execution entries), the root and third parties.
/// @dev The test contract is its own handler (`targetSelector` lists the actions). Every
///      expectation is measured independently of the hook's ledger: balances around each
///      session batch (ghost outflow / bought / sold), the configured caps, and a violation
///      counter per invariant for actions that must never succeed. Session keys never expire
///      (Calibur expiry 0) so the campaign stays live; expiry is covered by the matrix.
contract AgentPolicyHookInvariantTest is CaliburSessionBase {
    uint256 internal constant KEYS = 3;
    uint256 internal constant MEMES = 2;
    uint256 internal constant DAY = 1 days;

    uint256[KEYS] internal pks = [AGENT_PK, AGENT2_PK, uint256(0xA6E49)];
    bytes32[KEYS] internal khs;
    address[MEMES] internal memes;
    uint256 internal anchor;
    uint256 internal initialMnt;

    // Configured caps (the root may only lower them); `*Cap0` are the caps at grant time.
    uint256[KEYS] internal usdTotalCap0;
    uint256[KEYS] internal usdTotalCap;
    uint256[KEYS] internal usdPeriodCap;
    uint256[KEYS] internal mntTotalCap;
    uint256[KEYS] internal mntPeriodCap;
    uint256[KEYS] internal maxValue;
    bytes32[KEYS] internal policyHash;
    bool[KEYS] internal revoked;

    // Ghosts measured from balances around successful session batches.
    uint256[KEYS] internal ghostUsdOut;
    uint256[KEYS] internal ghostMntOut;
    mapping(uint256 key => mapping(uint256 window => uint256)) internal ghostUsdOutWindow;
    mapping(uint256 key => mapping(uint256 window => uint256)) internal ghostMntOutWindow;
    uint256[MEMES][KEYS] internal ghostBought;
    uint256[MEMES][KEYS] internal ghostSold;
    uint256[MEMES][KEYS] internal ghostReleased;
    uint256 internal ghostMntInflow;

    // Violations: an action that must fail succeeded, or a failure left a side effect.
    uint256 public vI1;
    uint256 public vI2;
    uint256 public vI3;
    uint256 public vI4;
    uint256 public vI5;
    uint256 public vI8;
    uint256 public vI9;
    uint256 public vI10;
    uint256 public vI11;
    uint256 public vI12;
    uint256 public vI13;
    uint256 public vDeadlineRecipient;

    // Coverage counters (reported by `afterInvariant`-free runs through -vvv traces).
    uint256 public sessionSuccesses;
    uint256 public sessionFailures;

    function setUp() public override {
        super.setUp();
        expiry = 0;
        memes[0] = meme;
        memes[1] = pad.createToken("Meme2", "MEME2");
        khs[0] = initAccount();
        anchor = block.timestamp;
        Policy memory p1 = sessionPolicy();
        p1.quoteLimits[0].totalCap = 60e6;
        p1.quoteLimits[0].periodCap = 30e6;
        khs[1] = grant(pks[1], p1);
        Policy memory p2 = sessionPolicy();
        p2.quoteLimits[0].totalCap = 200e6;
        p2.quoteLimits[0].periodCap = 80e6;
        p2.maxValuePerCall = 0.5 ether;
        p2.mntLimit.totalCap = 2 ether;
        p2.mntLimit.periodCap = 1 ether;
        khs[2] = grant(pks[2], p2);
        for (uint256 k; k < KEYS; ++k) {
            (Policy memory p,) = hook.getPolicy(khs[k], root);
            usdTotalCap[k] = p.quoteLimits[0].totalCap;
            usdTotalCap0[k] = usdTotalCap[k];
            usdPeriodCap[k] = p.quoteLimits[0].periodCap;
            mntTotalCap[k] = p.mntLimit.totalCap;
            mntPeriodCap[k] = p.mntLimit.periodCap;
            maxValue[k] = p.maxValuePerCall;
            policyHash[k] = keccak256(abi.encode(p));
        }
        // The human's own positions in both memes (never attributed to a session).
        for (uint256 t; t < MEMES; ++t) {
            rootExec(approveAndBuy(memes[t], 100e6));
        }
        initialMnt = root.balance;

        bytes4[] memory selectors = new bytes4[](19);
        selectors[0] = this.act_approve.selector;
        selectors[1] = this.act_buy.selector;
        selectors[2] = this.act_sell.selector;
        selectors[3] = this.act_pull.selector;
        selectors[4] = this.act_sendMnt.selector;
        selectors[5] = this.act_forbidden.selector;
        selectors[6] = this.act_reenter.selector;
        selectors[7] = this.act_erc1271.selector;
        selectors[8] = this.act_wrongPaymaster.selector;
        selectors[9] = this.root_revoke.selector;
        selectors[10] = this.root_regrant.selector;
        selectors[11] = this.root_release.selector;
        selectors[12] = this.root_dispose.selector;
        selectors[13] = this.root_lowerCaps.selector;
        selectors[14] = this.root_invalidUpdate.selector;
        selectors[15] = this.third_inflow.selector;
        selectors[16] = this.third_airdrop.selector;
        selectors[17] = this.third_attack.selector;
        selectors[18] = this.warp.selector;
        targetSelector(StdInvariant.FuzzSelector(address(this), selectors));
        targetContract(address(this));
    }

    // =======================================================================================
    // Invariants
    // =======================================================================================

    /// @notice I1: no (target, selector) outside `permissions` ever executes, on any entry.
    function invariant_I1_noCallOutsidePermissions() public view {
        assertEq(vI1, 0, "I1");
    }

    /// @notice I2: each key's measured MockUSD and MNT net outflow stays within the total and
    ///         per-window caps, and the hook never under-counts it.
    function invariant_I2_outflowWithinCaps() public view {
        assertEq(vI2, 0, "I2 cap exceeded");
        for (uint256 k; k < KEYS; ++k) {
            assertLe(ghostUsdOut[k], usdTotalCap0[k], "I2 usd total");
            assertGe(
                hook.getSpent(khs[k], root, address(usd)).total, ghostUsdOut[k], "I2 usd metered"
            );
            assertLe(ghostMntOut[k], mntTotalCap[k], "I2 mnt total");
            assertGe(
                hook.getSpent(khs[k], root, address(0)).total, ghostMntOut[k], "I2 mnt metered"
            );
        }
    }

    /// @notice I3: sessions change no policy and no Calibur key settings.
    function invariant_I3_sessionsCannotChangePolicy() public view {
        assertEq(vI3, 0, "I3");
        for (uint256 k; k < KEYS; ++k) {
            (Policy memory p,) = hook.getPolicy(khs[k], root);
            assertEq(keccak256(abi.encode(p)), policyHash[k], "I3 policy");
            if (!revoked[k]) {
                assertEq(
                    Settings.unwrap(account.getKeySettings(khs[k])),
                    Settings.unwrap(settingsFor(address(hook), 0)),
                    "I3 settings"
                );
            }
        }
        assertEq(account.keyCount(), _liveKeys(), "I3 key set");
    }

    /// @notice I4: no session key ever produces a valid ERC-1271 signature.
    function invariant_I4_noSessionErc1271() public view {
        assertEq(vI4, 0, "I4");
    }

    /// @notice I5: approvals only to trusted spenders, within the remaining limit.
    function invariant_I5_onlyTrustedSpendersHoldAllowances() public view {
        assertEq(vI5, 0, "I5");
        address[5] memory untrusted = [attacker, bob, address(hook), ERC20ETH, address(entryPoint)];
        for (uint256 i; i < untrusted.length; ++i) {
            assertEq(usd.allowance(root, untrusted[i]), 0, "I5 untrusted allowance");
        }
    }

    /// @notice I8 + I10: MNT leaves the account only as metered session call value (no ERC-7914
    ///         pull, no UserOp prefund), and the account's EntryPoint deposit stays 0.
    function invariant_I8_I10_mntConservation() public view {
        assertEq(vI8, 0, "I8");
        assertEq(vI10, 0, "I10");
        uint256 out;
        for (uint256 k; k < KEYS; ++k) {
            out += ghostMntOut[k];
        }
        assertEq(root.balance + out, initialMnt + ghostMntInflow, "I8/I10 MNT conservation");
        assertEq(entryPoint.balanceOf(root), 0, "I10 account deposit");
    }

    /// @notice I9: a key sells at most what it bought (minus root releases); the ledger matches
    ///         the measured flows; `reserved` is the sum of inventories; SELL fails closed on a gap.
    function invariant_I9_inventoryAttribution() public view {
        assertEq(vI9, 0, "I9");
        for (uint256 t; t < MEMES; ++t) {
            uint256 sum;
            for (uint256 k; k < KEYS; ++k) {
                assertLe(ghostSold[k][t] + ghostReleased[k][t], ghostBought[k][t], "I9 oversold");
                uint256 inv = hook.inventory(khs[k], root, memes[t]);
                assertEq(inv, _modelInventory(k, t), "I9 ledger");
                sum += inv;
            }
            assertEq(hook.reserved(root, memes[t]), sum, "I9 reserved");
        }
    }

    /// @notice I11: a revoked keyHash stays dead.
    function invariant_I11_tombstonesArePermanent() public view {
        assertEq(vI11, 0, "I11");
        for (uint256 k; k < KEYS; ++k) {
            if (!revoked[k]) continue;
            assertTrue(hook.getSummary(khs[k], root).revoked, "I11 tombstone");
            assertFalse(hook.getSummary(khs[k], root).active, "I11 inactive");
        }
    }

    /// @notice I12: a failed target or a re-entry reverts everything (no side effect).
    function invariant_I12_failuresHaveNoSideEffects() public view {
        assertEq(vI12, 0, "I12");
        assertEq(vDeadlineRecipient, 0, "deadline / recipient");
    }

    /// @notice I13: the root cannot leave a quote-asset spending path unmetered or raise a cap.
    function invariant_I13_policyValidity() public view {
        assertEq(vI13, 0, "I13");
    }

    // =======================================================================================
    // Session actions
    // =======================================================================================

    function act_approve(uint256 keySeed, uint256 entrySeed, uint256 amount) external {
        uint256 k = keySeed % KEYS;
        amount = bound(amount, 0, 120e6);
        uint256 remaining = _modelRemaining(k);
        bool ok = _session(k, entrySeed, one(approveCall(address(pad), amount)), true);
        if (ok && amount > remaining) ++vI5;
    }

    function act_buy(
        uint256 keySeed,
        uint256 entrySeed,
        uint256 tokenSeed,
        uint256 amountIn,
        bool withApprove
    ) external {
        uint256 k = keySeed % KEYS;
        address token = memes[tokenSeed % MEMES];
        // Mostly within the caps, sometimes beyond; mostly with its own approve, sometimes on a
        // leftover allowance.
        amountIn = amountIn % 8 == 0 ? bound(amountIn, 1, 90e6) : bound(amountIn, 1, 25e6);
        Call[] memory calls = withApprove || amountIn % 3 != 0
            ? approveAndBuy(token, amountIn)
            : one(buyCall(token, amountIn));
        _session(k, entrySeed, calls, true);
    }

    function act_sell(uint256 keySeed, uint256 entrySeed, uint256 tokenSeed, uint256 amount)
        external
    {
        uint256 k = keySeed % KEYS;
        uint256 t = tokenSeed % MEMES;
        uint256 held = _modelInventory(k, t);
        // Half within the key's attribution, half beyond it (into the human's position).
        amount = amount % 2 == 0 && held != 0
            ? bound(amount, 1, held)
            : bound(amount, held + 1, held + 20e21);
        bool gap = IERC20(memes[t]).balanceOf(root) < _modelReserved(t);
        bool ok = _session(k, entrySeed, one(sellCall(memes[t], amount)), true);
        if (ok && gap) ++vI9;
    }

    function act_pull(uint256 keySeed, uint256 entrySeed, uint256 amount) external {
        _session(keySeed % KEYS, entrySeed, one(pullCall(bound(amount, 1, 70e6), bob)), true);
    }

    function act_sendMnt(uint256 keySeed, uint256 entrySeed, uint256 value) external {
        _session(keySeed % KEYS, entrySeed, one(bob, bound(value, 0, 1.2 ether), ""), true);
    }

    /// @notice A batch that must be rejected, each aimed at one protection.
    function act_forbidden(uint256 keySeed, uint256 entrySeed, uint256 kind, uint256 x) external {
        uint256 k = keySeed % KEYS;
        kind = kind % 17;
        (Call[] memory calls, bool rof) = _forbidden(k, kind, x);
        if (_session(k, entrySeed, calls, rof)) {
            if (kind <= 3) ++vI1;
            else if (kind <= 7) ++vI3;
            else if (kind <= 9) ++vI5;
            else if (kind == 10) ++vI8;
            else if (kind == 11) ++vI12;
            else if (kind <= 13) ++vDeadlineRecipient;
            else if (kind == 14) ++vI9;
            else ++vI2;
        }
    }

    /// @notice An allowlisted target re-enters the account with another (or the same) key's
    ///         relayable batch; the outer call swallows the failure, the inner must do nothing.
    function act_reenter(uint256 keySeed, uint256 innerSeed, uint256 entrySeed) external {
        uint256 k = keySeed % KEYS;
        uint256 j = innerSeed % KEYS;
        if (revoked[j]) return;
        (SignedBatchedCall memory sbc, bytes memory sig) = signedBatch(
            pks[j], khs[j], one(pullCall(1e6, attacker)), true, laneOf(khs[j]) + 1, address(cb)
        );
        bytes memory reenter = abi.encodeCall(
            CallbackTarget.tryRun,
            (
                root,
                abi.encodeWithSignature(
                    "execute((((address,uint256,bytes)[],bool),uint256,bytes32,address,uint256),bytes)",
                    sbc,
                    sig
                )
            )
        );
        uint256 attackerBefore = usd.balanceOf(attacker);
        _session(k, entrySeed, one(address(cb), 0, reenter), true);
        if (usd.balanceOf(attacker) != attackerBefore) ++vI12;
    }

    function act_erc1271(uint256 keySeed, bytes32 digest) external {
        (bool ok,) = session1271(pks[keySeed % KEYS], digest);
        if (ok) ++vI4;
    }

    /// @notice I10: a session UserOp without our paymaster (none / another address) or with a
    ///         callData other than `executeUserOp` never validates, and costs the account nothing.
    function act_wrongPaymaster(uint256 keySeed, uint256 kind) external {
        uint256 k = keySeed % KEYS;
        PackedUserOperation memory op = unsignedUserOp(khs[k], one(bob, 0, ""), true);
        kind = kind % 3;
        if (kind == 1) {
            op.paymasterAndData = abi.encodePacked(bob, uint128(100_000), uint128(0));
        } else if (kind == 2) {
            sponsorOp(op, pm, uint48(block.timestamp + 1 hours), 0);
            op.callData = abi.encodeWithSelector(
                bytes4(keccak256("execute(((address,uint256,bytes)[],bool))")),
                BatchedCall(one(bob, 0, ""), true)
            );
            sponsorOp(op, pm, uint48(block.timestamp + 1 hours), 0);
        }
        signUserOp(op, pks[k], khs[k]);
        (bool ok,) = handle(op);
        if (ok) ++vI10;
    }

    // =======================================================================================
    // Root actions
    // =======================================================================================

    /// @dev The SDK revoke batch; biased so that most runs keep live keys.
    function root_revoke(uint256 keySeed) external {
        uint256 k = keySeed % KEYS;
        if (revoked[k] || uint256(keccak256(abi.encode(keySeed))) % 16 != 0) return;
        address[] memory spenders = new address[](1);
        spenders[0] = address(pad);
        rootExec(revokeCalls(khs[k], spenders));
        revoked[k] = true;
    }

    function root_regrant(uint256 keySeed) external {
        uint256 k = keySeed % KEYS;
        if (!revoked[k]) return;
        vm.prank(root);
        try account.execute(BatchedCall(grantCalls(pks[k], sessionPolicy(), 0), true)) {
            ++vI11;
        } catch {}
    }

    function root_release(uint256 keySeed, uint256 tokenSeed, uint256 amount) external {
        uint256 k = keySeed % KEYS;
        uint256 t = tokenSeed % MEMES;
        amount = bound(amount, 0, _modelInventory(k, t));
        rootExec1(
            address(hook),
            abi.encodeCall(IAgentPolicyHook.releaseInventory, (khs[k], memes[t], amount))
        );
        ghostReleased[k][t] += amount;
    }

    /// @dev The root sells / sends meme away, with or without the release tuple (DESIGN §4.2.6).
    function root_dispose(uint256 tokenSeed, uint256 amount, uint256 keySeed, bool withRelease)
        external
    {
        uint256 t = tokenSeed % MEMES;
        uint256 balance = IERC20(memes[t]).balanceOf(root);
        uint256 reservedT = _modelReserved(t);
        uint256 unallocated = balance > reservedT ? balance - reservedT : 0;
        if (!withRelease) {
            // A correct root disposes of the unallocated part; one in eight breaks the rule
            // and opens an attribution gap.
            if (amount % 8 != 0) {
                if (unallocated == 0) return;
                amount = bound(amount, 1, unallocated);
            } else {
                if (balance == 0) return;
                amount = bound(amount, 1, balance);
            }
            rootExec(one(Call(memes[t], 0, abi.encodeCall(IERC20.transfer, (bob, amount)))));
            return;
        }
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        Call memory transfer = Call(memes[t], 0, abi.encodeCall(IERC20.transfer, (bob, amount)));
        uint256 k = keySeed % KEYS;
        uint256 released = amount < _modelInventory(k, t) ? amount : _modelInventory(k, t);
        rootExec(
            two(
                Call(
                    address(hook),
                    0,
                    abi.encodeCall(IAgentPolicyHook.releaseInventory, (khs[k], memes[t], released))
                ),
                transfer
            )
        );
        ghostReleased[k][t] += released;
    }

    function root_lowerCaps(uint256 keySeed, uint256 total, uint256 period) external {
        uint256 k = keySeed % KEYS;
        if (revoked[k]) return;
        (Policy memory p,) = hook.getPolicy(khs[k], root);
        p.quoteLimits[0].totalCap = bound(total, 0, p.quoteLimits[0].totalCap);
        p.quoteLimits[0].periodCap = bound(period, 0, p.quoteLimits[0].periodCap);
        rootExec1(address(hook), abi.encodeCall(IAgentPolicyHook.updatePolicy, (khs[k], p)));
        usdTotalCap[k] = p.quoteLimits[0].totalCap;
        usdPeriodCap[k] = p.quoteLimits[0].periodCap;
        policyHash[k] = keccak256(abi.encode(p));
    }

    /// @notice I13: updates that would raise a cap, drop the metered asset while keeping BUY,
    ///         or move the window must be refused.
    function root_invalidUpdate(uint256 keySeed, uint256 kind, uint256 x) external {
        uint256 k = keySeed % KEYS;
        if (revoked[k]) return;
        (Policy memory p,) = hook.getPolicy(khs[k], root);
        kind = kind % 4;
        if (kind == 0) {
            p.quoteLimits[0].totalCap += bound(x, 1, 1e30);
        } else if (kind == 1) {
            p.quoteLimits[0].periodCap += bound(x, 1, 1e30);
        } else if (kind == 2) {
            // Swap the metered asset for another one while BUY on its launchpad stays.
            p.quoteLimits[0].token = makeAddr(string.concat("otherQuote", vm.toString(x % 8)));
        } else {
            p.periodLength = uint32(bound(x, 0, 30 days));
            if (p.periodLength == DAY) p.periodLength = 0;
        }
        vm.prank(root);
        try account.execute(
            BatchedCall(
                one(address(hook), 0, abi.encodeCall(IAgentPolicyHook.updatePolicy, (khs[k], p))),
                true
            )
        ) {
            ++vI13;
        } catch {}
    }

    // =======================================================================================
    // Third parties and time
    // =======================================================================================

    function third_inflow(uint256 usdAmount, uint256 mntAmount) external {
        usd.mint(root, bound(usdAmount, 0, 50e6));
        mntAmount = bound(mntAmount, 0, 1 ether);
        vm.deal(bob, bob.balance + mntAmount);
        vm.prank(bob);
        (bool sent,) = root.call{value: mntAmount}("");
        if (sent) ghostMntInflow += mntAmount;
    }

    /// @notice Meme arriving from outside (airdrop / direct transfer): never attributed.
    function third_airdrop(uint256 tokenSeed, uint256 usdAmount) external {
        address token = memes[tokenSeed % MEMES];
        usdAmount = bound(usdAmount, 1, 20e6);
        usd.mint(attacker, usdAmount);
        vm.startPrank(attacker);
        usd.approve(address(pad), usdAmount);
        pad.buy(token, usdAmount, 0, block.timestamp, root);
        vm.stopPrank();
    }

    /// @notice Public entries a third party can reach; none may affect the account.
    function third_attack(uint256 kind, uint256 keySeed, uint256 amount) external {
        uint256 k = keySeed % KEYS;
        address token = memes[amount % MEMES];
        amount = bound(amount, 1, 1e24);
        bytes32 before = _victimFingerprint();
        vm.startPrank(attacker);
        kind = kind % 7;
        if (kind == 0) {
            try pad.sell(token, amount, 0, block.timestamp, attacker) {} catch {}
        } else if (kind == 1) {
            try MemeToken(token).launchpadTransfer(root, amount) {} catch {}
        } else if (kind == 2) {
            try account.execute(
                BatchedCall(
                    one(address(usd), 0, abi.encodeCall(IERC20.transfer, (attacker, 1))), true
                )
            ) {}
                catch {}
        } else if (kind == 3) {
            try IERC7914(root).transferFromNative(root, attacker, amount) {} catch {}
        } else if (kind == 4) {
            hook.revoke(khs[k]);
        } else if (kind == 5) {
            try hook.releaseInventory(khs[k], token, amount) {} catch {}
        } else {
            try usd.transferFrom(root, attacker, amount) {} catch {}
        }
        vm.stopPrank();
        if (_victimFingerprint() != before) ++vI12;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    // =======================================================================================
    // Internals
    // =======================================================================================

    struct Balances {
        uint256 usd;
        uint256 mnt;
        uint256[MEMES] memes;
    }

    function _balances() internal view returns (Balances memory b) {
        b.usd = usd.balanceOf(root);
        b.mnt = root.balance;
        for (uint256 t; t < MEMES; ++t) {
            b.memes[t] = IERC20(memes[t]).balanceOf(root);
        }
    }

    /// @dev Runs a session batch and books the measured flows of a success; a failure must leave
    ///      no trace (I12). A success of a revoked key is an I11 violation.
    function _session(uint256 k, uint256 entrySeed, Call[] memory calls, bool rof)
        internal
        returns (bool ok)
    {
        Balances memory b = _balances();
        bytes32 fp = _fingerprint(k);
        (ok,) = exec(Entry(entrySeed % ENTRY_COUNT), pks[k], calls, rof);
        if (!ok) {
            ++sessionFailures;
            if (
                _fingerprint(k) != fp
                    || keccak256(abi.encode(_balances())) != keccak256(abi.encode(b))
            ) {
                ++vI12;
            }
            return false;
        }
        ++sessionSuccesses;
        if (revoked[k]) ++vI11;
        Balances memory a = _balances();
        uint256 w = (block.timestamp - anchor) / DAY;
        if (a.usd < b.usd) {
            uint256 d = b.usd - a.usd;
            ghostUsdOut[k] += d;
            ghostUsdOutWindow[k][w] += d;
            if (ghostUsdOut[k] > usdTotalCap[k] || ghostUsdOutWindow[k][w] > usdPeriodCap[k]) {
                ++vI2;
            }
        }
        if (a.mnt < b.mnt) {
            uint256 d = b.mnt - a.mnt;
            ghostMntOut[k] += d;
            ghostMntOutWindow[k][w] += d;
            if (ghostMntOut[k] > mntTotalCap[k] || ghostMntOutWindow[k][w] > mntPeriodCap[k]) {
                ++vI2;
            }
        }
        for (uint256 t; t < MEMES; ++t) {
            if (a.memes[t] > b.memes[t]) ghostBought[k][t] += a.memes[t] - b.memes[t];
            else ghostSold[k][t] += b.memes[t] - a.memes[t];
        }
    }

    function _fingerprint(uint256 k) internal view returns (bytes32) {
        bytes32 kh = khs[k];
        return keccak256(
            abi.encode(
                hook.getSpent(kh, root, address(usd)),
                hook.getSpent(kh, root, address(0)),
                hook.inventory(kh, root, memes[0]),
                hook.inventory(kh, root, memes[1]),
                hook.reserved(root, memes[0]),
                hook.reserved(root, memes[1]),
                usd.allowance(root, address(pad)),
                usd.allowance(root, attacker),
                usd.balanceOf(attacker),
                attacker.balance
            )
        );
    }

    function _victimFingerprint() internal view returns (bytes32 h) {
        h = keccak256(abi.encode(_balances()));
        for (uint256 k; k < KEYS; ++k) {
            h = keccak256(abi.encode(h, _fingerprint(k), hook.getSummary(khs[k], root)));
        }
    }

    function _modelInventory(uint256 k, uint256 t) internal view returns (uint256) {
        uint256 out = ghostSold[k][t] + ghostReleased[k][t];
        return ghostBought[k][t] > out ? ghostBought[k][t] - out : 0;
    }

    function _modelReserved(uint256 t) internal view returns (uint256 sum) {
        for (uint256 k; k < KEYS; ++k) {
            sum += _modelInventory(k, t);
        }
    }

    /// @dev Upper bound on what the hook may allow: min(total, period) minus measured outflow.
    function _modelRemaining(uint256 k) internal view returns (uint256) {
        uint256 w = (block.timestamp - anchor) / DAY;
        uint256 total = usdTotalCap[k] > ghostUsdOut[k] ? usdTotalCap[k] - ghostUsdOut[k] : 0;
        uint256 period = usdPeriodCap[k] > ghostUsdOutWindow[k][w]
            ? usdPeriodCap[k] - ghostUsdOutWindow[k][w]
            : 0;
        return total < period ? total : period;
    }

    function _liveKeys() internal view returns (uint256 n) {
        for (uint256 k; k < KEYS; ++k) {
            if (!revoked[k]) ++n;
        }
    }

    function _forbidden(uint256 k, uint256 kind, uint256 x)
        internal
        view
        returns (Call[] memory calls, bool rof)
    {
        rof = true;
        uint256 amount = bound(x, 1, 10e6);
        if (kind == 0) {
            calls = one(address(usd), 0, abi.encodeCall(IERC20.transfer, (attacker, amount)));
        } else if (kind == 1) {
            calls = one(memes[x % MEMES], 0, abi.encodeCall(IERC20.transfer, (attacker, 1e18)));
        } else if (kind == 2) {
            calls = one(attacker, 0, "");
        } else if (kind == 3) {
            calls = one(address(pad), 0, abi.encodeCall(pad.createToken, ("E", "E")));
        } else if (kind == 4) {
            Policy memory p = sessionPolicy();
            p.quoteLimits[0].totalCap = type(uint128).max;
            calls =
                one(address(hook), 0, abi.encodeCall(IAgentPolicyHook.updatePolicy, (khs[k], p)));
        } else if (kind == 5) {
            calls = one(
                address(hook),
                0,
                abi.encodeCall(
                    IAgentPolicyHook.releaseInventory, (khs[(k + 1) % KEYS], memes[0], 0)
                )
            );
        } else if (kind == 6) {
            Key memory key = Key(KeyType.Secp256k1, abi.encode(attacker));
            calls = one(root, 0, abi.encodeCall(IKeyManagement.register, (key)));
        } else if (kind == 7) {
            calls = one(
                address(entryPoint),
                0,
                abi.encodeCall(IStakeManager.withdrawTo, (payable(attacker), 0))
            );
        } else if (kind == 8) {
            calls = one(approveCall(attacker, amount));
        } else if (kind == 9) {
            calls = one(
                address(usd),
                0,
                abi.encodeWithSignature("increaseAllowance(address,uint256)", address(pad), amount)
            );
        } else if (kind == 10) {
            calls = one(nativePullCall(bound(x, 1, 5 ether)));
        } else if (kind == 11) {
            calls = two(
                pullCall(1, bob), Call(address(cb), 0, abi.encodeCall(CallbackTarget.fail, ()))
            );
            rof = false;
        } else if (kind == 12) {
            calls = two(
                approveCall(address(pad), 1),
                Call(
                    address(pad),
                    0,
                    abi.encodeCall(ILaunchpad.buy, (memes[0], 1, 0, block.timestamp + 60, attacker))
                )
            );
        } else if (kind == 13) {
            calls = two(
                approveCall(address(pad), 1),
                Call(
                    address(pad),
                    0,
                    abi.encodeCall(
                        ILaunchpad.buy, (memes[0], 1, 0, block.timestamp + 601 + x % 1e6, root)
                    )
                )
            );
        } else if (kind == 14) {
            uint256 t = x % MEMES;
            calls = one(sellCall(memes[t], _modelInventory(k, t) + 1));
        } else if (kind == 15) {
            calls = one(approveCall(address(pad), _modelRemaining(k) + amount));
        } else {
            calls = one(bob, maxValue[k] + amount, "");
        }
    }
}
