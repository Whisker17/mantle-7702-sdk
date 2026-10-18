// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {CaliburEntry} from "calibur/CaliburEntry.sol";

/// @notice Deploys CaliburEntry v1.1.0 through the CREATE2 deterministic deployer at its canonical
/// address, and verifies the recorded deployment against chain.
/// Run with `FOUNDRY_PROFILE=calibur` (Calibur's own compiler settings); with any other profile
/// the init code is not the canonical one and both entry points revert.
///   deploy: forge script script/DeployCalibur.s.sol --rpc-url $RPC --broadcast --account ...
///   verify: forge script script/DeployCalibur.s.sol --sig 'verify()' --rpc-url $RPC
contract DeployCalibur is Script {
    using stdJson for string;

    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Salt of the canonical deployment (lib/calibur/script/DeployCaliburEntry.s.sol).
    bytes32 internal constant SALT =
        0x3b55ce071a9e4ef8dd49e65ab8ba6c747bec4c1c5b8efc95909fb463c4e53396;
    address internal constant CANONICAL = 0x000000005c84F8Fd50b21CAC312528A64437030e;
    /// keccak256 of the canonical init code (Ethereum Sepolia tx 0xdee40508…8dff).
    bytes32 internal constant INIT_CODE_HASH =
        0xd3a7ea2bc0c320de0cb9288c0a3f67e8e07f7982d99fdac28208501bd1e74149;
    /// keccak256 of the runtime code at CANONICAL on Ethereum Sepolia.
    bytes32 internal constant RUNTIME_CODE_HASH =
        0xba697585ba58ba66ebd095ab4c7f980ed42ad115b2e3bb9b5b9bdf167bf08b1b;

    function run() external returns (address entry) {
        bytes memory initCode = _canonicalInitCode();
        entry = vm.computeCreate2Address(SALT, INIT_CODE_HASH, DETERMINISTIC_DEPLOYER);
        require(entry == CANONICAL, "unexpected CREATE2 address");
        require(DETERMINISTIC_DEPLOYER.code.length != 0, "no deterministic deployer");
        if (entry.code.length == 0) {
            vm.broadcast();
            (bool ok,) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            require(ok, "CREATE2 deployment failed");
        }
        require(entry.codehash == RUNTIME_CODE_HASH, "runtime code is not canonical");
    }

    /// @notice Read-only: checks `deployments/<network>.json` against chain and the local build.
    function verify() external view {
        string memory book =
            vm.readFile(string.concat(vm.projectRoot(), "/../deployments/mantle-sepolia.json"));
        require(book.readUint(".chainId") == block.chainid, "chainId mismatch");

        address entry = book.readAddress(".CaliburEntry.address");
        bytes32 salt = book.readBytes32(".CaliburEntry.salt");
        bytes32 initCodeHash = keccak256(_canonicalInitCode());
        require(book.readBytes32(".CaliburEntry.initCodeHash") == initCodeHash, "initCodeHash");
        require(
            vm.computeCreate2Address(salt, initCodeHash, DETERMINISTIC_DEPLOYER) == entry,
            "address is not CREATE2(deployer, salt, local init code)"
        );
        require(entry.codehash == book.readBytes32(".CaliburEntry.runtimeCodeHash"), "codehash");
        require(entry.codehash == RUNTIME_CODE_HASH, "runtime code is not canonical");

        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 domainSalt,
            uint256[] memory extensions
        ) = CaliburEntry(payable(entry)).eip712Domain();
        string memory d = ".CaliburEntry.eip712Domain";
        require(
            uint8(fields) == uint8(bytes(book.readBytes(string.concat(d, ".fields")))[0]), "fields"
        );
        require(
            keccak256(bytes(name)) == keccak256(bytes(book.readString(string.concat(d, ".name")))),
            "name"
        );
        require(
            keccak256(bytes(version))
                == keccak256(bytes(book.readString(string.concat(d, ".version")))),
            "version"
        );
        require(chainId == book.readUint(string.concat(d, ".chainId")), "domain chainId");
        require(
            verifyingContract == book.readAddress(string.concat(d, ".verifyingContract")),
            "verifyingContract"
        );
        require(domainSalt == book.readBytes32(string.concat(d, ".salt")), "domain salt");
        require(extensions.length == 0, "extensions");
    }

    function _canonicalInitCode() internal pure returns (bytes memory initCode) {
        initCode = type(CaliburEntry).creationCode;
        require(
            keccak256(initCode) == INIT_CODE_HASH,
            "init code not canonical: FOUNDRY_PROFILE=calibur"
        );
    }
}
