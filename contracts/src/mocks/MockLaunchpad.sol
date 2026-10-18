// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MemeToken} from "./MemeToken.sol";

/// @notice Fixed-price launchpad and MemeToken factory satisfying DESIGN §4.4: not upgradeable,
/// no owner, no delegatecall, no arbitrary external call. Funds are pulled only from
/// `msg.sender` and proceeds go only to `recipient`.
contract MockLaunchpad {
    using SafeERC20 for IERC20;

    /// @notice Meme base units per quote base unit, for every token: with a 6-decimal quote and
    /// 18-decimal memes, 1 quote unit buys 1000 memes.
    uint256 public constant RATE = 1e15;

    /// @notice The quote asset (DESIGN §4.4 clause 5).
    address public immutable quoteToken;

    /// @notice Tokens this launchpad deployed. `buy` and `sell` accept nothing else.
    mapping(address token => bool) public isRegistered;

    event TokenCreated(address indexed token, string name, string symbol);
    event Bought(
        address indexed buyer,
        address indexed token,
        address recipient,
        uint256 amountIn,
        uint256 amountOut
    );
    event Sold(
        address indexed seller,
        address indexed token,
        address recipient,
        uint256 amount,
        uint256 amountOut
    );

    error UnregisteredToken();
    error Expired();
    error InsufficientOutput();

    constructor(address quoteToken_) {
        quoteToken = quoteToken_;
    }

    /// @notice Deploys and registers a new MemeToken. Anyone may create one.
    function createToken(string calldata name, string calldata symbol)
        external
        returns (address token)
    {
        token = address(new MemeToken(name, symbol));
        isRegistered[token] = true;
        emit TokenCreated(token, name, symbol);
    }

    /// @notice Pulls `amountIn` quote from `msg.sender` and mints only this purchase to
    /// `recipient`.
    function buy(
        address token,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external returns (uint256 amountOut) {
        _check(token, deadline);
        amountOut = amountIn * RATE;
        if (amountOut < minOut) revert InsufficientOutput();
        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), amountIn);
        MemeToken(token).mint(recipient, amountOut);
        emit Bought(msg.sender, token, recipient, amountIn, amountOut);
    }

    /// @notice Takes exactly `amount` of `token` from `msg.sender` (no approve needed) or
    /// reverts, then pays the quote proceeds to `recipient`.
    function sell(
        address token,
        uint256 amount,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external returns (uint256 amountOut) {
        _check(token, deadline);
        amountOut = amount / RATE;
        if (amountOut < minOut) revert InsufficientOutput();
        MemeToken(token).launchpadTransfer(msg.sender, amount);
        IERC20(quoteToken).safeTransfer(recipient, amountOut);
        emit Sold(msg.sender, token, recipient, amount, amountOut);
    }

    function _check(address token, uint256 deadline) private view {
        if (!isRegistered[token]) revert UnregisteredToken();
        // forge-lint: disable-next-line(block-timestamp) -- a deadline is part of the ABI
        if (block.timestamp > deadline) revert Expired();
    }
}
