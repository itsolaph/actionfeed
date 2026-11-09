import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { MultEvent } from "./history.js";

// Loaded via require so bundlers (vitest/vite) don't try to resolve the `node:sqlite` builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface TokenRow {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export interface EventRow {
  id: number;
  token: string;
  kind: string; // updated | cancelled | announcement | paused | unpaused | policy
  block_number: number;
  block_timestamp: number;
  log_index: number;
  tx_hash: string;
  old_mult: string | null;
  new_mult: string | null;
  effective_at: number | null;
  data: string | null;
}

export class Db {
  readonly sql: DatabaseSyncType;

  constructor(path = ":memory:") {
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tokens(address TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER);
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, kind TEXT NOT NULL,
        block_number INTEGER NOT NULL, block_timestamp INTEGER NOT NULL, log_index INTEGER NOT NULL,
        tx_hash TEXT NOT NULL, old_mult TEXT, new_mult TEXT, effective_at INTEGER, data TEXT,
        UNIQUE(tx_hash, log_index));
      CREATE INDEX IF NOT EXISTS events_token ON events(token, block_number, log_index);
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS subscriptions(
        id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, token_filter TEXT,
        events TEXT NOT NULL, leads TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS deliveries(
        id INTEGER PRIMARY KEY AUTOINCREMENT, sub_id TEXT NOT NULL, dedupe TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        last_status INTEGER, last_error TEXT, created_at INTEGER NOT NULL, UNIQUE(sub_id, dedupe));
    `);
  }

  getKv(key: string): string | undefined {
    return (this.sql.prepare("SELECT value FROM kv WHERE key=?").get(key) as any)?.value;
  }
  setKv(key: string, value: string) {
    this.sql.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  upsertToken(t: TokenRow) {
    this.sql
      .prepare(
        `INSERT INTO tokens(address,symbol,name,decimals) VALUES(?,?,?,?)
         ON CONFLICT(address) DO UPDATE SET symbol=COALESCE(excluded.symbol,symbol), name=COALESCE(excluded.name,name), decimals=COALESCE(excluded.decimals,decimals)`,
      )
      .run(t.address.toLowerCase(), t.symbol, t.name, t.decimals);
  }
  tokens(): TokenRow[] {
    return this.sql.prepare("SELECT * FROM tokens ORDER BY symbol").all() as unknown as TokenRow[];
  }
  token(address: string): TokenRow | undefined {
    return this.sql.prepare("SELECT * FROM tokens WHERE address=?").get(address.toLowerCase()) as any;
  }

  /** @returns true if inserted (false if duplicate) */
  insertEvent(e: Omit<EventRow, "id">): boolean {
    const r = this.sql
      .prepare(
        `INSERT OR IGNORE INTO events(token,kind,block_number,block_timestamp,log_index,tx_hash,old_mult,new_mult,effective_at,data)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(e.token.toLowerCase(), e.kind, e.block_number, e.block_timestamp, e.log_index, e.tx_hash, e.old_mult, e.new_mult, e.effective_at, e.data);
    return Number(r.changes) > 0;
  }

  eventsFor(token: string, kinds?: string[]): EventRow[] {
    const rows = this.sql
      .prepare("SELECT * FROM events WHERE token=? ORDER BY block_number, log_index")
      .all(token.toLowerCase()) as unknown as EventRow[];
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }

  recentEvents(limit: number, kinds?: string[]): EventRow[] {
    const rows = this.sql
      .prepare("SELECT * FROM events ORDER BY block_number DESC, log_index DESC LIMIT ?")
      .all(limit * 4) as unknown as EventRow[];
    return (kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows).slice(0, limit);
  }

  deleteEventsFrom(blockNumber: number) {
    this.sql.prepare("DELETE FROM events WHERE block_number>=?").run(blockNumber);
  }

  multEvents(token: string): MultEvent[] {
    return this.eventsFor(token, ["updated", "cancelled"]).map((r) => ({
      kind: r.kind as "updated" | "cancelled",
      blockNumber: r.block_number,
      logIndex: r.log_index,
      blockTimestamp: r.block_timestamp,
      oldMult: BigInt(r.old_mult ?? "0"),
      newMult: BigInt(r.new_mult ?? "0"),
      effectiveAt: r.effective_at ?? 0,
    }));
  }
}
