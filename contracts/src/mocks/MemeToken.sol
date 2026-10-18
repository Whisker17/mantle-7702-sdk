// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Meme token deployed only by `MockLaunchpad`. Standard balances: no fee, rebase or
/// callback. The launchpad that deployed it is the only caller of its two privileged entries.
contract MemeToken is ERC20 {
    error NotLaunchpad();

    /// @notice The launchpad that deployed this token (DESIGN §4.4 clause 3).
    address public immutable launchpad;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        launchpad = msg.sender;
    }

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _;
    }

    /// @notice Mints a purchase to its recipient.
    function mint(address to, uint256 amount) external onlyLaunchpad {
        _mint(to, amount);
    }

    /// @notice Privileged transfer of exactly `amount` from `from` to the launchpad, without an
    /// allowance. The launchpad only ever passes its own `msg.sender` as `from`; a short balance
    /// reverts, so there is never a partial transfer.
    function launchpadTransfer(address from, uint256 amount) external onlyLaunchpad {
        _transfer(from, launchpad, amount);
    }
}
