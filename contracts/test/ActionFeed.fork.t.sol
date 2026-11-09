// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ActionFeed} from "../src/ActionFeed.sol";
import {IActionFeed} from "../src/IActionFeed.sol";

/// @dev Base mainnet fork test against the real NVDAc token. Skipped unless BASE_RPC_URL is set.
///      B20 tokens are native precompiles; a stock `forge` EVM cannot execute them, so the test also skips
///      itself when the token does not answer (see PROGRESS.md for what was observed).
contract ActionFeedForkTest is Test {
    address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;

    function test_fork_NVDAc() public {
        // Either run with `forge test --fork-url <rpc>` (chainid 8453) or set BASE_RPC_URL.
        if (block.chainid != 8453) {
            string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
            if (bytes(rpc).length == 0) {
                vm.skip(true, "no fork: set BASE_RPC_URL or pass --fork-url");
                return;
            }
            vm.createSelectFork(rpc);
        }
        (bool ok, bytes memory ret) = NVDAC.staticcall(abi.encodeWithSignature("uiMultiplier()"));
        if (!ok || ret.length != 32) {
            vm.skip(true, "B20 precompile not executable in this forge build");
            return;
        }
        ActionFeed feed = new ActionFeed();
        IActionFeed.Status memory s = feed.status(NVDAC);
        assertEq(s.decimals, 8);
        assertGt(s.uiMultiplier, 0);
        assertTrue(feed.checkpoint(NVDAC));
        (uint256 m, bool known) = feed.multiplierAt(NVDAC, block.timestamp);
        assertTrue(known);
        assertEq(m, s.uiMultiplier);
        assertFalse(feed.checkpoint(NVDAC));
    }
}
