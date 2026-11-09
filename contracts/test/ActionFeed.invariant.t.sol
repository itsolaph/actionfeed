// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ActionFeed} from "../src/ActionFeed.sol";
import {MockAsset} from "./mocks/MockAsset.sol";

contract Handler is Test {
    ActionFeed public feed;
    MockAsset public token;
    uint256 public lastWarp;

    constructor(ActionFeed f, MockAsset t) {
        feed = f;
        token = t;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }

    function instant(uint256 m) external {
        token.updateMultiplier(bound(m, 1, type(uint128).max));
    }

    function schedule(uint256 m, uint256 dt) external {
        try token.updateUIMultiplier(bound(m, 1, type(uint128).max), block.timestamp + bound(dt, 1, 5 days)) {} catch {}
    }

    function cancel() external {
        try token.cancelUIMultiplierUpdate() {} catch {}
    }

    function checkpoint() external {
        feed.checkpoint(address(token));
    }
}

contract ActionFeedInvariantTest is Test {
    ActionFeed feed;
    MockAsset token;
    Handler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new ActionFeed();
        token = new MockAsset();
        handler = new Handler(feed, token);
        targetContract(address(handler));
    }

    /// history timestamps strictly increase, multipliers are non-zero and never equal to their predecessor
    function invariant_historyStrictlyIncreasing() public view {
        uint256 n = feed.historyLength(address(token));
        for (uint256 i = 1; i < n; ++i) {
            assertGt(feed.historyEntry(address(token), i).timestamp, feed.historyEntry(address(token), i - 1).timestamp);
            assertTrue(
                feed.historyEntry(address(token), i).multiplier != feed.historyEntry(address(token), i - 1).multiplier
            );
        }
        for (uint256 i; i < n; ++i) {
            assertGt(feed.historyEntry(address(token), i).multiplier, 0);
        }
    }
}
