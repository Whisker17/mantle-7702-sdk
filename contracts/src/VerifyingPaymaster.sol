// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

/* solhint-disable reason-string */

// Ported from eth-infinitism account-abstraction v0.7.0 `contracts/samples/VerifyingPaymaster.sol`
// (GPL-3.0) onto the v0.8.0 `core/BasePaymaster`. Changes from the sample: the hash also covers
// the EntryPoint address, the sender must be an EIP-7702 account delegated to `CALIBUR_ENTRY`,
// and only 65-byte signatures are accepted (OpenZeppelin 5.x `ECDSA.recover` rejects 64-byte ones).

import "account-abstraction/core/BasePaymaster.sol";
import "account-abstraction/core/UserOperationLib.sol";
import "account-abstraction/core/Helpers.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * A sample paymaster that uses external service to decide whether to pay for the UserOp.
 * The paymaster trusts an external signer to sign the transaction.
 * The calling user must pass the UserOp to that external signer first, which performs
 * whatever off-chain verification before signing the UserOp.
 * Note that this signature is NOT a replacement for the account-specific signature:
 * - the paymaster checks a signature to agree to PAY for GAS.
 * - the account checks a signature to prove identity and account ownership.
 * It only pays for an EIP-7702 account whose code is exactly `0xef0100 ‖ CALIBUR_ENTRY`, so a
 * signature cannot be reused after the account re-delegates to another implementation.
 */
contract VerifyingPaymaster is BasePaymaster {
    address public immutable verifyingSigner;

    /// @notice The only implementation a sponsored sender may be delegated to.
    address public immutable CALIBUR_ENTRY;

    /// @dev keccak256(0xef0100 ‖ CALIBUR_ENTRY): EXTCODEHASH of an account delegated to it.
    bytes32 private immutable DELEGATION_CODEHASH;

    uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;

    uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 64;

    constructor(IEntryPoint _entryPoint, address _verifyingSigner, address _caliburEntry)
        BasePaymaster(_entryPoint)
    {
        verifyingSigner = _verifyingSigner;
        CALIBUR_ENTRY = _caliburEntry;
        DELEGATION_CODEHASH = keccak256(abi.encodePacked(bytes3(0xef0100), _caliburEntry));
    }

    /**
     * return the hash we're going to sign off-chain (and validate on-chain)
     * this method is called by the off-chain service, to sign the request.
     * it is called on-chain from the validatePaymasterUserOp, to validate the signature.
     * note that this signature covers all fields of the UserOperation, except the "paymasterAndData",
     * which will carry the signature itself (and the account "signature").
     * Of "paymasterAndData" it covers the paymaster address (address(this)), both gas limits
     * ([PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET]), validUntil and validAfter.
     */
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        //can't use userOp.hash(), since it contains also the paymasterAndData itself.
        bytes calldata pmd = userOp.paymasterAndData;
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(pmd[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
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

    /**
     * verify the sender is delegated to CALIBUR_ENTRY and our external signer signed this request.
     * paymasterAndData layout (UserOperationLib offsets):
     * [:PAYMASTER_DATA_OFFSET] : address(this), paymaster verification gas, postOp gas
     * [VALID_TIMESTAMP_OFFSET:SIGNATURE_OFFSET] : abi.encode(validUntil, validAfter)
     * [SIGNATURE_OFFSET:] : 65-byte signature
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32, /*userOpHash*/
        uint256 requiredPreFund
    ) internal view override returns (bytes memory context, uint256 validationData) {
        (requiredPreFund);

        // ERC-7562 AUTH-030: EXTCODE* on the sender of the current UserOperation is allowed.
        // Checked whatever the initCode (empty or the EIP-7702 marker).
        require(
            userOp.sender.codehash == DELEGATION_CODEHASH,
            "VerifyingPaymaster: sender not delegated to CALIBUR_ENTRY"
        );

        (uint48 validUntil, uint48 validAfter, bytes calldata signature) =
            parsePaymasterAndData(userOp.paymasterAndData);
        // OpenZeppelin 5.x ECDSA only supports 65-byte signatures.
        // we only "require" it here so that the revert reason on invalid signature will be of "VerifyingPaymaster", and not "ECDSA"
        require(
            signature.length == 65,
            "VerifyingPaymaster: invalid signature length in paymasterAndData"
        );
        bytes32 hash =
            MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));

        //don't revert on signature failure: return SIG_VALIDATION_FAILED
        if (verifyingSigner != ECDSA.recover(hash, signature)) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        //no need for other on-chain validation: entire UserOp should have been checked
        // by the external service prior to signing it.
        return ("", _packValidationData(false, validUntil, validAfter));
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        (validUntil, validAfter) =
            abi.decode(paymasterAndData[VALID_TIMESTAMP_OFFSET:], (uint48, uint48));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }
}
