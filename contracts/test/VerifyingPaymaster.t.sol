// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {Settings} from "calibur/libraries/SettingsLib.sol";
import {AgentPolicyHook} from "../src/AgentPolicyHook.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind
} from "../src/interfaces/IAgentPolicyHook.sol";
import {MockLaunchpad} from "../src/mocks/MockLaunchpad.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";
import {DeployPaymaster} from "../script/DeployPaymaster.s.sol";
import {PaymasterTestBase} from "./paymaster/PaymasterTestBase.sol";

/// @notice `validatePaymasterUserOp` called directly as the EntryPoint: the signed field set,
///         the delegate binding and the `paymasterAndData` parsing.
contract VerifyingPaymasterTest is PaymasterTestBase {
    uint48 internal constant UNTIL = uint48(T0 + 1 hours);
    uint48 internal constant AFTER = uint48(T0 - 1);
    uint256 internal constant SIG_FAILED = 1;

    function setUp() public override {
        super.setUp();
        vm.etch(root, delegation(calibur));
    }

    function _op() internal view returns (PackedUserOperation memory op) {
        op.sender = root;
        op.nonce = 7;
        op.callData = hex"deadbeef";
        op.accountGasLimits = bytes32(uint256(200_000) << 128 | 300_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32(uint256(1 gwei) << 128 | 2 gwei);
    }

    function _signedOp() internal view returns (PackedUserOperation memory op) {
        op = _op();
        sponsorOp(op, pm, UNTIL, AFTER);
    }

    function _validate(VerifyingPaymaster p, address ep, PackedUserOperation memory op)
        internal
        returns (uint256 validationData)
    {
        vm.prank(ep);
        bytes memory context;
        (context, validationData) = p.validatePaymasterUserOp(op, keccak256("userOpHash"), 1e18);
        assertEq(context.length, 0);
    }

    function _validate(PackedUserOperation memory op) internal returns (uint256) {
        return _validate(pm, address(entryPoint), op);
    }

    function _packed(uint256 sigFailed) internal pure returns (uint256) {
        return sigFailed | uint256(UNTIL) << 160 | uint256(AFTER) << 208;
    }

    function test_constructor_bindsSignerEntryPointAndCalibur() public view {
        assertEq(pm.verifyingSigner(), sponsor);
        assertEq(address(pm.entryPoint()), ENTRY_POINT_V08);
        assertEq(pm.CALIBUR_ENTRY(), calibur);
        assertEq(pm.owner(), address(this));
    }

    /// @dev ERC-7562: validation reads no storage at all (immutables only), so the paymaster
    ///      needs no stake for storage access.
    function test_validSponsorship_returnsTimeRange_readsNoStorage() public {
        PackedUserOperation memory op = _signedOp();
        vm.record();
        assertEq(_validate(op), _packed(0));
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(pm));
        assertEq(reads.length, 0);
        assertEq(writes.length, 0);
    }

    /// @dev The account signature is produced after the sponsor signs (ERC-7677), so it is not
    ///      covered; any account signature leaves the sponsorship valid.
    function test_accountSignatureIsNotCovered() public {
        PackedUserOperation memory op = _signedOp();
        op.signature = hex"1234";
        assertEq(_validate(op), _packed(0));
    }

    function test_rejectsEachTamperedSignedField() public {
        address other = makeAddr("otherDelegatedAccount");
        vm.etch(other, delegation(calibur));
        string[11] memory names = [
            "sender",
            "nonce",
            "initCode",
            "callData",
            "accountGasLimits",
            "paymasterVerificationGasLimit",
            "paymasterPostOpGasLimit",
            "preVerificationGas",
            "gasFees",
            "validUntil",
            "validAfter"
        ];
        for (uint256 field; field < names.length; ++field) {
            PackedUserOperation memory op = _signedOp();
            if (field == 0) op.sender = other;
            else if (field == 1) op.nonce += 1;
            else if (field == 2) op.initCode = abi.encodePacked(bytes20(bytes2(0x7702)));
            else if (field == 3) op.callData = hex"deadbeee";
            else if (field == 4) op.accountGasLimits = bytes32(uint256(op.accountGasLimits) + 1);
            else if (field == 5) op.paymasterAndData[35] ^= 0x01; // [20:36]
            else if (field == 6) op.paymasterAndData[51] ^= 0x01; // [36:52]
            else if (field == 7) op.preVerificationGas += 1;
            else if (field == 8) op.gasFees = bytes32(uint256(op.gasFees) + 1);
            else if (field == 9) op.paymasterAndData[52 + 31] ^= 0x01; // validUntil word
            else op.paymasterAndData[84 + 31] ^= 0x01; // validAfter word
            assertEq(uint160(_validate(op)), SIG_FAILED, names[field]);
        }
    }

    function test_rejectsOtherChain() public {
        PackedUserOperation memory op = _signedOp();
        vm.chainId(5000);
        assertEq(_validate(op), _packed(SIG_FAILED));
    }

    function test_rejectsOtherPaymaster() public {
        VerifyingPaymaster other = new VerifyingPaymaster(entryPoint, sponsor, calibur);
        PackedUserOperation memory op = _signedOp();
        op.paymasterAndData = bytes.concat(abi.encodePacked(address(other)), _tail(op, 20));
        assertEq(_validate(other, address(entryPoint), op), _packed(SIG_FAILED));
    }

    /// @dev Same paymaster address, chain and signer, but compiled against another EntryPoint
    ///      (immutable): a signature for the canonical EntryPoint does not carry over.
    function test_rejectsOtherEntryPoint() public {
        address ep2 = deployCode("EntryPoint.sol:EntryPoint");
        VerifyingPaymaster twin = new VerifyingPaymaster(IEntryPoint(ep2), sponsor, calibur);
        PackedUserOperation memory op = _signedOp();
        vm.etch(address(pm), address(twin).code);
        assertEq(address(pm.entryPoint()), ep2);
        assertEq(_validate(pm, ep2, op), _packed(SIG_FAILED));
    }

    function test_rejectsCallerOtherThanEntryPoint() public {
        PackedUserOperation memory op = _signedOp();
        address ep2 = deployCode("EntryPoint.sol:EntryPoint");
        address[3] memory callers = [address(this), sponsor, ep2];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert("Sender not EntryPoint");
            pm.validatePaymasterUserOp(op, bytes32(0), 0);
            vm.prank(callers[i]);
            vm.expectRevert("Sender not EntryPoint");
            pm.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);
        }
    }

    function test_rejectsReDelegatedSender_emptyInitCode() public {
        PackedUserOperation memory op = _signedOp();
        address otherImpl = deployCode("CaliburEntry.sol:CaliburEntry");
        vm.etch(root, delegation(otherImpl));
        vm.expectRevert("VerifyingPaymaster: sender not delegated to CALIBUR_ENTRY");
        _validate(op);
    }

    /// @dev With the EIP-7702 initCode marker the EntryPoint folds the current delegate into
    ///      userOpHash (so the account re-signs), but the paymaster hash covers the raw marker:
    ///      only the delegate check stops the reused sponsor signature.
    function test_rejectsReDelegatedSender_7702InitCodeMarker() public {
        PackedUserOperation memory op = _op();
        op.initCode = abi.encodePacked(bytes20(bytes2(0x7702)));
        sponsorOp(op, pm, UNTIL, AFTER);
        assertEq(_validate(op), _packed(0));

        vm.etch(root, delegation(makeAddr("attackerImpl")));
        vm.expectRevert("VerifyingPaymaster: sender not delegated to CALIBUR_ENTRY");
        _validate(op);
    }

    function test_rejectsUndelegatedSenders() public {
        // (Other 0xef-prefixed code cannot exist: EIP-3541 / EIP-7702 allow only the designator.)
        bytes[2] memory codes = [
            bytes(""), // plain EOA / cleared delegation
            calibur.code // a contract account, not a delegation
        ];
        for (uint256 i; i < codes.length; ++i) {
            vm.etch(root, codes[i]);
            PackedUserOperation memory op = _signedOp();
            vm.expectRevert("VerifyingPaymaster: sender not delegated to CALIBUR_ENTRY");
            _validate(op);
        }
    }

    function test_rejectsShortOrOverlongPaymasterAndData() public {
        bytes memory valid = _signedOp().paymasterAndData;
        assertEq(valid.length, 181);
        uint256[8] memory lengths = [uint256(0), 20, 51, 52, 83, 116, 180, 182];
        for (uint256 i; i < lengths.length; ++i) {
            PackedUserOperation memory op = _op();
            op.paymasterAndData = new bytes(lengths[i]);
            for (uint256 j; j < lengths[i] && j < valid.length; ++j) {
                op.paymasterAndData[j] = valid[j];
            }
            vm.expectRevert();
            _validate(op);
        }
    }

    /// @dev The 64-byte ERC-2098 form of a valid signature is refused by length.
    function test_rejectsCompactSignature() public {
        PackedUserOperation memory op = _signedOp();
        bytes memory pmd = op.paymasterAndData;
        bytes32 r;
        bytes32 s;
        uint8 v = uint8(pmd[180]);
        assembly ("memory-safe") {
            r := mload(add(pmd, add(32, 116)))
            s := mload(add(pmd, add(32, 148)))
        }
        bytes32 vs = bytes32(uint256(v - 27) << 255 | uint256(s));
        op.paymasterAndData = bytes.concat(_head(op, 116), abi.encodePacked(r, vs));
        vm.expectRevert("VerifyingPaymaster: invalid signature length in paymasterAndData");
        _validate(op);
    }

    function test_rejectsMalformedTimestampsAndSignature() public {
        // validUntil does not fit uint48: abi.decode reverts.
        PackedUserOperation memory op = _signedOp();
        op.paymasterAndData[52 + 25] = 0x01;
        vm.expectRevert();
        _validate(op);

        // A 65-byte signature with an invalid v: OpenZeppelin ECDSA reverts.
        op = _signedOp();
        op.paymasterAndData[180] = 0x00;
        vm.expectRevert();
        _validate(op);

        // A well-formed signature from another key: SIG_VALIDATION_FAILED.
        op = _signedOp();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", pm.getHash(op, UNTIL, AFTER))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        op.paymasterAndData = bytes.concat(_head(op, 116), abi.encodePacked(r, s, v));
        assertEq(_validate(op), _packed(SIG_FAILED));
    }

    function test_parsePaymasterAndData() public view {
        PackedUserOperation memory op = _signedOp();
        (uint48 validUntil, uint48 validAfter, bytes memory signature) =
            pm.parsePaymasterAndData(op.paymasterAndData);
        assertEq(validUntil, UNTIL);
        assertEq(validAfter, AFTER);
        assertEq(signature, _tail(op, 116));
    }

    function _head(PackedUserOperation memory op, uint256 n)
        internal
        pure
        returns (bytes memory b)
    {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = op.paymasterAndData[i];
        }
    }

    function _tail(PackedUserOperation memory op, uint256 from)
        internal
        pure
        returns (bytes memory b)
    {
        b = new bytes(op.paymasterAndData.length - from);
        for (uint256 i; i < b.length; ++i) {
            b[i] = op.paymasterAndData[from + i];
        }
    }
}

