// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test quote asset: a standard ERC20 (no fee, rebase or callback) that anyone can mint.
contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints new supply to `to`. It only creates tokens; it never moves anyone's balance.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
