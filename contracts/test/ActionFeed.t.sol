// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ActionFeed} from "../src/ActionFeed.sol";
import {IActionFeed} from "../src/IActionFeed.sol";
import {ActionFeedLib} from "../src/ActionFeedLib.sol";
import {ExampleVaultGuard} from "../src/ExampleVaultGuard.sol";
import {MockAsset, MockFeed} from "./mocks/MockAsset.sol";

contract ActionFeedTest is Test {
    ActionFeed feed;
    MockAsset token;
    uint256 constant WAD = 1e18;
    uint256 constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        feed = new ActionFeed();
        token = new MockAsset();
    }

    // ── empty / baseline ──
    function test_emptyHistory() public view {
        (uint256 m, bool known) = feed.multiplierAt(address(token), T0);
        assertEq(m, 0);
        assertFalse(known);
        assertEq(feed.historyLength(address(token)), 0);
    }

    function test_firstCheckpointRecordsBaseline() public {
        assertTrue(feed.checkpoint(address(token)));
        assertEq(feed.historyLength(address(token)), 1);
        (uint256 m, bool known) = feed.multiplierAt(address(token), T0);
        assertEq(m, WAD);
        assertTrue(known);
        (, known) = feed.multiplierAt(address(token), T0 - 1);
        assertFalse(known, "before first checkpoint is unknown");
    }

    function test_checkpointIdempotent() public {
        assertTrue(feed.checkpoint(address(token)));
        assertFalse(feed.checkpoint(address(token)));
        assertEq(feed.historyLength(address(token)), 1);
    }

    // ── scheduled update ──
    function test_scheduledUpdate_maturesWithoutEvent() public {
        feed.checkpoint(address(token));
        token.updateUIMultiplier(2 * WAD, T0 + 1 days);

        IActionFeed.Status memory s = feed.status(address(token));
        assertTrue(s.pendingLive);
        assertEq(s.uiMultiplier, WAD);
        assertEq(s.newUIMultiplier, 2 * WAD);
        assertEq(s.effectiveAt, T0 + 1 days);
        assertFalse(s.checkpointNeeded);
        assertFalse(feed.checkpoint(address(token)), "still pending: nothing to record");

        // matures lazily, no tx touches the token
        vm.warp(T0 + 3 days);
        s = feed.status(address(token));
        assertFalse(s.pendingLive);
        assertEq(s.uiMultiplier, 2 * WAD);
        assertTrue(s.checkpointNeeded);

        assertTrue(feed.checkpoint(address(token)));
        // dated by effectiveAt, not by checkpoint time
        IActionFeed.Entry memory e = feed.historyEntry(address(token), 1);
        assertEq(e.timestamp, T0 + 1 days);
        assertEq(e.multiplier, 2 * WAD);

        (uint256 m,) = feed.multiplierAt(address(token), T0 + 1 days - 1);
        assertEq(m, WAD);
        (m,) = feed.multiplierAt(address(token), T0 + 1 days);
        assertEq(m, 2 * WAD);
    }

    function test_checkpointEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit IActionFeed.Checkpoint(address(token), 0, WAD, T0, T0);
        feed.checkpoint(address(token));
    }

    // ── cancel ──
    function test_cancel() public {
        feed.checkpoint(address(token));
        token.updateUIMultiplier(2 * WAD, T0 + 1 days);
        token.cancelUIMultiplierUpdate();
        vm.warp(T0 + 2 days);
        assertFalse(feed.checkpoint(address(token)));
        (uint256 m,) = feed.multiplierAt(address(token), T0 + 2 days);
        assertEq(m, WAD);
        assertFalse(feed.status(address(token)).pendingLive);
    }

    // ── instant override ──
    function test_instantOverrideClearsPending() public {
        feed.checkpoint(address(token));
        token.updateUIMultiplier(2 * WAD, T0 + 1 days);
        vm.warp(T0 + 100);
        token.updateMultiplier(3 * WAD);
        assertTrue(feed.checkpoint(address(token)));
        IActionFeed.Entry memory e = feed.historyEntry(address(token), 1);
        assertEq(e.timestamp, T0 + 100, "dated by now: effectiveAt was cleared");
        assertEq(e.multiplier, 3 * WAD);
        vm.warp(T0 + 2 days);
        assertFalse(feed.checkpoint(address(token)), "cancelled schedule never takes effect");
    }

    // ── second schedule ──
    function test_secondScheduleReverts_whileLive() public {
        token.updateUIMultiplier(2 * WAD, T0 + 1 days);
        vm.expectRevert(abi.encodeWithSelector(MockAsset.UIMultiplierUpdateExists.selector, T0 + 1 days));
        token.updateUIMultiplier(3 * WAD, T0 + 2 days);
    }

    function test_secondScheduleAfterMaturity_foldsFirst() public {
        feed.checkpoint(address(token));
        token.updateUIMultiplier(2 * WAD, T0 + 1 days);
        vm.warp(T0 + 2 days);
        // the matured update is folded; the second one becomes pending
        token.updateUIMultiplier(4 * WAD, T0 + 5 days);
        assertEq(feed.status(address(token)).uiMultiplier, 2 * WAD);
        assertTrue(feed.checkpoint(address(token)));
        IActionFeed.Entry memory e = feed.historyEntry(address(token), 1);
        // effectiveAt() now refers to the *new* pending (future), so the fold is dated by now
        assertEq(e.timestamp, T0 + 2 days);
        assertEq(e.multiplier, 2 * WAD);
    }

    // ── splits ──
    function test_split2to1_forward() public {
        feed.checkpoint(address(token));
        token.updateUIMultiplier(2 * WAD, T0 + 1 days);
        vm.warp(T0 + 1 days);
        feed.checkpoint(address(token));
        // 100 raw units (8 decimals) => 200 displayed
        assertEq(feed.toShares(address(token), 100e8), 200e8);
        assertEq(feed.toRaw(address(token), 200e8), 100e8);
        assertEq(feed.toSharesAt(address(token), 100e8, T0), 100e8);
        assertEq(feed.toRawAt(address(token), 100e8, T0 + 1 days), 50e8);
    }

    function test_reverseSplit_1to10() public {
        feed.checkpoint(address(token));
        token.updateUIMultiplier(WAD / 10, T0 + 1 days);
        vm.warp(T0 + 1 days);
        feed.checkpoint(address(token));
        assertEq(feed.toShares(address(token), 100e8), 10e8);
        assertEq(feed.toRaw(address(token), 10e8), 100e8);
        (uint256 m,) = feed.multiplierAt(address(token), T0 + 10 days);
        assertEq(m, WAD / 10);
    }

    function test_rounding() public {
        token.updateMultiplier(1_000_537_939_576_369_481); // NVDAc-like dividend multiplier
        feed.checkpoint(address(token));
        uint256 raw = 3; // 3 base units
        uint256 shares = feed.toShares(address(token), raw);
        assertEq(shares, 3, "rounds down");
        // round-trip is lossy by design: toRaw floors, toRawUp ceils
        uint256 down = feed.toRaw(address(token), 1);
        uint256 up = feed.toRawUp(address(token), 1);
        assertEq(down, 0);
        assertEq(up, 1);
    }

    function test_toSharesAt_revertsBeforeHistory() public {
        feed.checkpoint(address(token));
        vm.expectRevert(abi.encodeWithSelector(IActionFeed.HistoryUnknown.selector, address(token), T0 - 1));
        feed.toSharesAt(address(token), 1, T0 - 1);
    }

    // ── same block ──
    function test_sameBlockReCheckpointReplaces() public {
        token.updateMultiplier(2 * WAD);
        feed.checkpoint(address(token));
        token.updateMultiplier(3 * WAD);
        assertTrue(feed.checkpoint(address(token)));
        assertEq(feed.historyLength(address(token)), 1);
        (uint256 m,) = feed.multiplierAt(address(token), T0);
        assertEq(m, 3 * WAD);
    }

    // ── binary search edges ──
    function test_binarySearchEdges() public {
        uint256 n = 20;
        for (uint256 i; i < n; ++i) {
            token.updateMultiplier((i + 1) * WAD);
            feed.checkpoint(address(token));
            vm.warp(block.timestamp + 10);
        }
        assertEq(feed.historyLength(address(token)), n);
        for (uint256 i; i < n; ++i) {
            uint256 ts = T0 + i * 10;
            (uint256 m, bool k) = feed.multiplierAt(address(token), ts);
            assertTrue(k);
            assertEq(m, (i + 1) * WAD, "exact");
            (m, k) = feed.multiplierAt(address(token), ts + 9);
            assertEq(m, (i + 1) * WAD, "just before next");
        }
        (uint256 last,) = feed.multiplierAt(address(token), type(uint64).max);
        assertEq(last, n * WAD);
        (, bool known) = feed.multiplierAt(address(token), 0);
        assertFalse(known);
    }

    function test_checkpointMany() public {
        MockAsset b = new MockAsset();
        b.updateMultiplier(5 * WAD);
        address[] memory ts = new address[](2);
        ts[0] = address(token);
        ts[1] = address(b);
        assertEq(feed.checkpointMany(ts), 2);
        assertEq(feed.checkpointMany(ts), 0);
    }

    function test_zeroMultiplierReverts() public {
        token.updateMultiplier(0); // mock treats stored 0 as 1e18, so simulate a hostile token
        vm.mockCall(address(token), abi.encodeWithSignature("uiMultiplier()"), abi.encode(uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(IActionFeed.ZeroMultiplier.selector, address(token)));
        feed.checkpoint(address(token));
    }

    // ── guards ──
    function test_assertStable() public {
        feed.assertStable(address(token), 1 hours); // nothing pending
        token.updateUIMultiplier(2 * WAD, T0 + 30 minutes);
        vm.expectRevert(
            abi.encodeWithSelector(ActionFeedLib.PendingActionWithin.selector, address(token), T0 + 30 minutes, 1 hours)
        );
        feed.assertStable(address(token), 1 hours);
        feed.assertStable(address(token), 10 minutes); // outside window
        // boundary: exactly at window edge is unstable
        vm.expectRevert();
        feed.assertStable(address(token), 30 minutes);
        // after maturity the guard passes (the new multiplier is final)
        vm.warp(T0 + 31 minutes);
        feed.assertStable(address(token), 1 hours);
    }

    function test_assertStable_paused() public {
        token.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(ActionFeedLib.TransfersPaused.selector, address(token)));
        feed.assertStable(address(token), 0);
        assertTrue(feed.status(address(token)).transferPaused);
    }

    function test_exampleVaultGuard() public {
        ExampleVaultGuard g = new ExampleVaultGuard(address(token), 1 hours);
        assertTrue(g.canDeposit());
        g.deposit(10e8);
        token.updateUIMultiplier(2 * WAD, T0 + 10 minutes);
        assertFalse(g.canDeposit());
        vm.expectRevert();
        g.deposit(1);
        vm.warp(T0 + 11 minutes);
        assertTrue(g.canDeposit());
        assertEq(g.depositsAsShares(), 20e8);
    }

    // ── feed freshness ──
    function test_statusWithFeed() public {
        MockFeed f = new MockFeed();
        (, IActionFeed.FeedStatus memory fs) = feed.statusWithFeed(address(token), address(f), 1 hours);
        assertTrue(fs.ok);
        assertFalse(fs.stale);
        assertEq(fs.answer, 100e8);
        assertEq(fs.feedDecimals, 8);
        vm.warp(T0 + 2 hours);
        (, fs) = feed.statusWithFeed(address(token), address(f), 1 hours);
        assertTrue(fs.stale);
        f.setBroken(true);
        (, fs) = feed.statusWithFeed(address(token), address(f), 1 hours);
        assertFalse(fs.ok);
        assertTrue(fs.stale);
        // non-contract feed address must not revert
        (, fs) = feed.statusWithFeed(address(token), address(0xdead), 1 hours);
        assertTrue(fs.stale);
    }

    // ── fuzz ──
    function testFuzz_multiplierAtMatchesLinearScan(uint8 count, uint256 seed, uint256 query) public {
        uint256 n = bound(count, 1, 40);
        uint256[] memory ts = new uint256[](n);
        uint256[] memory ms = new uint256[](n);
        uint256 s = seed;
        for (uint256 i; i < n; ++i) {
            s = uint256(keccak256(abi.encode(s)));
            uint256 m = bound(s, 1, type(uint128).max);
            if (i > 0 && m == ms[i - 1]) m += 1;
            token.updateMultiplier(m);
            feed.checkpoint(address(token));
            ts[i] = block.timestamp;
            ms[i] = m;
            vm.warp(block.timestamp + 1 + (s % 1000));
        }
        query = bound(query, 0, block.timestamp + 10_000);
        (uint256 got, bool known) = feed.multiplierAt(address(token), query);
        // reference: linear scan
        bool refKnown;
        uint256 ref;
        for (uint256 i; i < n; ++i) {
            if (ts[i] <= query) {
                ref = ms[i];
                refKnown = true;
            }
        }
        assertEq(known, refKnown);
        assertEq(got, ref);
    }

    function testFuzz_monotonic_inTime(uint8 count, uint256 seed, uint256 a, uint256 b) public {
        uint256 n = bound(count, 2, 30);
        uint256 s = seed;
        for (uint256 i; i < n; ++i) {
            s = uint256(keccak256(abi.encode(s)));
            token.updateMultiplier(bound(s, 1, type(uint128).max));
            feed.checkpoint(address(token));
            vm.warp(block.timestamp + 1 + (s % 100));
        }
        a = bound(a, T0, block.timestamp);
        b = bound(b, a, block.timestamp);
        // known-ness is monotone: once known at a, known at any later time
        (, bool ka) = feed.multiplierAt(address(token), a);
        (, bool kb) = feed.multiplierAt(address(token), b);
        if (ka) assertTrue(kb);
    }

    function testFuzz_roundTripNeverGains(uint128 raw, uint128 mult) public {
        mult = uint128(bound(mult, 1, type(uint128).max));
        raw = uint128(bound(raw, 0, type(uint64).max));
        token.updateMultiplier(mult);
        uint256 shares = feed.toShares(address(token), raw);
        assertLe(feed.toRaw(address(token), shares), raw);
    }

    function test_gasSnapshot_checkpoint() public {
        uint256 g = gasleft();
        feed.checkpoint(address(token)); // first write: cold slots
        uint256 first = g - gasleft();
        token.updateMultiplier(2 * WAD);
        vm.warp(block.timestamp + 1);
        g = gasleft();
        feed.checkpoint(address(token));
        uint256 second = g - gasleft();
        g = gasleft();
        feed.checkpoint(address(token)); // idempotent no-op
        uint256 noop = g - gasleft();
        emit log_named_uint("checkpoint first", first);
        emit log_named_uint("checkpoint append", second);
        emit log_named_uint("checkpoint noop", noop);
        assertLt(second, 100_000);
        assertLt(noop, 50_000);
    }
}