/// @notice End to end through the real EntryPoint v0.8 `handleOps`: an EOA delegated (EIP-7702)
///         to a real CaliburEntry, a session key whose hook is the real AgentPolicyHook pinned to
///         this paymaster, and the acceptance-fixture mocks.
contract VerifyingPaymasterE2ETest is PaymasterTestBase {
    uint256 internal constant AGENT_PK = 0xA6E47;
    uint256 internal constant DEPOSIT = 10 ether;
    address payable internal beneficiary = payable(makeAddr("beneficiary"));
    address internal bundler = makeAddr("bundler");

    AgentPolicyHook internal hook;
    MockUSD internal usd;
    MockLaunchpad internal pad;
    address internal meme;
    bytes32 internal keyHash;

    function setUp() public override {
        super.setUp();
        pm.deposit{value: DEPOSIT}();

        address hookAt = address(uint160(uint256(keccak256("AgentPolicyHook"))) | 0x1f);
        deployCodeTo("AgentPolicyHook.sol:AgentPolicyHook", abi.encode(address(pm)), hookAt);
        hook = AgentPolicyHook(hookAt);

        usd = new MockUSD();
        pad = new MockLaunchpad(address(usd));
        meme = pad.createToken("Meme", "MEME");
        usd.mint(root, 1_000e6);

        // Real EIP-7702 delegation, attached to the root's first (grant) transaction.
        vm.signAndAttachDelegation(calibur, ROOT_PK);
        keyHash = _grant(vm.addr(AGENT_PK));
        assertEq(root.code, delegation(calibur));
        assertEq(root.codehash, keccak256(delegation(calibur)));
    }

    function _grant(address agent) internal returns (bytes32 kh) {
        Key memory key = Key(KeyType.Secp256k1, abi.encode(agent));
        kh = keccak256(abi.encode(key.keyType, keccak256(key.publicKey)));
        Settings settings =
            Settings.wrap(uint256(uint160(address(hook))) | (uint256(T0 + 1 days) << 160));

        Policy memory p;
        p.quoteLimits = new QuoteLimit[](1);
        p.quoteLimits[0] = QuoteLimit(address(usd), 100e6, 50e6);
        p.periodLength = 1 days;
        p.permissions = new CallPermission[](2);
        p.permissions[0] =
            CallPermission(address(usd), IERC20.approve.selector, RuleKind.ERC20_APPROVE);
        p.permissions[1] =
            CallPermission(address(pad), MockLaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY);
        p.trustedSpenders = new address[](1);
        p.trustedSpenders[0] = address(pad);
        p.maxDeadlineWindow = 120;

        Call[] memory calls = new Call[](3);
        calls[0] = Call(root, 0, abi.encodeCall(IKeyManagement.register, (key)));
        calls[1] = Call(root, 0, abi.encodeCall(IKeyManagement.update, (kh, settings)));
        calls[2] = Call(address(hook), 0, abi.encodeCall(IAgentPolicyHook.setPolicy, (kh, p)));
        vm.prank(root);
        ICalibur(root).execute(BatchedCall(calls, true));
    }

    function _buyCalls(uint256 amount) internal view returns (Call[] memory calls) {
        calls = new Call[](2);
        calls[0] = Call(address(usd), 0, abi.encodeCall(IERC20.approve, (address(pad), amount)));
        calls[1] = Call(
            address(pad), 0, abi.encodeCall(pad.buy, (meme, amount, 0, block.timestamp + 60, root))
        );
    }

    /// @dev A session UserOp on the key's nonce lane (DESIGN §4.1), unsponsored and unsigned.
    ///      Calibur decodes `callData[4:]` as a BatchedCall: selector ‖ abi.encode(BatchedCall).
    function _sessionOp() internal view returns (PackedUserOperation memory op) {
        op.sender = root;
        op.nonce = entryPoint.getNonce(root, uint192(uint256(keyHash) >> 64));
        op.callData = abi.encodeWithSelector(
            IAccountExecute.executeUserOp.selector, BatchedCall(_buyCalls(10e6), true)
        );
        op.accountGasLimits = bytes32(uint256(300_000) << 128 | 500_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32(uint256(1 gwei) << 128 | 2 gwei);
    }

    /// @dev The account signs last: userOpHash covers paymasterAndData.
    function _signAccount(PackedUserOperation memory op) internal view {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, entryPoint.getUserOpHash(op));
        op.signature = abi.encode(keyHash, abi.encodePacked(r, s, v), bytes(""));
    }

    function _sponsoredOp(uint48 validUntil, uint48 validAfter)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _sessionOp();
        sponsorOp(op, pm, validUntil, validAfter);
        _signAccount(op);
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, beneficiary);
    }

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    function _expectFailedOpWithRevert(string memory reason, bytes memory inner) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, reason, inner)
        );
    }

    function test_e2e_sponsoredSessionUserOp_executes() public {
        uint256 rootBalance = root.balance;
        uint256 nonce = entryPoint.getNonce(root, uint192(uint256(keyHash) >> 64));
        _handle(_sponsoredOp(uint48(block.timestamp + 5 minutes), 0));

        assertEq(hook.inventory(keyHash, root, meme), 10e6 * pad.RATE());
        assertEq(hook.getSpent(keyHash, root, address(usd)).total, 10e6);
        assertEq(usd.balanceOf(root), 990e6);
        assertEq(entryPoint.getNonce(root, uint192(uint256(keyHash) >> 64)), nonce + 1);
        // Gas came out of the paymaster deposit; the account paid nothing.
        uint256 paid = DEPOSIT - entryPoint.balanceOf(address(pm));
        assertGt(paid, 0);
        assertEq(beneficiary.balance, paid);
        assertEq(root.balance, rootBalance);
        assertEq(entryPoint.balanceOf(root), 0);
    }

    /// @dev I10, no paymaster: the EntryPoint asks the account for its prefund and Calibur pays
    ///      it before the hook runs, but the hook's revert unwinds the payment with the whole
    ///      validateUserOp frame (AA23), so the account loses nothing.
    function test_e2e_noPaymaster_rejected_accountPaysNothing() public {
        vm.deal(root, 1 ether);
        PackedUserOperation memory op = _sessionOp();
        _signAccount(op);
        _expectFailedOpWithRevert(
            "AA23 reverted", abi.encodeWithSelector(IAgentPolicyHook.WrongPaymaster.selector)
        );
        _handle(op);
        assertEq(root.balance, 1 ether);
        assertEq(entryPoint.balanceOf(root), 0);
    }

    /// @dev I10, wrong paymaster: even a funded VerifyingPaymaster with a valid sponsor
    ///      signature is refused by the hook; with a paymaster set the account owes no prefund.
    function test_e2e_otherPaymaster_rejected_accountPaysNothing() public {
        vm.deal(root, 1 ether);
        VerifyingPaymaster other = new VerifyingPaymaster(entryPoint, sponsor, calibur);
        other.deposit{value: DEPOSIT}();
        PackedUserOperation memory op = _sessionOp();
        sponsorOp(op, other, uint48(block.timestamp + 5 minutes), 0);
        _signAccount(op);
        _expectFailedOpWithRevert(
            "AA23 reverted", abi.encodeWithSelector(IAgentPolicyHook.WrongPaymaster.selector)
        );
        _handle(op);
        assertEq(root.balance, 1 ether);
        assertEq(entryPoint.balanceOf(address(other)), DEPOSIT);
    }

    function test_e2e_expiredSponsorship_rejected() public {
        PackedUserOperation memory op = _sponsoredOp(uint48(block.timestamp + 60), 0);
        vm.warp(block.timestamp + 61);
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);
    }

    function test_e2e_notYetValidSponsorship_rejected() public {
        PackedUserOperation memory op =
            _sponsoredOp(uint48(block.timestamp + 1 hours), uint48(block.timestamp + 30));
        _expectFailedOp("AA32 paymaster expired or not due");
        _handle(op);
        vm.warp(block.timestamp + 31); // still inside the buy's own 60 s deadline
        _handle(op);
        assertEq(hook.getSpent(keyHash, root, address(usd)).total, 10e6);
    }

    function test_e2e_tamperedAfterSponsorship_rejected() public {
        PackedUserOperation memory op = _sponsoredOp(uint48(block.timestamp + 5 minutes), 0);
        op.callData = abi.encodeWithSelector(
            IAccountExecute.executeUserOp.selector, BatchedCall(_buyCalls(50e6), true)
        );
        _signAccount(op);
        _expectFailedOp("AA34 signature error");
        _handle(op);
    }

    /// @dev DESIGN §4.3 attack: sponsor signs, the root re-delegates to another implementation
    ///      (here: a second CaliburEntry, under which the session key stays registered), the
    ///      account re-signs, the sponsor signature is reused.
    function test_e2e_reDelegationWithReusedSponsorSignature_rejected() public {
        PackedUserOperation memory op = _sessionOp();
        op.initCode = abi.encodePacked(bytes20(bytes2(0x7702)));
        sponsorOp(op, pm, uint48(block.timestamp + 5 minutes), 0);

        address otherImpl = deployCode("CaliburEntry.sol:CaliburEntry");
        vm.signAndAttachDelegation(otherImpl, ROOT_PK);
        vm.prank(root);
        ICalibur(root).execute(BatchedCall(new Call[](0), true));
        assertEq(root.code, delegation(otherImpl));
        _signAccount(op);

        _expectFailedOpWithRevert(
            "AA33 reverted",
            abi.encodeWithSignature(
                "Error(string)", "VerifyingPaymaster: sender not delegated to CALIBUR_ENTRY"
            )
        );
        _handle(op);
    }
}

