// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ERC7739Utils} from "@openzeppelin/contracts/utils/cryptography/draft-ERC7739Utils.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {IERC7914} from "calibur/interfaces/IERC7914.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {Settings} from "calibur/libraries/SettingsLib.sol";
import {SignedBatchedCall, SignedBatchedCallLib} from "calibur/libraries/SignedBatchedCallLib.sol";
import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind
} from "../../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {MockLaunchpad} from "../../src/mocks/MockLaunchpad.sol";
import {MockUSD} from "../../src/mocks/MockUSD.sol";
import {PaymasterTestBase} from "../paymaster/PaymasterTestBase.sol";
import {CallbackTarget} from "./HookTestHelpers.sol";

/// @notice Test-only stand-in for ERC20ETH (etched at its canonical address): an allowlisted
///         target that pulls native value out of `from` through ERC-7914 `transferFromNative`.
contract NativePuller {
    function pull(address from, address to, uint256 amount) external {
        IERC7914(from).transferFromNative(from, to, amount);
    }
}

/// @notice Shared fixture for the attack, entry-point-matrix and invariant suites: an EOA
///         delegated (EIP-7702) to a real CaliburEntry v1.1.0, the real EntryPoint v0.8 at its
///         canonical address, the VerifyingPaymaster, an AgentPolicyHook bound to that paymaster
///         and the acceptance-fixture mocks (MockUSD, MockLaunchpad, MemeToken). One helper per
///         execution entry: `execute(BatchedCall)`, ERC-7821 `execute(mode, data)`,
///         `execute(SignedBatchedCall)` (relayer) and `executeUserOp` through `handleOps`
///         (sponsored, on the key's nonce lane), plus ERC-1271 `isValidSignature`.
abstract contract CaliburSessionBase is PaymasterTestBase {
    enum Entry {
        Direct,
        ERC7821,
        Signed,
        UserOp
    }

    uint256 internal constant ENTRY_COUNT = 4;
    address internal constant ERC20ETH = 0x00000000e20E49e6dCeE6e8283A0C090578F0fb9;
    bytes32 internal constant MODE_REVERT = bytes32(uint256(0x01) << 248);
    bytes32 internal constant MODE_CAN_REVERT = bytes32(uint256(0x0101) << 240);
    bytes4 internal constant MAGIC_1271 = 0x1626ba7e;
    uint256 internal constant AGENT_PK = 0xA6E47;
    uint256 internal constant AGENT2_PK = 0xA6E48;
    /// @dev A key registered without a hook (what DESIGN I6 forbids the SDK to do): the control
    ///      that shows a rejected call is rejected by the hook and not by anything else.
    uint256 internal constant CONTROL_PK = 0xC0417;
    uint256 internal constant PM_DEPOSIT = 1_000 ether;
    uint256 internal constant HUMAN_MEME = 1_000e18;

    AgentPolicyHook internal hook;
    ICalibur internal account;
    MockUSD internal usd;
    MockLaunchpad internal pad;
    address internal meme;
    CallbackTarget internal cb;
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");
    address internal relayer = makeAddr("relayer");
    address internal bundler = makeAddr("bundler");
    address payable internal beneficiary = payable(makeAddr("beneficiary"));
    uint40 internal expiry;

    function setUp() public virtual override {
        super.setUp();
        pm.deposit{value: PM_DEPOSIT}();
        address hookAt = address(uint160(uint256(keccak256("AgentPolicyHook"))) | 0x1f);
        deployCodeTo("AgentPolicyHook.sol:AgentPolicyHook", abi.encode(address(pm)), hookAt);
        hook = AgentPolicyHook(hookAt);
        usd = new MockUSD();
        pad = new MockLaunchpad(address(usd));
        meme = pad.createToken("Meme", "MEME");
        cb = new CallbackTarget();
        vm.etch(ERC20ETH, address(new NativePuller()).code);
        account = ICalibur(root);
        usd.mint(root, 10_000e6);
        vm.deal(root, 100 ether);
        expiry = uint40(block.timestamp + 7 days);
    }

    // ---------------------------------------------------------------------------------------
    // Keys and policies
    // ---------------------------------------------------------------------------------------

    function keyHashOf(uint256 pk) internal pure returns (bytes32) {
        return keccak256(abi.encode(KeyType.Secp256k1, keccak256(abi.encode(vm.addr(pk)))));
    }

    /// @dev DESIGN §4.1: lane = uint192(uint256(keyHash) >> 64), the same for both nonce systems.
    function laneOf(bytes32 kh) internal pure returns (uint192) {
        return uint192(uint256(kh) >> 64);
    }

    function settingsFor(address hookAddr, uint40 exp) internal pure returns (Settings) {
        return Settings.wrap(uint256(uint160(hookAddr)) | (uint256(exp) << 160));
    }

    /// @dev §8 acceptance policy plus the extra allowlisted targets the attack tests need:
    ///      MNT 1/call, 3 total, 2 per day; MockUSD 100 total, 50 per day; approve(MockUSD →
    ///      MockLaunchpad), buy, sell; plain MNT to bob; CallbackTarget run/fail/tryRun; ERC20ETH
    ///      pull.
    function sessionPolicy() internal view returns (Policy memory p) {
        p.maxValuePerCall = 1 ether;
        p.mntLimit = QuoteLimit(address(0), 3 ether, 2 ether);
        p.quoteLimits = new QuoteLimit[](1);
        p.quoteLimits[0] = QuoteLimit(address(usd), 100e6, 50e6);
        p.periodLength = 1 days;
        p.permissions = new CallPermission[](8);
        p.permissions[0] =
            CallPermission(address(usd), IERC20.approve.selector, RuleKind.ERC20_APPROVE);
        p.permissions[1] =
            CallPermission(address(pad), ILaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY);
        p.permissions[2] =
            CallPermission(address(pad), ILaunchpad.sell.selector, RuleKind.LAUNCHPAD_SELL);
        p.permissions[3] = CallPermission(bob, bytes4(0), RuleKind.NONE);
        p.permissions[4] = CallPermission(address(cb), CallbackTarget.run.selector, RuleKind.NONE);
        p.permissions[5] = CallPermission(address(cb), CallbackTarget.fail.selector, RuleKind.NONE);
        p.permissions[6] = CallPermission(ERC20ETH, NativePuller.pull.selector, RuleKind.NONE);
        p.permissions[7] =
            CallPermission(address(cb), CallbackTarget.tryRun.selector, RuleKind.NONE);
        p.trustedSpenders = new address[](1);
        p.trustedSpenders[0] = address(pad);
        p.maxDeadlineWindow = 600;
    }

    /// @dev The SDK init batch (DESIGN §7.1, I8): delegate (real EIP-7702 authorization attached
    ///      to this transaction), revoke ERC20ETH's default native allowance, give the
    ///      CallbackTarget a standing MockUSD allowance (the root's own decision; it is the
    ///      "allowlisted target pulls with a root allowance" outflow path), and grant AGENT.
    function initAccount() internal returns (bytes32 kh) {
        return initAccount(true);
    }

    function initAccount(bool revokeErc20EthAllowance) internal returns (bytes32 kh) {
        vm.signAndAttachDelegation(calibur, ROOT_PK);
        Call[] memory grantBatch = grantCalls(AGENT_PK, sessionPolicy(), expiry);
        uint256 head = revokeErc20EthAllowance ? 2 : 1;
        Call[] memory calls = new Call[](head + grantBatch.length);
        if (revokeErc20EthAllowance) {
            calls[0] = Call(root, 0, abi.encodeCall(IERC7914.approveNative, (ERC20ETH, 0)));
        }
        calls[head - 1] =
            Call(address(usd), 0, abi.encodeCall(IERC20.approve, (address(cb), type(uint256).max)));
        for (uint256 i; i < grantBatch.length; ++i) {
            calls[head + i] = grantBatch[i];
        }
        rootExec(calls);
        assertEq(root.code, delegation(calibur));
        kh = keyHashOf(AGENT_PK);
        assertTrue(hook.getSummary(kh, root).active);
    }

    function grantCalls(uint256 pk, Policy memory p, uint40 exp)
        internal
        view
        returns (Call[] memory calls)
    {
        Key memory key = Key(KeyType.Secp256k1, abi.encode(vm.addr(pk)));
        bytes32 kh = keyHashOf(pk);
        calls = new Call[](3);
        calls[0] = Call(root, 0, abi.encodeCall(IKeyManagement.register, (key)));
        calls[1] = Call(
            root, 0, abi.encodeCall(IKeyManagement.update, (kh, settingsFor(address(hook), exp)))
        );
        calls[2] = Call(address(hook), 0, abi.encodeCall(IAgentPolicyHook.setPolicy, (kh, p)));
    }

    function grant(uint256 pk, Policy memory p) internal returns (bytes32) {
        rootExec(grantCalls(pk, p, expiry));
        return keyHashOf(pk);
    }

    /// @dev Registers CONTROL_PK with no hook (non-admin, same expiry).
    function grantControlKey() internal {
        Key memory key = Key(KeyType.Secp256k1, abi.encode(vm.addr(CONTROL_PK)));
        Call[] memory calls = new Call[](2);
        calls[0] = Call(root, 0, abi.encodeCall(IKeyManagement.register, (key)));
        calls[1] = Call(
            root,
            0,
            abi.encodeCall(
                IKeyManagement.update, (keyHashOf(CONTROL_PK), settingsFor(address(0), expiry))
            )
        );
        rootExec(calls);
    }

    /// @dev Root management through the account's own `execute(BatchedCall)` (unhooked).
    function rootExec(Call[] memory calls) internal {
        vm.prank(root);
        account.execute(BatchedCall(calls, true));
    }

    function rootExec1(address to, bytes memory data) internal {
        rootExec(one(to, 0, data));
    }

    /// @dev The SDK revoke batch (DESIGN §7.3): Calibur revoke, hook tombstone, allowance resets.
    function revokeCalls(bytes32 kh, address[] memory spenders)
        internal
        view
        returns (Call[] memory calls)
    {
        calls = new Call[](2 + spenders.length);
        calls[0] = Call(root, 0, abi.encodeCall(IKeyManagement.revoke, (kh)));
        calls[1] = Call(address(hook), 0, abi.encodeCall(IAgentPolicyHook.revoke, (kh)));
        for (uint256 i; i < spenders.length; ++i) {
            calls[2 + i] = Call(address(usd), 0, abi.encodeCall(IERC20.approve, (spenders[i], 0)));
        }
    }

    // ---------------------------------------------------------------------------------------
    // Calls
    // ---------------------------------------------------------------------------------------

    function one(address to, uint256 value, bytes memory data)
        internal
        pure
        returns (Call[] memory calls)
    {
        calls = new Call[](1);
        calls[0] = Call(to, value, data);
    }

    function one(Call memory c) internal pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = c;
    }

    function two(Call memory a, Call memory b) internal pure returns (Call[] memory calls) {
        calls = new Call[](2);
        calls[0] = a;
        calls[1] = b;
    }

    function approveCall(address spender, uint256 amount) internal view returns (Call memory) {
        return Call(address(usd), 0, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    function buyCall(address token, uint256 amountIn) internal view returns (Call memory) {
        return Call(
            address(pad),
            0,
            abi.encodeCall(ILaunchpad.buy, (token, amountIn, 0, block.timestamp + 60, root))
        );
    }

    function sellCall(address token, uint256 amount) internal view returns (Call memory) {
        return Call(
            address(pad),
            0,
            abi.encodeCall(ILaunchpad.sell, (token, amount, 0, block.timestamp + 60, root))
        );
    }

    function approveAndBuy(address token, uint256 amountIn) internal view returns (Call[] memory) {
        return two(approveCall(address(pad), amountIn), buyCall(token, amountIn));
    }

    /// @dev A MockUSD outflow outside the approve rule: the allowlisted CallbackTarget spends the
    ///      standing allowance the root gave it at init.
    function pullCall(uint256 amount, address to) internal view returns (Call memory) {
        bytes memory pull = abi.encodeCall(IERC20.transferFrom, (root, to, amount));
        return Call(address(cb), 0, abi.encodeCall(CallbackTarget.run, (address(usd), pull)));
    }

    function nativePullCall(uint256 amount) internal view returns (Call memory) {
        return Call(ERC20ETH, 0, abi.encodeCall(NativePuller.pull, (root, attacker, amount)));
    }

    // ---------------------------------------------------------------------------------------
    // Execution entries (session key `pk`)
    // ---------------------------------------------------------------------------------------

    function entryName(Entry e) internal pure returns (string memory) {
        if (e == Entry.Direct) return "execute(BatchedCall)";
        if (e == Entry.ERC7821) return "ERC-7821 execute(mode,data)";
        if (e == Entry.Signed) return "execute(SignedBatchedCall)";
        return "executeUserOp via handleOps";
    }

    /// @notice Runs `calls` as session key `pk` through entry `e`. Returns whether the batch
    ///         executed and, if not, the revert data (for UserOp: the `handleOps` revert at
    ///         validation, or the `UserOperationRevertReason` of a reverted execution).
    function exec(Entry e, uint256 pk, Call[] memory calls, bool revertOnFailure)
        internal
        returns (bool ok, bytes memory ret)
    {
        if (e == Entry.Direct) {
            vm.prank(vm.addr(pk));
            try account.execute(BatchedCall(calls, revertOnFailure)) {
                ok = true;
            } catch (bytes memory r) {
                ret = r;
            }
        } else if (e == Entry.ERC7821) {
            vm.prank(vm.addr(pk));
            try account.execute(
                revertOnFailure ? MODE_REVERT : MODE_CAN_REVERT, abi.encode(calls)
            ) {
                ok = true;
            } catch (bytes memory r) {
                ret = r;
            }
        } else if (e == Entry.Signed) {
            (SignedBatchedCall memory sbc, bytes memory sig) = signedBatch(
                pk, keyHashOf(pk), calls, revertOnFailure, laneOf(keyHashOf(pk)), relayer
            );
            return relay(sbc, sig);
        } else {
            return handle(userOp(pk, calls, revertOnFailure));
        }
    }

    function exec(Entry e, uint256 pk, Call[] memory calls)
        internal
        returns (bool ok, bytes memory ret)
    {
        return exec(e, pk, calls, true);
    }

    function signedBatch(
        uint256 pk,
        bytes32 kh,
        Call[] memory calls,
        bool revertOnFailure,
        uint192 lane,
        address executor
    ) internal view returns (SignedBatchedCall memory sbc, bytes memory wrappedSignature) {
        sbc = SignedBatchedCall({
            batchedCall: BatchedCall(calls, revertOnFailure),
            nonce: uint256(lane) << 64 | account.getSeq(lane),
            keyHash: kh,
            executor: executor,
            deadline: block.timestamp + 120
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, account.hashTypedData(SignedBatchedCallLib.hash(sbc)));
        wrappedSignature = abi.encode(abi.encodePacked(r, s, v), bytes(""));
    }

    function relay(SignedBatchedCall memory sbc, bytes memory wrappedSignature)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(relayer);
        try account.execute(sbc, wrappedSignature) {
            ok = true;
        } catch (bytes memory r) {
            ret = r;
        }
    }

    /// @dev A sponsored session UserOp on the key's lane. Calibur decodes `callData[4:]` as a
    ///      BatchedCall: callData = executeUserOp.selector ‖ abi.encode(BatchedCall).
    function userOp(uint256 pk, Call[] memory calls, bool revertOnFailure)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = unsignedUserOp(keyHashOf(pk), calls, revertOnFailure);
        sponsorOp(op, pm, uint48(block.timestamp + 1 hours), 0);
        signUserOp(op, pk, keyHashOf(pk));
    }

    function unsignedUserOp(bytes32 kh, Call[] memory calls, bool revertOnFailure)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = root;
        op.nonce = entryPoint.getNonce(root, laneOf(kh));
        op.callData = abi.encodeWithSelector(
            IAccountExecute.executeUserOp.selector, BatchedCall(calls, revertOnFailure)
        );
        op.accountGasLimits = bytes32(uint256(1_000_000) << 128 | 3_000_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32(uint256(1 gwei) << 128 | 1 gwei);
    }

    /// @dev The account signs last (userOpHash covers paymasterAndData).
    function signUserOp(PackedUserOperation memory op, uint256 pk, bytes32 kh) internal view {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, entryPoint.getUserOpHash(op));
        op.signature = abi.encode(kh, abi.encodePacked(r, s, v), bytes(""));
    }

    /// @dev `handleOps` from a bundler EOA. A validation failure reverts `handleOps`
    ///      (FailedOp / FailedOpWithRevert); an execution failure is reported by the
    ///      EntryPoint's `UserOperationEvent(success = false)` and `UserOperationRevertReason`.
    function handle(PackedUserOperation memory op) internal returns (bool ok, bytes memory ret) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        vm.prank(bundler, bundler);
        try entryPoint.handleOps(ops, beneficiary) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bool seen;
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter != address(entryPoint)) continue;
                bytes32 topic = logs[i].topics[0];
                if (topic == IEntryPoint.UserOperationRevertReason.selector) {
                    (, ret) = abi.decode(logs[i].data, (uint256, bytes));
                } else if (topic == IEntryPoint.UserOperationEvent.selector) {
                    (, ok,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                    seen = true;
                }
            }
            assertTrue(seen, "no UserOperationEvent");
        } catch (bytes memory r) {
            vm.getRecordedLogs();
            ret = r;
        }
    }

    /// @dev ERC-1271 with a session key: a cryptographically valid ERC-7739 nested PersonalSign
    ///      signature over `digest`. Returns whether the account returned the magic value.
    function session1271(uint256 pk, bytes32 digest)
        internal
        view
        returns (bool ok, bytes memory ret)
    {
        bytes32 nested = MessageHashUtils.toTypedDataHash(
            account.domainSeparator(), ERC7739Utils.personalSignStructHash(digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, nested);
        bytes memory wrapped = abi.encode(keyHashOf(pk), abi.encodePacked(r, s, v), bytes(""));
        try account.isValidSignature(digest, wrapped) returns (bytes4 magic) {
            ok = magic == MAGIC_1271;
            if (!ok) ret = abi.encode(magic);
        } catch (bytes memory reason) {
            ret = reason;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------

    function err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function failedOpWithRevert(string memory reason, bytes memory inner)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, reason, inner);
    }

    function failedOp(string memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason);
    }
}
