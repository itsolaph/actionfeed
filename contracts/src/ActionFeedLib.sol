// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IScaledUIAmount, IScaledUIAmountNewUIMultiplier} from "base-std/interfaces/IERC8056.sol";

/// @title ActionFeedLib
/// @notice Internal helpers for integrators (AMMs, vaults, keepers). Reads the token directly; no ActionFeed
///         deployment is needed for the guards. Inline it with `using ActionFeedLib for address`.
library ActionFeedLib {
    error PendingActionWithin(address token, uint256 effectiveAt, uint256 window);
    error TransfersPaused(address token);

    /// @notice Revert if a live pending multiplier update takes effect within `window` seconds,
    ///         or if transfers are paused on `token`.
    function requireNoPendingAction(address token, uint256 window) internal view {
        if (IB20(token).isPaused(IB20.PausableFeature.TRANSFER)) revert TransfersPaused(token);
        uint256 eff = IScaledUIAmountNewUIMultiplier(token).effectiveAt();
        // eff <= block.timestamp means nothing pending (0) or already matured (the live multiplier is final).
        if (eff > block.timestamp && eff <= block.timestamp + window) {
            revert PendingActionWithin(token, eff, window);
        }
    }

    /// @notice Non-reverting variant.
    function isStable(address token, uint256 window) internal view returns (bool) {
        if (IB20(token).isPaused(IB20.PausableFeature.TRANSFER)) return false;
        uint256 eff = IScaledUIAmountNewUIMultiplier(token).effectiveAt();
        return !(eff > block.timestamp && eff <= block.timestamp + window);
    }

    /// @notice Raw -> scaled amount at the live multiplier, rounded down.
    function toShares(address token, uint256 raw) internal view returns (uint256) {
        return raw * IScaledUIAmount(token).uiMultiplier() / 1e18;
    }

    /// @notice Scaled -> raw amount at the live multiplier, rounded down.
    function toRaw(address token, uint256 shares) internal view returns (uint256) {
        uint256 m = IScaledUIAmount(token).uiMultiplier();
        return shares * 1e18 / m;
    }
}
