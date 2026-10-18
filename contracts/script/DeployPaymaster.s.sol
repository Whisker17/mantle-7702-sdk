// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

/// @notice Deploys VerifyingPaymaster against the canonical EntryPoint v0.8, funds its EntryPoint
///         deposit and checks the configuration. The broadcaster becomes the owner.
///
/// Environment:
///   PAYMASTER_SIGNER       sponsor signing address (a separate key; must not be the owner)
///   CALIBUR_ENTRY          the CaliburEntry implementation sponsored accounts delegate to
///   PAYMASTER_DEPOSIT_WEI  EntryPoint deposit to add, in wei (default 0); `verify` requires at
///                          least this much
/// The deployer key comes only from forge's wallet options (`--account`, `--ledger`, ...).
///
///   forge script script/DeployPaymaster.s.sol --rpc-url "$MANTLE_SEPOLIA_RPC_URL" \
///     --account <keystore> --broadcast
///   # then re-read the live configuration from chain:
///   forge script script/DeployPaymaster.s.sol --rpc-url "$MANTLE_SEPOLIA_RPC_URL" \
///     --sig "verify(address)" <paymaster>
contract DeployPaymaster is Script {
    address internal constant ENTRY_POINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    function run() external returns (VerifyingPaymaster paymaster) {
        address signer = vm.envAddress("PAYMASTER_SIGNER");
        address caliburEntry = vm.envAddress("CALIBUR_ENTRY");
        uint256 depositWei = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(0));
        require(ENTRY_POINT_V08.code.length != 0, "DeployPaymaster: no EntryPoint v0.8 code");
        require(caliburEntry.code.length != 0, "DeployPaymaster: CALIBUR_ENTRY has no code");

        vm.startBroadcast();
        paymaster = new VerifyingPaymaster(IEntryPoint(ENTRY_POINT_V08), signer, caliburEntry);
        if (depositWei != 0) paymaster.deposit{value: depositWei}();
        vm.stopBroadcast();

        verify(address(paymaster));
    }

    /// @notice Checks a deployed paymaster against the environment; reverts on any mismatch.
    function verify(address paymaster) public view {
        address signer = vm.envAddress("PAYMASTER_SIGNER");
        address caliburEntry = vm.envAddress("CALIBUR_ENTRY");
        uint256 minDeposit = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(0));
        VerifyingPaymaster p = VerifyingPaymaster(paymaster);

        require(paymaster.code.length != 0, "DeployPaymaster: paymaster has no code");
        require(address(p.entryPoint()) == ENTRY_POINT_V08, "DeployPaymaster: EntryPoint mismatch");
        require(p.verifyingSigner() == signer, "DeployPaymaster: verifyingSigner mismatch");
        require(p.CALIBUR_ENTRY() == caliburEntry, "DeployPaymaster: CALIBUR_ENTRY mismatch");
        require(p.owner() != signer, "DeployPaymaster: signer must not be the owner");
        uint256 deposit = IEntryPoint(ENTRY_POINT_V08).balanceOf(paymaster);
        require(deposit >= minDeposit, "DeployPaymaster: deposit below PAYMASTER_DEPOSIT_WEI");

        console.log("chainId", block.chainid);
        console.log("VerifyingPaymaster", paymaster);
        console.log("owner", p.owner());
        console.log("verifyingSigner", signer);
        console.log("CALIBUR_ENTRY", caliburEntry);
        console.log("EntryPoint deposit (wei)", deposit);
    }
}
