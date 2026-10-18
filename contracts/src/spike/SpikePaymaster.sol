// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @title SpikePaymaster
/// @notice THROWAWAY feasibility-spike paymaster (EntryPoint v0.8). Not the production
///         VerifyingPaymaster: it only reproduces the validation-time behaviour a strict bundler
///         has to accept — an off-chain signer over the UserOp, a validity window, and the
///         delegate binding (the sender's 23-byte code must be `0xef0100 ‖ CALIBUR`).
/// @dev Unstaked by design: validation reads only immutables, calldata and the sender's code
///      (ERC-7562 AUTH-030) and returns an empty context (EREP-050).
///      paymasterAndData = paymaster(20) ‖ pmVerificationGas(16) ‖ pmPostOpGas(16)
///                         ‖ validUntil(6) ‖ validAfter(6) ‖ signature(65)
contract SpikePaymaster is BasePaymaster {
    uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;
    uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 12;

    address public immutable CALIBUR;
    address public immutable SIGNER;
    bytes32 private immutable DELEGATION_CODE_HASH;

    error WrongDelegate();

    constructor(IEntryPoint entryPoint_, address calibur, address signer)
        BasePaymaster(entryPoint_)
    {
        CALIBUR = calibur;
        SIGNER = signer;
        DELEGATION_CODE_HASH = keccak256(abi.encodePacked(hex"ef0100", calibur));
    }

    /// @notice Digest the signer signs (EIP-191 personal-sign over this hash).
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                bytes32(
                    userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET]
                ),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                address(entryPoint),
                validUntil,
                validAfter
            )
        );
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        internal
        view
        override
        returns (bytes memory, uint256)
    {
        if (keccak256(userOp.sender.code) != DELEGATION_CODE_HASH) revert WrongDelegate();

        bytes calldata pmd = userOp.paymasterAndData;
        uint48 validUntil = uint48(bytes6(pmd[VALID_TIMESTAMP_OFFSET:VALID_TIMESTAMP_OFFSET + 6]));
        uint48 validAfter = uint48(bytes6(pmd[VALID_TIMESTAMP_OFFSET + 6:SIGNATURE_OFFSET]));
        bytes32 digest =
            MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(digest, pmd[SIGNATURE_OFFSET:]);
        bool sigFailed = err != ECDSA.RecoverError.NoError || recovered != SIGNER;
        return ("", _packValidationData(sigFailed, validUntil, validAfter));
    }
}
