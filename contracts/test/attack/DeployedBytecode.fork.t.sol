// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {IERC7914} from "calibur/interfaces/IERC7914.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {Settings} from "calibur/libraries/SettingsLib.sol";
import {SignedBatchedCall, SignedBatchedCallLib} from "calibur/libraries/SignedBatchedCallLib.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind
} from "../../src/interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";
import {MockUSD} from "../../src/mocks/MockUSD.sol";
import {MantleSepoliaForkTest} from "../MantleSepoliaForkTest.sol";

/// @notice Optional (fork only; skipped without MANTLE_SEPOLIA_RPC_URL): the core overreach
///         rejections against the bytecode actually deployed on Mantle Sepolia — the canonical
///         CaliburEntry v1.1.0 and the deployed AgentPolicyHook and mocks
///         (deployments/mantle-sepolia.json) — for a fresh EOA delegated in the fork. The
///         required suite uses locally compiled copies of the same sources.
contract DeployedBytecodeForkTest is MantleSepoliaForkTest {
    address internal constant CALIBUR = 0x000000005c84F8Fd50b21CAC312528A64437030e;
    bytes32 internal constant CALIBUR_CODEHASH =
        0xba697585ba58ba66ebd095ab4c7f980ed42ad115b2e3bb9b5b9bdf167bf08b1b;
    address internal constant HOOK = 0xdC99279cc8858a109A0dE31b021D54EBe30aDd7F;
    bytes32 internal constant HOOK_CODEHASH =
        0xb9dd9f5dfabd887fc805c2c7857da74ede679f325aad683e66e4603a8df7ed77;
    address internal constant MUSD = 0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526;
    address internal constant PAD = 0x63614eAb4365EcA8c674D649fF2d3beb1a1cC7E9;
    address internal constant MEME = 0xAb2D3B4cD4770e2669fe2BA781D449A214EF958f;
    address internal constant ERC20ETH = 0x00000000e20E49e6dCeE6e8283A0C090578F0fb9;
    uint256 internal constant ROOT_PK = 0xF0A1CE;
    uint256 internal constant AGENT_PK = 0xF0A6E47;

    address internal root;
    address internal agent;
    address internal relayer = makeAddr("relayer");
    address internal bob = makeAddr("bob");
    bytes32 internal kh;
    ICalibur internal account;

    function setUp() public override {
        super.setUp();
        assertEq(CALIBUR.codehash, CALIBUR_CODEHASH, "canonical CaliburEntry");
        assertEq(HOOK.codehash, HOOK_CODEHASH, "deployed hook");
        root = vm.addr(ROOT_PK);
        agent = vm.addr(AGENT_PK);
        account = ICalibur(root);
        MockUSD(MUSD).mint(root, 1_000e6);

        Key memory key = Key(KeyType.Secp256k1, abi.encode(agent));
        kh = keccak256(abi.encode(key.keyType, keccak256(key.publicKey)));
        Settings settings =
            Settings.wrap(uint256(uint160(HOOK)) | (uint256(block.timestamp + 1 days) << 160));
        Policy memory p;
        p.quoteLimits = new QuoteLimit[](1);
        p.quoteLimits[0] = QuoteLimit(MUSD, 100e6, 50e6);
        p.periodLength = 1 days;
        p.permissions = new CallPermission[](4);
        p.permissions[0] = CallPermission(MUSD, IERC20.approve.selector, RuleKind.ERC20_APPROVE);
        p.permissions[1] = CallPermission(PAD, ILaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY);
        p.permissions[2] = CallPermission(PAD, ILaunchpad.sell.selector, RuleKind.LAUNCHPAD_SELL);
        p.permissions[3] = CallPermission(bob, bytes4(0), RuleKind.NONE);
        p.trustedSpenders = new address[](1);
        p.trustedSpenders[0] = PAD;
        p.maxDeadlineWindow = 600;

        Call[] memory calls = new Call[](6);
        calls[0] = Call(root, 0, abi.encodeCall(IERC7914.approveNative, (ERC20ETH, 0)));
        calls[1] = Call(root, 0, abi.encodeCall(IKeyManagement.register, (key)));
        calls[2] = Call(root, 0, abi.encodeCall(IKeyManagement.update, (kh, settings)));
        calls[3] = Call(HOOK, 0, abi.encodeCall(IAgentPolicyHook.setPolicy, (kh, p)));
        // The human's own meme position.
        calls[4] = Call(MUSD, 0, abi.encodeCall(IERC20.approve, (PAD, 10e6)));
        calls[5] = Call(
            PAD, 0, abi.encodeCall(ILaunchpad.buy, (MEME, 10e6, 0, block.timestamp + 60, root))
        );
        vm.signAndAttachDelegation(CALIBUR, ROOT_PK);
        vm.prank(root);
        account.execute(BatchedCall(calls, true));
        assertEq(root.code, abi.encodePacked(hex"ef0100", CALIBUR));
    }

    function one(address to, bytes memory data) internal pure returns (Call[] memory c) {
        c = new Call[](1);
        c[0] = Call(to, 0, data);
    }

    function direct(Call[] memory calls) internal returns (bool ok, bytes memory ret) {
        vm.prank(agent);
        try account.execute(BatchedCall(calls, true)) {
            ok = true;
        } catch (bytes memory r) {
            ret = r;
        }
    }

    function relayed(Call[] memory calls) internal returns (bool ok, bytes memory ret) {
        uint192 lane = uint192(uint256(kh) >> 64);
        SignedBatchedCall memory sbc = SignedBatchedCall({
            batchedCall: BatchedCall(calls, true),
            nonce: uint256(lane) << 64 | account.getSeq(lane),
            keyHash: kh,
            executor: relayer,
            deadline: block.timestamp + 120
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, account.hashTypedData(SignedBatchedCallLib.hash(sbc)));
        vm.prank(relayer);
        try account.execute(sbc, abi.encode(abi.encodePacked(r, s, v), bytes(""))) {
            ok = true;
        } catch (bytes memory reason) {
            ret = reason;
        }
    }

    function assertRejected(Call[] memory calls, bytes memory expected) internal {
        (bool ok, bytes memory ret) = direct(calls);
        assertFalse(ok);
        assertEq(ret, expected);
        (ok, ret) = relayed(calls);
        assertFalse(ok);
        assertEq(ret, expected);
    }

    function test_fork_deployedBytecode_overreachRejected_allowedPathMetered() public {
        Call[] memory buy = new Call[](2);
        buy[0] = Call(MUSD, 0, abi.encodeCall(IERC20.approve, (PAD, 5e6)));
        buy[1] = Call(
            PAD, 0, abi.encodeCall(ILaunchpad.buy, (MEME, 5e6, 0, block.timestamp + 60, root))
        );
        (bool ok,) = relayed(buy);
        assertTrue(ok);
        assertEq(IAgentPolicyHook(HOOK).getSpent(kh, root, MUSD).total, 5e6);
        uint256 inv = IAgentPolicyHook(HOOK).inventory(kh, root, MEME);
        assertGt(inv, 0);

        assertRejected(
            one(MUSD, abi.encodeCall(IERC20.transfer, (bob, 1))),
            abi.encodeWithSelector(
                IAgentPolicyHook.CallNotPermitted.selector, MUSD, IERC20.transfer.selector
            )
        );
        assertRejected(
            one(MUSD, abi.encodeCall(IERC20.approve, (PAD, 45e6 + 1))),
            abi.encodeWithSelector(IAgentPolicyHook.LimitExceeded.selector, MUSD)
        );
        assertRejected(
            one(PAD, abi.encodeCall(ILaunchpad.sell, (MEME, inv + 1, 0, block.timestamp, root))),
            abi.encodeWithSelector(IAgentPolicyHook.InventoryExceeded.selector, MEME, inv)
        );
        assertRejected(
            one(HOOK, abi.encodeCall(IAgentPolicyHook.revoke, (kh))),
            abi.encodeWithSelector(IAgentPolicyHook.TargetIsHook.selector)
        );
        assertRejected(
            one(PAD, abi.encodeCall(ILaunchpad.sell, (MEME, 1, 0, block.timestamp, bob))),
            abi.encodeWithSelector(IAgentPolicyHook.RecipientNotAccount.selector, bob)
        );
        assertRejected(
            one(PAD, abi.encodeCall(ILaunchpad.sell, (MEME, 1, 0, block.timestamp + 601, root))),
            abi.encodeWithSelector(
                IAgentPolicyHook.DeadlineOutOfRange.selector, block.timestamp + 601
            )
        );

        vm.prank(root);
        account.execute(BatchedCall(one(HOOK, abi.encodeCall(IAgentPolicyHook.revoke, (kh))), true));
        assertRejected(
            one(bob, ""), abi.encodeWithSelector(IAgentPolicyHook.SessionInactive.selector)
        );
    }
}
