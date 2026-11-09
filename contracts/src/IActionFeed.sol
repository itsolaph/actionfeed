// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IActionFeed
/// @notice Onchain corporate-action history and guards for B20 asset tokens (ERC-8056 UI multiplier).
/// @dev Independent community infrastructure. Not affiliated with or endorsed by Coinbase or Base.
interface IActionFeed {
    /// @notice One recorded multiplier change. Packed in a single storage slot.
    struct Entry {
        uint64 timestamp; // time the multiplier took effect (or the time it was first observed)
        uint192 multiplier; // WAD-scaled (1e18 = 1.0); B20 caps it at uint128
    }

    /// @notice Live snapshot of a token's corporate-action state.
    struct Status {
        uint8 decimals;
        uint256 rawSupply;
        uint256 uiMultiplier; // effective multiplier right now
        uint256 newUIMultiplier; // pending target (equals uiMultiplier when nothing is pending)
        uint256 effectiveAt; // 0 when nothing is scheduled
        bool pendingLive; // effectiveAt > block.timestamp
        bool transferPaused;
        uint256 lastRecordedMultiplier; // 0 when never checkpointed
        uint256 historyLength;
        bool checkpointNeeded; // uiMultiplier differs from lastRecordedMultiplier
    }

    /// @notice Reference-feed freshness (e.g. a Chainlink AggregatorV3 feed supplied by the caller).
    struct FeedStatus {
        address feed;
        bool ok; // feed call succeeded and returned a positive answer
        bool stale; // !ok or updatedAt older than maxStaleness
        uint8 feedDecimals;
        int256 answer;
        uint256 updatedAt;
    }

    event Checkpoint(
        address indexed token, uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt, uint256 blockTime
    );

    error PendingActionWithin(address token, uint256 effectiveAt, uint256 window);
    error TransfersPaused(address token);
    error HistoryUnknown(address token, uint256 timestamp);
    error ZeroMultiplier(address token);

    function status(address token) external view returns (Status memory);
    function statusWithFeed(address token, address feed, uint256 maxStaleness)
        external
        view
        returns (Status memory s, FeedStatus memory f);

    /// @notice Record the token's current effective multiplier if it differs from the last record.
    /// @return recorded true if a new entry was appended (or the same-block entry was replaced)
    function checkpoint(address token) external returns (bool recorded);
    function checkpointMany(address[] calldata tokens) external returns (uint256 recordedCount);

    /// @notice Multiplier in force at `timestamp` according to recorded history.
    /// @return multiplier 0 when unknown
    /// @return known false when `timestamp` precedes the first checkpoint (or history is empty)
    function multiplierAt(address token, uint256 timestamp) external view returns (uint256 multiplier, bool known);
    function historyLength(address token) external view returns (uint256);
    function historyEntry(address token, uint256 index) external view returns (Entry memory);

    /// @dev raw * multiplier / 1e18, rounded down, at the live multiplier
    function toShares(address token, uint256 raw) external view returns (uint256);
    /// @dev shares * 1e18 / multiplier, rounded down, at the live multiplier
    function toRaw(address token, uint256 shares) external view returns (uint256);
    /// @dev same as toRaw but rounded up
    function toRawUp(address token, uint256 shares) external view returns (uint256);
    /// @dev historical variants; revert HistoryUnknown if the time precedes recorded history
    function toSharesAt(address token, uint256 raw, uint256 timestamp) external view returns (uint256);
    function toRawAt(address token, uint256 shares, uint256 timestamp) external view returns (uint256);

    /// @notice Reverts if an update goes live within `window` seconds, or transfers are paused.
    function assertStable(address token, uint256 window) external view;
}
