# Architecture

```
 Coinbase token list ─┐                         ┌─> REST / SSE / dashboard
 Base RPC (getLogs) ──┴─> indexer ─> SQLite ─────┼─> webhooks (HMAC, retries, SSRF-safe)
                          │  canonical history   └─> keeper ──checkpointMany (+ERC-8021 suffix)──> ActionFeed.sol
                          └─ cross-check vs token reads (uiMultiplier / newUIMultiplier / effectiveAt)
```

## Contract (`contracts/src`)
- `ActionFeed` — immutable, ownerless, holds no funds. Per-token append-only array of `(uint64 timestamp, uint192 multiplier)`.
- `checkpoint(token)` reads `uiMultiplier()` (the *effective* value; B20 flips lazily once `effectiveAt` passes, with no event). If it differs from the last record, it appends an entry dated by `effectiveAt()` when that is a matured, newer timestamp, otherwise by `block.timestamp` (instant overrides clear `effectiveAt`). A same-block re-checkpoint replaces the entry, keeping timestamps strictly increasing.
- `multiplierAt` is a binary search; before the first checkpoint it returns `known=false`.
- `ActionFeedLib` — internal guards that read the token directly (no deployment dependency).

Limits: history is as fresh as the last checkpoint; two changes between checkpoints lose the intermediate value onchain (the indexer still has it from events). A token is trusted for its own history only.

## Service (`service/src`)
- `indexer.ts` — token discovery (Coinbase list), chunked `getLogs` with halving + backoff, resume cursor, confirmation depth (default 20 blocks) for reorg safety.
- `history.ts` — the documented replay: apply `UIMultiplierUpdated`, remove entries matching a `UIMultiplierUpdateCancelled(multiplier, effectiveAt)`, date by `effectiveAtTimestamp`.
- `webhooks.ts`, `ssrf.ts`, `signing.ts` — delivery, DNS-rebinding-safe connect (validation happens inside the socket `lookup`), signatures.
- `keeper.ts` — dry-run by default; key read from `KEEPER_KEY_FILE` at send time only.
- `scripts/replay-check.ts` — read-only mainnet comparison of indexed vs live state.
