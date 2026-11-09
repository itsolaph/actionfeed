// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ActionFeed} from "../src/ActionFeed.sol";

/// @notice Deterministic (CREATE2) deployment of the ActionFeed singleton.
/// @dev Uses the canonical CREATE2 deployer (0x4e59...956C) that forge routes `new X{salt:..}` through.
///      The address depends only on SALT and the creation bytecode, so it is identical on every chain
///      where that deployer exists. This script never reads a private key itself: pass an account with
///      forge's own flags if (and only if) you intend to broadcast. Default invocation is a dry run:
///
///        forge script script/Deploy.s.sol --fork-url <rpc>        # simulation only
contract Deploy is Script {
    bytes32 constant SALT = keccak256("actionfeed.v1");

    function predicted() public pure returns (address) {
        return vm.computeCreate2Address(
            SALT, keccak256(type(ActionFeed).creationCode), 0x4e59b44847b379578588920cA78FbF26c0B4956C
        );
    }

    function run() external returns (ActionFeed feed) {
        address expected = predicted();
        console2.log("chainid", block.chainid);
        console2.log("expected ActionFeed", expected);
        vm.startBroadcast();
        feed = new ActionFeed{salt: SALT}();
        vm.stopBroadcast();
        require(address(feed) == expected, "address mismatch");
    }
}