/// @notice The deploy script, run locally against the in-test EntryPoint and CaliburEntry.
/// @dev The environment is process-global and tests run in parallel: every test here sets the
///      same values (setUp addresses are deterministic).
contract DeployPaymasterScriptTest is PaymasterTestBase {
    DeployPaymaster internal script;

    function setUp() public override {
        super.setUp();
        vm.setEnv("PAYMASTER_SIGNER", vm.toString(sponsor));
        vm.setEnv("CALIBUR_ENTRY", vm.toString(calibur));
        vm.setEnv("PAYMASTER_DEPOSIT_WEI", "1000000000000000000");
        script = new DeployPaymaster();
    }

    function test_run_deploysFundsAndVerifies() public {
        vm.deal(DEFAULT_SENDER, 2 ether);
        VerifyingPaymaster deployed = script.run();

        assertEq(deployed.verifyingSigner(), sponsor);
        assertEq(deployed.CALIBUR_ENTRY(), calibur);
        assertEq(address(deployed.entryPoint()), ENTRY_POINT_V08);
        assertEq(deployed.owner(), DEFAULT_SENDER);
        assertEq(entryPoint.balanceOf(address(deployed)), 1 ether);
        script.verify(address(deployed));
    }

    function test_verify_rejectsMisconfiguredPaymaster() public {
        address ep2 = deployCode("EntryPoint.sol:EntryPoint");
        VerifyingPaymaster p = new VerifyingPaymaster(IEntryPoint(ep2), sponsor, calibur);
        vm.expectRevert("DeployPaymaster: EntryPoint mismatch");
        script.verify(address(p));

        p = new VerifyingPaymaster(entryPoint, makeAddr("other"), calibur);
        p.deposit{value: 1 ether}();
        vm.expectRevert("DeployPaymaster: verifyingSigner mismatch");
        script.verify(address(p));

        p = new VerifyingPaymaster(entryPoint, sponsor, makeAddr("otherImpl"));
        p.deposit{value: 1 ether}();
        vm.expectRevert("DeployPaymaster: CALIBUR_ENTRY mismatch");
        script.verify(address(p));

        p = new VerifyingPaymaster(entryPoint, sponsor, calibur);
        vm.expectRevert("DeployPaymaster: deposit below PAYMASTER_DEPOSIT_WEI");
        script.verify(address(p));

        vm.prank(sponsor);
        p = new VerifyingPaymaster(entryPoint, sponsor, calibur);
        p.deposit{value: 1 ether}();
        vm.expectRevert("DeployPaymaster: signer must not be the owner");
        script.verify(address(p));
    }
}
