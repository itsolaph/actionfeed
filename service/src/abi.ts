import { parseAbi, parseAbiItem } from "viem";

// Signatures taken from base-std (src/interfaces/IERC8056.sol, IB20Asset.sol, IB20.sol, IB20Factory.sol).
export const EV = {
  UIMultiplierUpdated: parseAbiItem(
    "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  ),
  UIMultiplierUpdateCancelled: parseAbiItem(
    "event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt)",
  ),
  Announcement: parseAbiItem("event Announcement(address indexed caller, string id, string description, string uri)"),
  Paused: parseAbiItem("event Paused(address indexed updater, uint8[] features)"),
  Unpaused: parseAbiItem("event Unpaused(address indexed updater, uint8[] features)"),
  PolicyUpdated: parseAbiItem("event PolicyUpdated(bytes32 indexed policyScope, uint64 oldPolicyId, uint64 newPolicyId)"),
} as const;

export const ALL_EVENTS = Object.values(EV);
export const FEATURES = ["TRANSFER", "MINT", "BURN", "SEIZE"] as const;

export const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function isPaused(uint8 feature) view returns (bool)",
]);

export const actionFeedAbi = parseAbi([
  "function checkpointMany(address[] tokens) returns (uint256)",
  "function checkpoint(address token) returns (bool)",
  "function multiplierAt(address token, uint256 timestamp) view returns (uint256 multiplier, bool known)",
]);
