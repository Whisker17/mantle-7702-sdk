// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MemeToken} from "../src/mocks/MemeToken.sol";
import {MockLaunchpad} from "../src/mocks/MockLaunchpad.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";

/// @notice Deploys the acceptance fixture (DESIGN §8) in one run: MockUSD, MockLaunchpad (the
///         MemeToken factory) quoted in MockUSD, and one MemeToken created through the launchpad.
///         Default profile; plain CREATE from the broadcaster.
///   deploy: forge script script/DeployMocks.s.sol --rpc-url $RPC --broadcast --account ...
///   verify: ADDRESS_BOOK="$(cat ../deployments/mantle-sepolia.json)" \
///           forge script script/DeployMocks.s.sol --sig 'verify()' --rpc-url $RPC
contract DeployMocks is Script {
    using stdJson for string;

    string internal constant MEME_NAME = "Agent Meme";
    string internal constant MEME_SYMBOL = "AMEME";

    function run() external returns (MockUSD usd, MockLaunchpad pad, address meme) {
        vm.startBroadcast();
        usd = new MockUSD();
        pad = new MockLaunchpad(address(usd));
        meme = pad.createToken(MEME_NAME, MEME_SYMBOL);
        vm.stopBroadcast();

        require(pad.quoteToken() == address(usd) && pad.isRegistered(meme), "fixture wiring");
        console.log("MockUSD", address(usd));
        console.log("MockLaunchpad", address(pad));
        console.log("MemeToken", meme);
    }

    /// @notice Read-only on chain: checks `MockUSD`, `MockLaunchpad` and `MemeToken` of the
    ///         address book (JSON in `ADDRESS_BOOK`; the default profile cannot read files)
    ///         against chain and the local build. The local build is deployed only in the
    ///         simulation, to compare its runtime code with the on-chain code.
    function verify() external {
        string memory book = vm.envString("ADDRESS_BOOK");
        require(book.readUint(".chainId") == block.chainid, "chainId mismatch");
        address usd = book.readAddress(".MockUSD.address");
        address pad = book.readAddress(".MockLaunchpad.address");
        address meme = book.readAddress(".MemeToken.address");
        string memory name = book.readString(".MemeToken.name");
        string memory symbol = book.readString(".MemeToken.symbol");

        _checkCode(book, ".MockUSD", usd, type(MockUSD).creationCode);
        _checkCode(
            book,
            ".MockLaunchpad",
            pad,
            bytes.concat(type(MockLaunchpad).creationCode, abi.encode(usd))
        );
        // MemeToken records its creator as `launchpad`: build it locally as the launchpad.
        Vm(address(vm)).prank(pad);
        _checkCode(
            book,
            ".MemeToken",
            meme,
            bytes.concat(type(MemeToken).creationCode, abi.encode(name, symbol))
        );

        require(MockUSD(usd).decimals() == 6, "MockUSD decimals");
        require(book.readAddress(".MockLaunchpad.quoteToken") == usd, "book quoteToken");
        require(MockLaunchpad(pad).quoteToken() == usd, "quoteToken");
        require(book.readAddress(".MemeToken.launchpad") == pad, "book launchpad");
        require(MemeToken(meme).launchpad() == pad, "launchpad");
        require(MockLaunchpad(pad).isRegistered(meme), "meme not registered");
        require(_eq(MemeToken(meme).name(), name) && _eq(MemeToken(meme).symbol(), symbol), "meta");
        console.log("mocks verified", usd, pad, meme);
    }

    /// @dev Book init code hash = local init code; on-chain code hash = book = the code the local
    ///      init code produces (the local CREATE takes a pending prank as its creator).
    function _checkCode(string memory book, string memory key, address at, bytes memory initCode)
        internal
    {
        require(at.code.length != 0, string.concat(key, ": no code"));
        require(
            book.readBytes32(string.concat(key, ".initCodeHash")) == keccak256(initCode),
            string.concat(key, ": initCodeHash")
        );
        require(
            at.codehash == book.readBytes32(string.concat(key, ".runtimeCodeHash")),
            string.concat(key, ": runtimeCodeHash")
        );
        address local;
        assembly ("memory-safe") {
            local := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(local.codehash == at.codehash, string.concat(key, ": local build differs"));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
