// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IExecutionHook} from "calibur/interfaces/IExecutionHook.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Test-only ERC20 with open mint and burn.
contract TestToken is ERC20 {
    constructor(string memory symbol) ERC20(symbol, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice Test-only launchpad with the canonical ABI. BUY pulls `amountIn` quote from
///         `msg.sender` and mints the same amount of `token` to `recipient`; SELL burns `amount`
///         from `msg.sender` and pays the same amount of quote to `recipient`.
///         `fillPercent` scales the SELL burn to simulate partial fills and overfills.
contract FakeLaunchpad is ILaunchpad {
    address public immutable quoteToken;
    uint256 public fillPercent = 100;

    constructor(address quote) {
        quoteToken = quote;
    }

    function setFillPercent(uint256 percent) external {
        fillPercent = percent;
    }

    function buy(address token, uint256 amountIn, uint256, uint256, address recipient)
        external
        returns (uint256)
    {
        TestToken(quoteToken).transferFrom(msg.sender, address(this), amountIn);
        TestToken(token).mint(recipient, amountIn);
        return amountIn;
    }

    function sell(address token, uint256 amount, uint256, uint256, address recipient)
        external
        returns (uint256)
    {
        TestToken(token).burn(msg.sender, amount * fillPercent / 100);
        TestToken(quoteToken).mint(recipient, amount);
        return amount;
    }
}

/// @notice Test-only target that forwards one call (used to re-enter the account or the hook).
///         `tryRun` swallows a failure and records its revert data in `lastError`.
contract CallbackTarget {
    bytes public lastError;

    function tryRun(address target, bytes calldata data) external {
        (bool ok, bytes memory out) = target.call(data);
        if (!ok) lastError = out;
    }

    function run(address target, bytes calldata data) external payable {
        (bool ok, bytes memory out) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(out, 0x20), mload(out))
            }
        }
    }

    function fail() external pure {
        revert("target failed");
    }

    receive() external payable {}
}

/// @notice Test-only account reproducing Calibur v1.1.0 `_process`: beforeExecute, the call,
///         afterExecute (with `success` passed through), all with `msg.sender` = this account.
///         `root` performs an unhooked call, standing in for the root key.
contract MiniAccount {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    IExecutionHook public immutable hook;

    constructor(IExecutionHook hook_) {
        hook = hook_;
    }

    function exec(bytes32 keyHash, Call[] calldata calls) public {
        for (uint256 i; i < calls.length; ++i) {
            _process(keyHash, calls[i]);
        }
    }

    function exec1(bytes32 keyHash, address to, uint256 value, bytes calldata data) external {
        _process(keyHash, Call(to, value, data));
    }

    function root(address to, bytes calldata data) external returns (bytes memory out) {
        bool ok;
        (ok, out) = to.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(out, 0x20), mload(out))
            }
        }
    }

    function _process(bytes32 keyHash, Call memory c) private {
        (bytes4 sel, bytes memory ctx) = hook.beforeExecute(keyHash, c.to, c.value, c.data);
        require(sel == IExecutionHook.beforeExecute.selector, "bad before selector");
        (bool success, bytes memory output) = c.to.call{value: c.value}(c.data);
        require(
            hook.afterExecute(keyHash, success, output, ctx)
                == IExecutionHook.afterExecute.selector,
            "bad after selector"
        );
    }

    receive() external payable {}
}
