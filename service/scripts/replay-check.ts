/**
 * Read-only replay check against Base mainnet.
 * Indexes multiplier/pause/announcement events for every listed B20 token over a block window, rebuilds the
 * canonical history, and compares it with live contract reads (uiMultiplier / newUIMultiplier / effectiveAt).
 *
 *   REPLAY_LOOKBACK=3000000 pnpm replay        # window = head-3M .. head-confirmations (default 3,000,000)
 *   REPLAY_FROM=<block> pnpm replay            # explicit start
 *   RPC_URL=<rpc>                              # default: public node (rate limited; ranges are kept small)
 *
 * Exits non-zero on any mismatch or read failure. No transactions are sent.
 */
import { getAddress } from "viem";
import { Db } from "../src/db.js";
import { crossCheck, fetchTokenList, syncOnce } from "../src/indexer.js";
import { canonicalHistory } from "../src/history.js";
import { makeClient } from "../src/rpc.js";

const client = makeClient();
const db = new Db(":memory:");
const confirmations = 20n;

const list = await fetchTokenList();
for (const t of list) db.upsertToken(t);
console.log(`tokens from Coinbase list: ${list.length}`);

const head = await client.getBlockNumber();
const from = process.env.REPLAY_FROM ? BigInt(process.env.REPLAY_FROM) : head - BigInt(process.env.REPLAY_LOOKBACK || "400000");
console.log(`head=${head} window=[${from}, ${head - confirmations}]`);

let last = 0;
const res = await syncOnce(client, db, {
  startBlock: from,
  confirmations,
  chunk: Number(process.env.CHUNK || 10000),
  onProgress: (_a, b) => {
    if (Date.now() - last > 5000) {
      last = Date.now();
      console.log(`  scanned to ${b}`);
    }
  },
});
console.log(`indexed ${res.inserted} events`);

const rows: Record<string, string | number>[] = [];
let bad = 0;
for (const t of db.tokens()) {
  try {
    const c = await crossCheck(client, db, t.address);
    const h = canonicalHistory(db.multEvents(t.address));
    if (!c.ok) bad++;
    rows.push({
      symbol: t.symbol ?? "?",
      address: getAddress(t.address),
      events: c.events,
      points: h.points.length,
      chain: c.chainMultiplier.toString(),
      indexed: c.indexedMultiplier?.toString() ?? "-",
      pendingChain: c.chainPendingAt,
      pendingIdx: c.indexedPendingAt,
      result: c.ok ? "OK" : "MISMATCH",
      note: c.note,
    });
  } catch (e) {
    bad++;
    rows.push({ symbol: t.symbol ?? "?", address: t.address, events: 0, points: 0, chain: "-", indexed: "-", pendingChain: 0, pendingIdx: 0, result: "READ-FAIL", note: (e as Error).message.slice(0, 60) });
  }
}
console.table(rows);
const withEvents = rows.filter((r) => Number(r.events) > 0).length;
console.log(`tokens=${rows.length} withMultiplierEvents=${withEvents} mismatches/failures=${bad}`);
console.log(`NOTE: tokens with 0 events were only checked against the window [${from}, ${head - confirmations}]; their baseline is unknown.`);
process.exit(bad ? 1 : 0);
