# Integrating

Multipliers are WAD-scaled (`1e18 = 1.0`). Balances are raw; UI amount = `raw * multiplier / 1e18` (rounded down).

## 1. Guard against pending actions (no deployment needed)
```solidity
import {ActionFeedLib} from "actionfeed/ActionFeedLib.sol";
contract Pool {
    using ActionFeedLib for address;
    function swap(address token) external {
        token.requireNoPendingAction(1 hours); // reverts if an update goes live within 1h, or transfers are paused
    }
}
```
See `contracts/src/ExampleVaultGuard.sol`. A scheduled update does not change the live multiplier until `effectiveAt`; the guard is about avoiding straddling that moment.

## 2. Historical multiplier onchain (needs an ActionFeed deployment)
```solidity
(uint256 m, bool known) = IActionFeed(ACTIONFEED).multiplierAt(token, ts);
require(known, "history starts later");
```
Anyone can call `checkpoint(token)` / `checkpointMany`; if you depend on fresh history, call it in your own flow or run the keeper. Check `status(token).checkpointNeeded`.
Deployed addresses: Base mainnet: [`0xC455472cd39029F8309F0D762Ee587D65A596Fe2`](https://basescan.org/address/0xC455472cd39029F8309F0D762Ee587D65A596Fe2)

## 3. Off-chain
```bash
curl $HOST/v1/actions/upcoming
curl "$HOST/v1/tokens/0xb20000000000000000000078ee7ce2fE4908108C/multiplier?at=1767225600"
```
```ts
import { ActionFeedClient, multiplierAt } from "@actionfeed/sdk";
```

## Webhooks
`POST /v1/subscriptions {url, tokens?, events?, leads?}` returns `{id, secret}` once. Each delivery carries `X-ActionFeed-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`. Reject if `|now - t| > 300s`. Use `verifySignature` from the SDK. Deliveries retry with backoff (up to 6 attempts); the log is at `GET /v1/subscriptions/:id/deliveries` (Bearer secret). Production mode accepts https only and blocks private/loopback/link-local targets.

## Builder Codes
The keeper appends an ERC-8021 Schema 0 suffix built from `BUILDER_CODE` to each `checkpointMany` call.
