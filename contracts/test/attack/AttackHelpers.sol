// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILaunchpad} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Fee-on-transfer token (outside DESIGN §4.0/§4.4): every transfer between two holders
///         also burns 1% of the amount from the sender, so the sender loses `amount * 101 / 100`.
///         `launchpadPull` is the MemeToken-style privileged pull (from `msg.sender`'s caller).
contract FeeToken is ERC20 {
    constructor() ERC20("FEE", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function launchpadPull(address from, uint256 amount) external {
        _transfer(from, msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0)) super._update(from, address(0), value / 100);
    }
}

/// @notice Launchpad with the canonical ABI over a FeeToken meme: BUY mints `amountIn` of the
///         token (no fee on mint), SELL pulls `amount` from `msg.sender` (fee charged on top).
contract FeeLaunchpad is ILaunchpad {
    address public immutable quoteToken;

    constructor(address quote) {
        quoteToken = quote;
    }

    function buy(address token, uint256 amountIn, uint256, uint256, address recipient)
        external
        returns (uint256)
    {
        require(IERC20(quoteToken).transferFrom(msg.sender, address(this), amountIn));
        FeeToken(token).mint(recipient, amountIn);
        return amountIn;
    }

    function sell(address token, uint256 amount, uint256, uint256, address recipient)
        external
        returns (uint256)
    {
        FeeToken(token).launchpadPull(msg.sender, amount);
        require(IERC20(quoteToken).transfer(recipient, amount));
        return amount;
    }
}

/// @notice A session-chosen token whose `balanceOf` reverts.
contract RevertingBalanceToken {
    function balanceOf(address) external pure returns (uint256) {
        revert("balanceOf disabled");
    }
}

/// @notice A session-chosen token whose `balanceOf` reports whatever its owner sets.
contract LyingToken {
    uint256 public reported;

    function setReported(uint256 value) external {
        reported = value;
    }

    function balanceOf(address) external view returns (uint256) {
        return reported;
    }
}

/// @notice An allowlisted target moving MockUSD both ways inside one call: it pulls `out` from
///         `from` (standing allowance) and pays `back` to it from its own balance.
contract Swapper {
    function swap(IERC20 token, address from, uint256 out, uint256 back) external {
        if (out != 0) require(token.transferFrom(from, address(this), out));
        if (back != 0) require(token.transfer(from, back));
    }
}
