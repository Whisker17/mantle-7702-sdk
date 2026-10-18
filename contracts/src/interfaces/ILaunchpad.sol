// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice The launchpad ABI the policy hook decodes (fixed, see the design's trusted-launchpad
///         interface contract). Proceeds always go to `recipient`; SELL fills `amount` in full or
///         reverts; `quoteToken()` is immutable.
interface ILaunchpad {
    function quoteToken() external view returns (address);

    function buy(
        address token,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external returns (uint256 amountOut);

    function sell(
        address token,
        uint256 amount,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external returns (uint256 amountOut);
}
