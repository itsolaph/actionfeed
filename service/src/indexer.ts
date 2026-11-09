import { decodeEventLog, getAddress, type Address, type Log, type PublicClient } from "viem";
import { ALL_EVENTS, FEATURES, tokenAbi } from "./abi.js";
import { Db, type EventRow } from "./db.js";
import { canonicalHistory, multiplierAt, pendingAt } from "./history.js";
import { fetchLogs, withBackoff } from "./rpc.js";

export const COINBASE_TOKENS_URL = "https://api.coinbase.com/v1/tokenized-stocks";

export interface ListedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

/** Discover tokens from the free Coinbase list (paginated; field `tokens`, cursor `next_page_token`). */
export async function fetchTokenList(fetchImpl: typeof fetch = fetch, url = COINBASE_TOKENS_URL): Promise<ListedToken[]> {
  const out: ListedToken[] = [];
  let page: string | undefined;
  for (let i = 0; i < 100; i++) {
    const u = new URL(url);
    u.searchParams.set("page_size", "100");
    if (page) u.searchParams.set("page_token", page);
    const res = await withBackoff(async () => {
      const r = await fetchImpl(u);
      if (!r.ok) throw new Error(`token list HTTP ${r.status}`);
      return r.json() as Promise<any>;
    }, 4);
    for (const t of res.tokens ?? []) {
      if (typeof t.contract_address === "string" && /^0xb2000/i.test(t.contract_address)) {
        out.push({ address: t.contract_address.toLowerCase(), symbol: t.symbol, name: t.name, decimals: t.decimals });
      }
    }
    page = res.next_page_token || undefined;
    if (!page) break;
  }
  return out;
}

export function decodeToRow(log: Log, blockTimestamp: number): Omit<EventRow, "id"> | null {
  let ev: any;
  try {
    ev = decodeEventLog({ abi: ALL_EVENTS, data: log.data, topics: log.topics as any });
  } catch {
    return null;
  }
  const base = {
    token: log.address.toLowerCase(),
    block_number: Number(log.blockNumber),
    block_timestamp: blockTimestamp,
    log_index: Number(log.logIndex),
    tx_hash: log.transactionHash!,
    old_mult: null as string | null,
    new_mult: null as string | null,
    effective_at: null as number | null,
    data: null as string | null,
  };
  const a = ev.args;
  switch (ev.eventName) {
    case "UIMultiplierUpdated":
      return { ...base, kind: "updated", old_mult: a.oldMultiplier.toString(), new_mult: a.newMultiplier.toString(), effective_at: Number(a.effectiveAtTimestamp) };
    case "UIMultiplierUpdateCancelled":
      return { ...base, kind: "cancelled", new_mult: a.cancelledMultiplier.toString(), effective_at: Number(a.cancelledEffectiveAt) };
    case "Announcement":
      return { ...base, kind: "announcement", data: JSON.stringify({ caller: a.caller, id: a.id, description: a.description, uri: a.uri }) };
    case "Paused":
    case "Unpaused":
      return { ...base, kind: ev.eventName === "Paused" ? "paused" : "unpaused", data: JSON.stringify({ updater: a.updater, features: (a.features as number[]).map((f) => FEATURES[f] ?? String(f)) }) };
    case "PolicyUpdated":
      return { ...base, kind: "policy", data: JSON.stringify({ scope: a.policyScope, oldPolicyId: String(a.oldPolicyId), newPolicyId: String(a.newPolicyId) }) };
  }
  return null;
}

export interface SyncOptions {
  startBlock: bigint;
  confirmations: bigint;
  chunk?: number;
  onNewEvent?: (row: Omit<EventRow, "id">) => void;
  onProgress?: (from: bigint, to: bigint) => void;
}

/** Resume-able sync: backfill from startBlock (or saved cursor) up to head - confirmations. */
export async function syncOnce(client: PublicClient, db: Db, opts: SyncOptions): Promise<{ from: bigint; to: bigint; inserted: number }> {
  const head = await withBackoff(() => client.getBlockNumber());
  const safe = head - opts.confirmations;
  const saved = db.getKv("cursor");
  const from = saved ? BigInt(saved) + 1n : opts.startBlock;
  if (safe < from) return { from, to: safe, inserted: 0 };
  const tokens = db.tokens().map((t) => getAddress(t.address) as Address);
  if (tokens.length === 0) return { from, to: safe, inserted: 0 };

  // Process in windows so the cursor advances (resume after crash) instead of one giant fetch.
  const WINDOW = 50_000n;
  let inserted = 0;
  const tsCache = new Map<bigint, number>();
  for (let start = from; start <= safe; start += WINDOW) {
    const end = start + WINDOW - 1n > safe ? safe : start + WINDOW - 1n;
    const logs = await fetchLogs(client, tokens, start, end, { chunk: opts.chunk, onProgress: opts.onProgress });
    for (const log of logs) {
      const bn = log.blockNumber!;
      let ts = tsCache.get(bn);
      if (ts === undefined) {
        ts = Number((await withBackoff(() => client.getBlock({ blockNumber: bn }))).timestamp);
        tsCache.set(bn, ts);
      }
      const row = decodeToRow(log, ts);
      if (row && db.insertEvent(row)) {
        inserted++;
        opts.onNewEvent?.(row);
      }
    }
    db.setKv("cursor", end.toString());
  }
  return { from, to: safe, inserted };
}

export interface CrossCheck {
  token: string;
  symbol: string | null;
  events: number;
  chainMultiplier: bigint;
  indexedMultiplier: bigint | null;
  chainPendingAt: number;
  indexedPendingAt: number;
  ok: boolean;
  note: string;
}

/** Compare the canonical (event-replayed) view with live contract reads. */
export async function crossCheck(client: PublicClient, db: Db, token: string): Promise<CrossCheck> {
  const addr = getAddress(token);
  const [mult, newMult, eff, block] = await withBackoff(async () => {
    const [m, n, e, b] = await Promise.all([
      client.readContract({ address: addr, abi: tokenAbi, functionName: "uiMultiplier" }),
      client.readContract({ address: addr, abi: tokenAbi, functionName: "newUIMultiplier" }),
      client.readContract({ address: addr, abi: tokenAbi, functionName: "effectiveAt" }),
      client.getBlock(),
    ]);
    return [m, n, e, b] as const;
  });
  const now = Number(block.timestamp);
  const evs = db.multEvents(token);
  const h = canonicalHistory(evs);
  const { multiplier } = multiplierAt(h, now);
  const pend = pendingAt(h, now);
  const row = { token: token.toLowerCase(), symbol: db.token(token)?.symbol ?? null, events: evs.length, chainMultiplier: mult, indexedMultiplier: multiplier, chainPendingAt: eff > BigInt(now) ? Number(eff) : 0, indexedPendingAt: pend?.effectiveAt ?? 0 };
  let note = "";
  let ok = true;
  if (multiplier === null) {
    // no multiplier events: the token must still be at its initial value; nothing to contradict
    note = "no events (baseline unknown)";
  } else if (multiplier !== mult) {
    ok = false;
    note = "multiplier mismatch";
  }
  if (row.chainPendingAt !== row.indexedPendingAt) {
    ok = false;
    note = (note ? note + "; " : "") + "pending mismatch";
  }
  void newMult;
  return { ...row, ok, note: note || "match" };
}
