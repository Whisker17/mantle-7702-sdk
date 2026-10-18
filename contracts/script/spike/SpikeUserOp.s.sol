// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {Vm} from "forge-std/Vm.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {SpikePaymaster} from "../../src/spike/SpikePaymaster.sol";
import {SpikeTarget} from "../../src/spike/SpikeTarget.sol";
import {SpikeBase} from "./SpikeBase.sol";

/// @notice Builds and signs EntryPoint v0.8 UserOps for the bundler path and prints them as
///         ERC-7769 JSON (`SPIKE_USEROP=<json>`). Nothing is broadcast: the e2e driver sends the
///         JSON to the bundler. Every op is sponsored by SpikePaymaster.
/// Env: SESSION_PRIVATE_KEY, PMSIGNER_PRIVATE_KEY, SPIKE_CALIBUR, SPIKE_PAYMASTER, SPIKE_HOOK,
///      SPIKE_TARGET, the account's root key (see each entry point), gas fields OP_* (defaults
///      in `_gas`).
contract SpikeUserOp is SpikeBase {
    struct Gas {
        uint256 callGas;
        uint256 verificationGas;
        uint256 preVerificationGas;
        uint256 pmVerificationGas;
        uint256 pmPostOpGas;
        uint256 maxFee;
        uint256 maxPriorityFee;
    }

    /// @dev What to sign: `keyHash = 0` signs as the root (raw ECDSA signature).
    struct Spec {
        uint256 rootPk;
        uint256 signerPk;
        bytes32 keyHash;
        uint192 lane;
        bytes callData;
        bool withAuth;
    }

    string internal constant J = "userop";

    /// @notice Session UserOp on the session's lane: `SpikeTarget.ping(tag)` for the account of
    ///         ROOT_PRIVATE_KEY, optionally with an `eip7702Auth` re-authorizing CaliburEntry.
    function session(uint256 tag, bool withAuth) external {
        uint256 sessionPk = vm.envUint("SESSION_PRIVATE_KEY");
        bytes32 keyHash = _keyHash(vm.addr(sessionPk));
        Call[] memory calls = new Call[](1);
        calls[0] = Call(vm.envAddress("SPIKE_TARGET"), 0, abi.encodeCall(SpikeTarget.ping, (tag)));
        _build(
            Spec(
                vm.envUint("ROOT_PRIVATE_KEY"),
                sessionPk,
                keyHash,
                _lane(keyHash),
                _callData(calls),
                withAuth
            )
        );
    }

    /// @notice Bundler-path init (DESIGN §7.1, 4337 variant): a root UserOp with `eip7702Auth`
    ///         for the fresh EOA of INITROOT_PRIVATE_KEY, running the grant batch.
    function rootInit() external {
        uint256 rootPk = vm.envUint("INITROOT_PRIVATE_KEY");
        address root = vm.addr(rootPk);
        require(root.code.length == 0, "init root already delegated");
        Call[] memory calls = _grantCalls(root, vm.addr(vm.envUint("SESSION_PRIVATE_KEY")));
        _build(Spec(rootPk, rootPk, bytes32(0), 0, _callData(calls), true));
    }

    function _build(Spec memory spec) internal {
        _requireMantleSepolia();
        Gas memory g = _gas();
        (PackedUserOperation memory op, bytes memory paymasterData, bytes32 userOpHash) =
            _signedOp(spec, g);

        vm.serializeAddress(J, "sender", op.sender);
        vm.serializeString(J, "nonce", _hex(op.nonce));
        vm.serializeBytes(J, "callData", op.callData);
        vm.serializeString(J, "callGasLimit", _hex(g.callGas));
        vm.serializeString(J, "verificationGasLimit", _hex(g.verificationGas));
        vm.serializeString(J, "preVerificationGas", _hex(g.preVerificationGas));
        vm.serializeString(J, "maxFeePerGas", _hex(g.maxFee));
        vm.serializeString(J, "maxPriorityFeePerGas", _hex(g.maxPriorityFee));
        vm.serializeAddress(J, "paymaster", vm.envAddress("SPIKE_PAYMASTER"));
        vm.serializeString(J, "paymasterVerificationGasLimit", _hex(g.pmVerificationGas));
        vm.serializeString(J, "paymasterPostOpGasLimit", _hex(g.pmPostOpGas));
        vm.serializeBytes(J, "paymasterData", paymasterData);
        if (spec.withAuth) {
            vm.serializeString(J, "factory", "0x7702");
            vm.serializeString(J, "factoryData", "0x");
            vm.serializeString(J, "eip7702Auth", _auth(spec.rootPk));
        }
        string memory json = vm.serializeBytes(J, "signature", op.signature);
        console.log("SPIKE_USEROP_HASH=%s", vm.toString(userOpHash));
        console.log("SPIKE_USEROP=%s", json);
    }

    function _signedOp(Spec memory spec, Gas memory g)
        internal
        returns (PackedUserOperation memory op, bytes memory paymasterData, bytes32 userOpHash)
    {
        SpikePaymaster paymaster = SpikePaymaster(vm.envAddress("SPIKE_PAYMASTER"));
        op.sender = vm.addr(spec.rootPk);
        op.nonce = IEntryPoint(ENTRY_POINT_V08).getNonce(op.sender, spec.lane);
        // The short marker, as viem / Alto pack `factory = 0x7702` with empty factoryData; the
        // paymaster hash covers these exact initCode bytes.
        if (spec.withAuth) op.initCode = hex"7702";
        op.callData = spec.callData;
        op.accountGasLimits = bytes32((g.verificationGas << 128) | g.callGas);
        op.preVerificationGas = g.preVerificationGas;
        op.gasFees = bytes32((g.maxPriorityFee << 128) | g.maxFee);

        uint48 validUntil = uint48(block.timestamp + 10 minutes);
        bytes memory pmFixed = abi.encodePacked(
            address(paymaster), uint128(g.pmVerificationGas), uint128(g.pmPostOpGas)
        );
        op.paymasterAndData = abi.encodePacked(pmFixed, validUntil, uint48(0));
        bytes32 pmHash = paymaster.getHash(op, validUntil, 0);
        bytes memory pmSig = _sign(
            vm.envUint("PMSIGNER_PRIVATE_KEY"),
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", pmHash))
        );
        paymasterData = abi.encodePacked(validUntil, uint48(0), pmSig);
        op.paymasterAndData = abi.encodePacked(pmFixed, paymasterData);

        // v0.8 hashes the delegate in place of the 0x7702 marker and reads it from the sender's
        // code. A fresh EOA is delegated only by the bundle itself: etch locally (never
        // broadcast) so getUserOpHash sees the delegation the authorization will install.
        if (spec.withAuth && op.sender.code.length == 0) {
            vm.etch(op.sender, abi.encodePacked(hex"ef0100", vm.envAddress("SPIKE_CALIBUR")));
        }
        userOpHash = IEntryPoint(ENTRY_POINT_V08).getUserOpHash(op);
        bytes memory sig = _sign(spec.signerPk, userOpHash);
        op.signature = spec.keyHash == bytes32(0) ? sig : abi.encode(spec.keyHash, sig, bytes(""));
    }

    /// @dev `executeUserOp.selector ‖ abi.encode(BatchedCall)` — what Calibur decodes.
    function _callData(Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodePacked(
            IAccountExecute.executeUserOp.selector, abi.encode(BatchedCall(calls, true))
        );
    }

    /// @dev The root's authorization at its current account nonce (the bundle sender is the
    ///      bundler's executor, not the root).
    function _auth(uint256 rootPk) internal returns (string memory) {
        Vm.SignedDelegation memory sd = vm.signDelegation(
            vm.envAddress("SPIKE_CALIBUR"), rootPk, uint64(vm.getNonce(vm.addr(rootPk)))
        );
        string memory a = "auth";
        vm.serializeAddress(a, "address", sd.implementation);
        vm.serializeString(a, "chainId", _hex(block.chainid));
        vm.serializeString(a, "nonce", _hex(sd.nonce));
        vm.serializeBytes32(a, "r", sd.r);
        vm.serializeBytes32(a, "s", sd.s);
        return vm.serializeString(a, "yParity", _hex(sd.v));
    }

    function _gas() internal view returns (Gas memory g) {
        g.callGas = vm.envOr("OP_CALL_GAS", uint256(300_000));
        g.verificationGas = vm.envOr("OP_VERIFICATION_GAS", uint256(300_000));
        g.preVerificationGas = vm.envOr("OP_PRE_VERIFICATION_GAS", uint256(100_000));
        g.pmVerificationGas = vm.envOr("OP_PM_VERIFICATION_GAS", uint256(100_000));
        g.pmPostOpGas = vm.envOr("OP_PM_POSTOP_GAS", uint256(0));
        g.maxFee = vm.envOr("OP_MAX_FEE", uint256(60 gwei));
        g.maxPriorityFee = vm.envOr("OP_MAX_PRIORITY_FEE", uint256(100_000));
    }

    /// @dev 0x-prefixed, 32-byte zero-padded hex quantity (accepted by the bundler's schema).
    function _hex(uint256 x) internal pure returns (string memory) {
        return vm.toString(bytes32(x));
    }
}
