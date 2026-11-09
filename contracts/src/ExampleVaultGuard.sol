// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ActionFeedLib} from "./ActionFeedLib.sol";

/// @title ExampleVaultGuard
/// @notice Example consumer of ActionFeedLib. Not audited; holds no funds; illustration only.
///         A vault/AMM refuses to accept deposits or swaps for a B20 asset when a corporate action is about to
///         take effect (so share/price maths cannot straddle a split) or when transfers are paused.
contract ExampleVaultGuard {
    using ActionFeedLib for address;

    address public immutable asset;
    uint256 public immutable guardWindow;

    uint256 public deposits; // placeholder accounting so the example has state

    constructor(address asset_, uint256 guardWindow_) {
        asset = asset_;
        guardWindow = guardWindow_;
    }

    function deposit(uint256 raw) external {
        asset.requireNoPendingAction(guardWindow);
        deposits += raw; // a real vault would pull tokens here
    }

    function depositsAsShares() external view returns (uint256) {
        return asset.toShares(deposits);
    }

    function canDeposit() external view returns (bool) {
        return asset.isStable(guardWindow);
    }
}
