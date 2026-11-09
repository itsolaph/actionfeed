# ActionFeed

Corporate-action infrastructure for Coinbase tokenized stocks on Base (B20 asset tokens, ERC-8056 UI multiplier).

Splits and reinvested dividends change a token's `uiMultiplier`, possibly on a schedule and possibly cancelled. The docs tell integrators to rebuild history by replaying events and dating each change by `effectiveAtTimestamp`. ActionFeed does that for you, onchain and off.

> Independent, community-built, MIT licensed. Not affiliated with, endorsed by, or holding any rights in Coinbase, Base, or any underlying company. Informational software; not investment advice.

## What it does
- **`ActionFeed.sol`** (immutable, no owner/admin/upgrade, holds no funds): permissionless `checkpoint`, onchain `multiplierAt(token, ts)`, `status`, conversion helpers, `assertStable`. `ActionFeedLib` gives AMMs/vaults/keepers a guard that needs no deployment.
- **Service**: indexer (reorg-safe depth, resumable backfill), canonical history with contract cross-check, REST + SSE API, signed webhooks, optional keeper, dashboard at `/`, `/openapi.json`, `/llms.txt`.
- **SDK**: typed client, `verifySignature`, offline `multiplierAt`.

## What it does not do
- It does not price anything, give advice, or hold/move user funds.
- Onchain history is only as fresh as the last `checkpoint`; two changes between checkpoints lose the intermediate onchain value.
- `multiplierAt` returns `known=false` before the first checkpoint; the API returns `known=false` outside the indexed window.
- Not audited.

## Deployed addresses
| Chain | Address |
|---|---|
| Base mainnet | [`0xC455472cd39029F8309F0D762Ee587D65A596Fe2`](https://basescan.org/address/0xC455472cd39029F8309F0D762Ee587D65A596Fe2) (CREATE2, salt `keccak256("actionfeed.v1")`) |

## Quick start
```bash
./contracts/install-deps.sh && (cd contracts && forge test)
pnpm install && pnpm test && pnpm build
pnpm --filter @actionfeed/service start      # http://localhost:8787
pnpm replay                                  # read-only mainnet replay check
```
See [docs/INTEGRATING.md](docs/INTEGRATING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Config: `.env.example`.

## Security model
- Contract: no privileged roles; a token is trusted only for its own history (a hostile token can only pollute its own record). No feed registry (spoofable): reference feeds are passed per call to `statusWithFeed`.
- Webhooks: HMAC-SHA256 with timestamp (300s window), https-only in production, private/loopback/link-local/metadata ranges blocked, validation done in the socket lookup (rebinding-safe), no redirects, size/time caps.
- Keeper: off by default; dry-run default ON; key read from `KEEPER_KEY_FILE` only when sending; never logged.

## Limitations
Public RPCs restrict `getLogs` (small ranges, few addresses, limited archive depth); use your own RPC and `START_BLOCK` for full backfills. Stock `forge` cannot execute the B20 precompiles, so the fork test self-skips; tests use a mock mirroring base-std semantics.

## Credits
- [base/base-std](https://github.com/base/base-std) — B20/ERC-8056 interfaces and mocks (MIT).
- Dashboard fonts, self-hosted from [Fontsource](https://fontsource.org) packages under the SIL Open Font License 1.1 (licences in `service/public/fonts/`): Archivo (`@fontsource-variable/archivo`), Instrument Sans (`@fontsource-variable/instrument-sans`), IBM Plex Mono (`@fontsource/ibm-plex-mono`).
- Coinbase tokenized stocks API (`api.coinbase.com/v1/tokenized-stocks`) for the token list; Chainlink AggregatorV3 interface for optional reference feeds.
- ERC-8021 / Base Builder Codes specification.
- Libraries: viem, Fastify, vitest, forge-std (all MIT/Apache-2.0).
