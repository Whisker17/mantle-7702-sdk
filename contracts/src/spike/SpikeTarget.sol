// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @title SpikeTarget
/// @notice THROWAWAY feasibility-spike call target: a session key's only permitted call. The event
///         is the on-chain evidence that the session batch executed as the account.
contract SpikeTarget {
    event Pinged(address indexed account, uint256 tag);

    function ping(uint256 tag) external {
        emit Pinged(msg.sender, tag);
    }
}
