// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC7914} from "calibur/interfaces/IERC7914.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
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
import {MockLaunchpad} from "../../src/mocks/MockLaunchpad.sol";
import {MockUSD} from "../../src/mocks/MockUSD.sol";
import {CaliburSessionBase} from "../hook/CaliburSessionBase.sol";

/// @notice DESIGN §4.2.3 size limits / §7.3 panic, at the maximum: 8 active sessions, each with 4
///         quote assets × 4 trusted spenders holding a live allowance, every (asset, spender)
///         pair distinct across sessions (128 allowance resets), each session also holding meme
///         inventory. One root transaction (`--self-pay`: the root EOA calls its own
///         `execute(BatchedCall)`) does 8 Calibur revokes + 8 hook tombstones + 128 resets; the
///         hook does no inventory iteration.
contract PanicMaxSizeTest is CaliburSessionBase {
    uint256 internal constant SESSIONS = 8;
    uint256 internal constant ASSETS = 4;
    uint256 internal constant SPENDERS = 4;
    /// @dev Mantle Sepolia `eth_getBlockByNumber(latest).gasLimit` at block 45379405.
    uint256 internal constant MANTLE_SEPOLIA_BLOCK_GAS_LIMIT = 60_000_000;
    /// @dev EIP-7825 per-transaction gas cap (2^24), the tighter bound where it applies.
    uint256 internal constant EIP7825_TX_GAS_CAP = 16_777_216;

    uint256[SESSIONS] internal pks;
    bytes32[SESSIONS] internal khs;
    address[ASSETS][SESSIONS] internal assets;
    address[SPENDERS][SESSIONS] internal spenders;
    address[SESSIONS] internal memes;

    function setUp() public override {
        super.setUp();
        Call[] memory init = new Call[](1 + 3 * SESSIONS);
        init[0] = Call(root, 0, abi.encodeCall(IERC7914.approveNative, (ERC20ETH, 0)));
        for (uint256 i; i < SESSIONS; ++i) {
            MockLaunchpad lp = new MockLaunchpad(address(usd));
            memes[i] = lp.createToken("Meme", "MEME");
            assets[i][0] = address(usd);
            spenders[i][0] = address(lp);
            for (uint256 j = 1; j < ASSETS; ++j) {
                MockUSD token = new MockUSD();
                token.mint(root, 1_000e6);
                assets[i][j] = address(token);
            }
            for (uint256 j = 1; j < SPENDERS; ++j) {
                spenders[i][j] = makeAddr(string.concat("spender", vm.toString(i * 4 + j)));
            }
            pks[i] = 0x5E5510 + i;
            khs[i] = keyHashOf(pks[i]);
            Call[] memory g = grantCalls(pks[i], maxPolicy(i, lp), expiry);
            for (uint256 k; k < 3; ++k) {
                init[1 + 3 * i + k] = g[k];
            }
        }
        vm.signAndAttachDelegation(calibur, ROOT_PK);
        rootExec(init);
        assertEq(hook.activeSessions(root), SESSIONS);

        // Every session approves all 16 of its pairs and buys once (leaving 1e6 on the
        // launchpad allowance), through its own hooked execution.
        for (uint256 i; i < SESSIONS; ++i) {
            Call[] memory calls = new Call[](ASSETS * SPENDERS + 1);
            for (uint256 a; a < ASSETS; ++a) {
                for (uint256 s; s < SPENDERS; ++s) {
                    calls[a * SPENDERS + s] = Call(
                        assets[i][a], 0, abi.encodeCall(IERC20.approve, (spenders[i][s], 2e6))
                    );
                }
            }
            calls[ASSETS * SPENDERS] = Call(
                spenders[i][0],
                0,
                abi.encodeCall(ILaunchpad.buy, (memes[i], 1e6, 0, block.timestamp + 60, root))
            );
            (bool ok, bytes memory ret) = exec(Entry.Direct, pks[i], calls);
            assertTrue(ok, vm.toString(ret));
        }
    }

    function maxPolicy(uint256 i, MockLaunchpad lp) internal view returns (Policy memory p) {
        p.quoteLimits = new QuoteLimit[](ASSETS);
        p.permissions = new CallPermission[](ASSETS + 2);
        for (uint256 a; a < ASSETS; ++a) {
            p.quoteLimits[a] = QuoteLimit(assets[i][a], 100e6, 50e6);
            p.permissions[a] =
                CallPermission(assets[i][a], IERC20.approve.selector, RuleKind.ERC20_APPROVE);
        }
        p.permissions[ASSETS] =
            CallPermission(address(lp), ILaunchpad.buy.selector, RuleKind.LAUNCHPAD_BUY);
        p.permissions[ASSETS + 1] =
            CallPermission(address(lp), ILaunchpad.sell.selector, RuleKind.LAUNCHPAD_SELL);
        p.periodLength = 1 days;
        p.trustedSpenders = new address[](SPENDERS);
        for (uint256 s; s < SPENDERS; ++s) {
            p.trustedSpenders[s] = spenders[i][s];
        }
        p.maxDeadlineWindow = 600;
    }

    function panicCalls() internal view returns (Call[] memory calls) {
        calls = new Call[](SESSIONS * (2 + ASSETS * SPENDERS));
        uint256 n;
        for (uint256 i; i < SESSIONS; ++i) {
            calls[n++] = Call(root, 0, abi.encodeCall(IKeyManagement.revoke, (khs[i])));
            calls[n++] = Call(address(hook), 0, abi.encodeCall(IAgentPolicyHook.revoke, (khs[i])));
        }
        for (uint256 i; i < SESSIONS; ++i) {
            for (uint256 a; a < ASSETS; ++a) {
                for (uint256 s; s < SPENDERS; ++s) {
                    calls[n++] =
                        Call(assets[i][a], 0, abi.encodeCall(IERC20.approve, (spenders[i][s], 0)));
                }
            }
        }
    }

    /// @dev `vm.lastCallGas()` read as its first five fields (this forge-std's `Vm.Gas` declares
    ///      more fields than the pinned forge returns, so the typed call cannot decode it).
    function lastCallGas() internal view returns (uint256 gasUsed, uint256 refund) {
        (bool ok, bytes memory ret) =
            address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        assertTrue(ok);
        (, uint64 used,, int64 refunded,) = abi.decode(ret, (uint64, uint64, uint64, int64, uint64));
        gasUsed = used;
        // forge-lint: disable-next-line(unsafe-typecast)
        refund = refunded > 0 ? uint64(refunded) : 0; // positive int64 fits uint64
    }

    /// @dev EIP-2028 calldata cost and the EIP-7623 floor of a transaction carrying `data`.
    function calldataGas(bytes memory data)
        internal
        pure
        returns (uint256 standard, uint256 floor)
    {
        uint256 zeros;
        for (uint256 i; i < data.length; ++i) {
            if (data[i] == 0) ++zeros;
        }
        uint256 nonZeros = data.length - zeros;
        standard = 4 * zeros + 16 * nonZeros;
        floor = 21_000 + 10 * (zeros + 4 * nonZeros);
    }

    /// forge-config: default.isolate = true
    function test_panic_maxSize_oneTransaction_gasRecorded() public {
        uint256 pairs;
        uint256[SESSIONS] memory inventoryBefore;
        for (uint256 i; i < SESSIONS; ++i) {
            inventoryBefore[i] = hook.inventory(khs[i], root, memes[i]);
            assertEq(inventoryBefore[i], 1e6 * 1e15);
            for (uint256 a; a < ASSETS; ++a) {
                for (uint256 s; s < SPENDERS; ++s) {
                    if (IERC20(assets[i][a]).allowance(root, spenders[i][s]) != 0) ++pairs;
                }
            }
        }
        assertEq(pairs, 128, "live allowance pairs");

        Call[] memory calls = panicCalls();
        assertEq(calls.length, 8 + 8 + 128);
        vm.prank(root);
        account.execute(BatchedCall(calls, true));
        (uint256 gasUsed, uint256 refund) = lastCallGas();

        (uint256 dataGas, uint256 floor) = calldataGas(
            abi.encodeWithSignature(
                "execute(((address,uint256,bytes)[],bool))", BatchedCall(calls, true)
            )
        );
        console.log("panic calls", calls.length);
        // Isolated, so cold storage is priced as in a real transaction; the figure includes the
        // intrinsic 21000 and the calldata cost.
        console.log("panic transaction gas before refund (isolated)", gasUsed);
        console.log("panic refund counter", refund);
        console.log("panic calldata: EIP-2028 gas / EIP-7623 floor", dataGas, floor);
        console.log("Mantle Sepolia block gas limit", MANTLE_SEPOLIA_BLOCK_GAS_LIMIT);
        assertGt(gasUsed, floor);
        assertLt(gasUsed, EIP7825_TX_GAS_CAP);
        assertLt(gasUsed, MANTLE_SEPOLIA_BLOCK_GAS_LIMIT);

        assertEq(account.keyCount(), 0);
        assertEq(hook.activeSessions(root), 0);
        for (uint256 i; i < SESSIONS; ++i) {
            assertTrue(hook.getSummary(khs[i], root).revoked);
            assertFalse(hook.getSummary(khs[i], root).active);
            // No inventory iteration: positions stay frozen until the root releases them.
            assertEq(hook.inventory(khs[i], root, memes[i]), inventoryBefore[i]);
            assertEq(hook.reserved(root, memes[i]), inventoryBefore[i]);
            for (uint256 a; a < ASSETS; ++a) {
                for (uint256 s; s < SPENDERS; ++s) {
                    assertEq(IERC20(assets[i][a]).allowance(root, spenders[i][s]), 0);
                }
            }
            (bool ok,) = exec(Entry.Direct, pks[i], one(bob, 0, ""));
            assertFalse(ok);
        }
    }
}
