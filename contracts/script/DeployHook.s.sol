// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ICalibur} from "calibur/interfaces/ICalibur.sol";
import {IKeyManagement} from "calibur/interfaces/IKeyManagement.sol";
import {BatchedCall} from "calibur/libraries/BatchedCallLib.sol";
import {Call} from "calibur/libraries/CallLib.sol";
import {HooksLib} from "calibur/libraries/HooksLib.sol";
import {Key, KeyType} from "calibur/libraries/KeyLib.sol";
import {Settings} from "calibur/libraries/SettingsLib.sol";
import {AgentPolicyHook} from "../src/AgentPolicyHook.sol";

/// @notice Deploys AgentPolicyHook through the CREATE2 deterministic deployer at a mined address
///         whose low five bits are `0x1f`, so Calibur calls all five callbacks (DESIGN §4.1, I7).
///         Default profile. The address book is passed as JSON in `ADDRESS_BOOK` (the default
///         profile has no `fs_permissions`); the hook's constructor argument is
///         `.VerifyingPaymaster.address` from it.
///   export ADDRESS_BOOK="$(cat ../deployments/mantle-sepolia.json)"
///   deploy: forge script script/DeployHook.s.sol --rpc-url $RPC --broadcast --account ...
///   verify: forge script script/DeployHook.s.sol --sig 'verify()' --rpc-url $RPC
contract DeployHook is Script {
    using stdJson for string;

    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external returns (address hook, bytes32 salt) {
        string memory book = vm.envString("ADDRESS_BOOK");
        require(book.readUint(".chainId") == block.chainid, "chainId mismatch");
        address paymaster = book.readAddress(".VerifyingPaymaster.address");
        require(paymaster.code.length != 0, "paymaster has no code");
        require(DETERMINISTIC_DEPLOYER.code.length != 0, "no deterministic deployer");

        bytes memory initCode = _initCode(paymaster);
        bytes32 initCodeHash = keccak256(initCode);
        (salt, hook) = mineSalt(initCodeHash);
        require(hook.code.length == 0, "hook address already has code");

        vm.broadcast();
        (bool ok,) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, "CREATE2 deployment failed");

        _checkHook(hook, paymaster);
        console.log("AgentPolicyHook", hook);
        console.logBytes32(salt);
        console.logBytes32(initCodeHash);
        console.logBytes32(hook.codehash);
    }

    /// @notice First salt (counting from 0) whose CREATE2 address carries all five hook flags.
    function mineSalt(bytes32 initCodeHash) public pure returns (bytes32 salt, address hook) {
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            hook = vm.computeCreate2Address(salt, initCodeHash, DETERMINISTIC_DEPLOYER);
            if (uint160(hook) & HooksLib.ALL_FLAGS == HooksLib.ALL_FLAGS) return (salt, hook);
        }
    }

    /// @notice Read-only on chain: checks `.AgentPolicyHook` of `ADDRESS_BOOK` against chain and
    ///         the local build, then simulates (no broadcast) a CaliburEntry-delegated EOA
    ///         attaching the hook to a session key, which `update()` rejects for a hook without
    ///         flags or code.
    function verify() external {
        string memory book = vm.envString("ADDRESS_BOOK");
        require(book.readUint(".chainId") == block.chainid, "chainId mismatch");
        address hook = book.readAddress(".AgentPolicyHook.address");
        address paymaster = book.readAddress(".AgentPolicyHook.paymaster");
        require(paymaster == book.readAddress(".VerifyingPaymaster.address"), "paymaster != book");

        bytes32 initCodeHash = keccak256(_initCode(paymaster));
        require(book.readBytes32(".AgentPolicyHook.initCodeHash") == initCodeHash, "initCodeHash");
        require(
            vm.computeCreate2Address(
                book.readBytes32(".AgentPolicyHook.salt"), initCodeHash, DETERMINISTIC_DEPLOYER
            ) == hook,
            "address is not CREATE2(deployer, salt, local init code)"
        );
        require(hook.codehash == book.readBytes32(".AgentPolicyHook.runtimeCodeHash"), "codehash");
        require(
            uint160(hook) & HooksLib.ALL_FLAGS
                == uint8(bytes(book.readBytes(".AgentPolicyHook.flags"))[0]),
            "flags != book"
        );
        _checkHook(hook, paymaster);
        _checkCaliburAccepts(book.readAddress(".CaliburEntry.address"), hook);
        console.log("AgentPolicyHook verified", hook);
    }

    /// @dev I7: all five flags and code; PAYMASTER is the constructor argument.
    function _checkHook(address hook, address paymaster) internal view {
        require(uint160(hook) & HooksLib.ALL_FLAGS == HooksLib.ALL_FLAGS, "flags != 0x1f");
        require(hook.code.length != 0, "hook has no code");
        require(AgentPolicyHook(hook).PAYMASTER() == paymaster, "PAYMASTER mismatch");
    }

    function _checkCaliburAccepts(address caliburEntry, address hook) internal {
        address eoa = makeAddr("delegated-eoa");
        // Script exposes only VmSafe; etch and prank only touch the local simulation.
        Vm(address(vm)).etch(eoa, bytes.concat(hex"ef0100", abi.encodePacked(caliburEntry)));
        Key memory key = Key(KeyType.Secp256k1, abi.encode(makeAddr("session-key")));
        bytes32 keyHash = keccak256(abi.encode(key.keyType, keccak256(key.publicKey)));
        Settings settings =
            Settings.wrap(uint256(uint160(hook)) | ((block.timestamp + 1 days) << 160));

        Call[] memory calls = new Call[](2);
        calls[0] = Call(eoa, 0, abi.encodeCall(IKeyManagement.register, (key)));
        calls[1] = Call(eoa, 0, abi.encodeCall(IKeyManagement.update, (keyHash, settings)));
        Vm(address(vm)).prank(eoa);
        ICalibur(eoa).execute(BatchedCall(calls, true));
        require(
            Settings.unwrap(ICalibur(eoa).getKeySettings(keyHash)) == Settings.unwrap(settings),
            "Calibur did not store the hook settings"
        );
    }

    function _initCode(address paymaster) internal pure returns (bytes memory) {
        return bytes.concat(type(AgentPolicyHook).creationCode, abi.encode(paymaster));
    }
}
