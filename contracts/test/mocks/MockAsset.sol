// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal stand-in for a B20 asset mirroring the multiplier semantics of base-std's MockB20Asset
///      (lazy maturation, live-pending blocks new schedule, instant override clears pending).
contract MockAsset {
    uint8 public decimals = 8;
    uint256 public totalSupply = 1_000_000e8;
    bool public transferPaused;

    uint256 private _mult; // 0 => 1e18
    uint128 private _pendingMult;
    uint64 private _pendingAt;

    error UIMultiplierUpdateExists(uint256 effectiveAt);
    error UIMultiplierUpdateDoesNotExist();
    error EffectiveAtInPast(uint256 effectiveAt);

    function isPaused(uint8 feature) external view returns (bool) {
        return feature == 0 && transferPaused;
    }

    function setPaused(bool p) external {
        transferPaused = p;
    }

    function _current() internal view returns (uint256) {
        return _mult == 0 ? 1e18 : _mult;
    }

    function uiMultiplier() public view returns (uint256) {
        if (_pendingAt != 0 && block.timestamp >= _pendingAt) return _pendingMult;
        return _current();
    }

    function newUIMultiplier() external view returns (uint256) {
        if (_pendingAt > block.timestamp) return _pendingMult;
        return uiMultiplier();
    }

    function effectiveAt() external view returns (uint256) {
        return _pendingAt;
    }

    function updateUIMultiplier(uint256 m, uint256 at) external {
        if (at <= block.timestamp) revert EffectiveAtInPast(at);
        if (_pendingAt > block.timestamp) revert UIMultiplierUpdateExists(_pendingAt);
        if (_pendingAt != 0) _mult = _pendingMult;
        _pendingMult = uint128(m);
        _pendingAt = uint64(at);
    }

    function cancelUIMultiplierUpdate() external {
        if (_pendingAt <= block.timestamp) revert UIMultiplierUpdateDoesNotExist();
        _pendingMult = 0;
        _pendingAt = 0;
    }

    function updateMultiplier(uint256 m) external {
        _mult = m;
        _pendingMult = 0;
        _pendingAt = 0;
    }
}

contract MockFeed {
    int256 public answer = 100e8;
    uint256 public updatedAt;
    bool public broken;

    constructor() {
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "broken");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
