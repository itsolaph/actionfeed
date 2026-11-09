// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IScaledUIAmount, IScaledUIAmountNewUIMultiplier} from "base-std/interfaces/IERC8056.sol";
import {IActionFeed} from "./IActionFeed.sol";
import {ActionFeedLib} from "./ActionFeedLib.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ActionFeed
/// @notice Immutable, ownerless singleton that records the ERC-8056 UI-multiplier history of B20 asset tokens
///         onchain so that `multiplierAt(token, t)` is answerable by any contract. Holds no funds, has no admin.
/// @dev Trust model: each token's history is derived only from that token's own responses, so a hostile token can
///      only pollute its own history. Anyone can call `checkpoint`; it is idempotent.
///      History is only as fresh as the last checkpoint: a matured update that nobody has checkpointed yet is
///      visible in `status().checkpointNeeded`, not in `multiplierAt`. If the multiplier changes twice between two
///      checkpoints, the intermediate value is unrecoverable onchain (use the indexer/event log for that).
///      Independent community infrastructure; not affiliated with Coinbase or Base.
contract ActionFeed is IActionFeed {
    mapping(address token => Entry[]) private _history;

    // ───────────────────────────── reads ─────────────────────────────

    function status(address token) public view returns (Status memory s) {
        s.decimals = IB20(token).decimals();
        s.rawSupply = IB20(token).totalSupply();
        s.uiMultiplier = IScaledUIAmount(token).uiMultiplier();
        s.newUIMultiplier = IScaledUIAmountNewUIMultiplier(token).newUIMultiplier();
        s.effectiveAt = IScaledUIAmountNewUIMultiplier(token).effectiveAt();
        s.pendingLive = s.effectiveAt > block.timestamp;
        s.transferPaused = IB20(token).isPaused(IB20.PausableFeature.TRANSFER);
        Entry[] storage h = _history[token];
        s.historyLength = h.length;
        if (s.historyLength != 0) s.lastRecordedMultiplier = h[s.historyLength - 1].multiplier;
        s.checkpointNeeded = s.lastRecordedMultiplier != s.uiMultiplier;
    }

    /// @notice `status` plus freshness of a caller-supplied reference feed (no registry: nothing to spoof).
    function statusWithFeed(address token, address feed, uint256 maxStaleness)
        external
        view
        returns (Status memory s, FeedStatus memory f)
    {
        s = status(token);
        f.feed = feed;
        if (feed.code.length == 0) {
            f.stale = true;
            return (s, f);
        }
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            f.answer = answer;
            f.updatedAt = updatedAt;
            f.ok = answer > 0 && updatedAt != 0;
            f.stale = !f.ok || block.timestamp > updatedAt + maxStaleness;
        } catch {
            f.stale = true;
        }
        try IAggregatorV3(feed).decimals() returns (uint8 d) {
            f.feedDecimals = d;
        } catch {}
    }

    function multiplierAt(address token, uint256 timestamp) public view returns (uint256 multiplier, bool known) {
        Entry[] storage h = _history[token];
        uint256 n = h.length;
        if (n == 0 || timestamp < h[0].timestamp) return (0, false);
        // Find the last index with h[i].timestamp <= timestamp. Invariant: h[lo].timestamp <= timestamp.
        uint256 lo = 0;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (h[mid].timestamp <= timestamp) lo = mid;
            else hi = mid - 1;
        }
        return (h[lo].multiplier, true);
    }

    function historyLength(address token) external view returns (uint256) {
        return _history[token].length;
    }

    function historyEntry(address token, uint256 index) external view returns (Entry memory) {
        return _history[token][index];
    }

    // ───────────────────────────── conversions ─────────────────────────────

    function toShares(address token, uint256 raw) external view returns (uint256) {
        return raw * _live(token) / 1e18;
    }

    function toRaw(address token, uint256 shares) external view returns (uint256) {
        return shares * 1e18 / _live(token);
    }

    function toRawUp(address token, uint256 shares) external view returns (uint256) {
        uint256 m = _live(token);
        return (shares * 1e18 + m - 1) / m;
    }

    function toSharesAt(address token, uint256 raw, uint256 timestamp) external view returns (uint256) {
        return raw * _at(token, timestamp) / 1e18;
    }

    function toRawAt(address token, uint256 shares, uint256 timestamp) external view returns (uint256) {
        return shares * 1e18 / _at(token, timestamp);
    }

    function assertStable(address token, uint256 window) external view {
        ActionFeedLib.requireNoPendingAction(token, window);
    }

    // ───────────────────────────── writes ─────────────────────────────

    function checkpoint(address token) public returns (bool) {
        uint256 current = IScaledUIAmount(token).uiMultiplier();
        if (current == 0 || current > type(uint192).max) revert ZeroMultiplier(token);

        Entry[] storage h = _history[token];
        uint256 n = h.length;
        uint256 old = n == 0 ? 0 : h[n - 1].multiplier;
        if (old == current) return false;

        uint256 eff = IScaledUIAmountNewUIMultiplier(token).effectiveAt();
        uint256 lastTs = n == 0 ? 0 : h[n - 1].timestamp;
        // A matured scheduled update is dated by its effectiveAt. Instant overrides (effectiveAt == 0, or an
        // unrelated future schedule) are dated by now. Never go backwards relative to the last entry.
        uint256 ts = (eff != 0 && eff <= block.timestamp && eff > lastTs) ? eff : block.timestamp;

        if (n != 0 && ts <= lastTs) {
            // same-block re-checkpoint: replace instead of appending, keeps timestamps strictly increasing
            h[n - 1].multiplier = uint192(current);
        } else {
            h.push(Entry({timestamp: uint64(ts), multiplier: uint192(current)}));
        }
        emit Checkpoint(token, old, current, ts, block.timestamp);
        return true;
    }

    function checkpointMany(address[] calldata tokens) external returns (uint256 count) {
        for (uint256 i; i < tokens.length; ++i) {
            if (checkpoint(tokens[i])) ++count;
        }
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _live(address token) private view returns (uint256 m) {
        m = IScaledUIAmount(token).uiMultiplier();
        if (m == 0) revert ZeroMultiplier(token);
    }

    function _at(address token, uint256 timestamp) private view returns (uint256) {
        (uint256 m, bool known) = multiplierAt(token, timestamp);
        if (!known) revert HistoryUnknown(token, timestamp);
        return m;
    }
}
