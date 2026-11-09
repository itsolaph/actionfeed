import { randomBytes } from "node:crypto";
import { Db, type EventRow } from "./db.js";
import { canonicalHistory, pendingAt } from "./history.js";
import { SIGNATURE_HEADER, sign } from "./signing.js";
import { safePost, validateWebhookUrl, SsrfError, type PostResult, type UrlPolicy } from "./ssrf.js";

export const EVENT_TYPES = ["scheduled", "cancelled", "effective", "paused", "announcement"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const LEADS: Record<string, number> = { "T-24h": 86400, "T-1h": 3600, "T-5m": 300 };
export const MAX_ATTEMPTS = 6;

export interface Subscription {
  id: string;
  url: string;
  secret: string;
  token_filter: string | null;
  events: string;
  leads: string;
  created_at: number;
  active: number;
}

export type Poster = (url: URL, body: string, headers: Record<string, string>, policy: UrlPolicy) => Promise<PostResult>;

export function eventTypeOf(row: Pick<EventRow, "kind" | "block_timestamp" | "effective_at">): EventType | null {
  switch (row.kind) {
    case "updated":
      return (row.effective_at ?? 0) > row.block_timestamp ? "scheduled" : "effective";
    case "cancelled":
      return "cancelled";
    case "paused":
    case "unpaused":
      return "paused";
    case "announcement":
      return "announcement";
    default:
      return null;
  }
}

export function rowToPayloadData(row: Omit<EventRow, "id">) {
  return {
    kind: row.kind,
    blockNumber: row.block_number,
    blockTimestamp: row.block_timestamp,
    txHash: row.tx_hash,
    oldMultiplier: row.old_mult,
    newMultiplier: row.new_mult,
    effectiveAt: row.effective_at,
    details: row.data ? JSON.parse(row.data) : null,
  };
}

export class Webhooks {
  constructor(
    private db: Db,
    private policy: UrlPolicy,
    private post: Poster = safePost,
    private clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  create(input: { url: string; tokens?: string[]; events?: string[]; leads?: string[] }) {
    validateWebhookUrl(input.url, this.policy); // throws SsrfError
    const events = input.events?.length ? input.events : [...EVENT_TYPES];
    for (const e of events) if (!(EVENT_TYPES as readonly string[]).includes(e)) throw new Error(`unknown event: ${e}`);
    const leads = input.leads ?? [];
    for (const l of leads) if (!(l in LEADS)) throw new Error(`unknown lead: ${l} (use ${Object.keys(LEADS).join(", ")})`);
    const tokens = (input.tokens ?? []).map((t) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`bad token address: ${t}`);
      return t.toLowerCase();
    });
    const id = "sub_" + randomBytes(8).toString("hex");
    const secret = "whsec_" + randomBytes(24).toString("hex");
    this.db.sql
      .prepare("INSERT INTO subscriptions(id,url,secret,token_filter,events,leads,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, input.url, secret, tokens.length ? tokens.join(",") : null, events.join(","), leads.join(","), this.clock());
    return { id, secret, url: input.url, tokens, events, leads }; // secret is returned exactly once
  }

  get(id: string): Subscription | undefined {
    return this.db.sql.prepare("SELECT * FROM subscriptions WHERE id=?").get(id) as any;
  }
  remove(id: string) {
    this.db.sql.prepare("UPDATE subscriptions SET active=0 WHERE id=?").run(id);
  }
  deliveries(id: string, limit = 50) {
    return this.db.sql
      .prepare("SELECT id,dedupe,status,attempts,next_attempt,last_status,last_error,created_at FROM deliveries WHERE sub_id=? ORDER BY id DESC LIMIT ?")
      .all(id, limit);
  }

  private matching(type: string, token: string, lead?: string): Subscription[] {
    const subs = this.db.sql.prepare("SELECT * FROM subscriptions WHERE active=1").all() as unknown as Subscription[];
    return subs.filter(
      (s) =>
        s.events.split(",").includes(type === "upcoming" ? "effective" : type) &&
        (!s.token_filter || s.token_filter.split(",").includes(token)) &&
        (type !== "upcoming" || (lead !== undefined && s.leads.split(",").includes(lead))),
    );
  }

  /** Queue a delivery for each interested subscription (idempotent per dedupe key). */
  enqueue(type: string, token: string, data: unknown, dedupe: string, lead?: string): number {
    let n = 0;
    for (const s of this.matching(type, token.toLowerCase(), lead)) {
      const payload = JSON.stringify({ id: `${s.id}:${dedupe}`, type, token: token.toLowerCase(), lead, createdAt: this.clock(), data });
      const r = this.db.sql
        .prepare("INSERT OR IGNORE INTO deliveries(sub_id,dedupe,payload,status,next_attempt,created_at) VALUES(?,?,?,?,?,?)")
        .run(s.id, dedupe, payload, "pending", this.clock(), this.clock());
      n += Number(r.changes);
    }
    return n;
  }

  onChainEvent(row: Omit<EventRow, "id">) {
    const type = eventTypeOf(row);
    if (!type) return;
    this.enqueue(type, row.token, rowToPayloadData(row), `${row.tx_hash}:${row.log_index}`);
  }

  /** Emit T-lead reminders and "effective" notices for pending actions as time passes. */
  scanSchedule() {
    const now = this.clock();
    for (const t of this.db.tokens()) {
      const h = canonicalHistory(this.db.multEvents(t.address));
      for (const p of h.points) {
        const data = { effectiveAt: p.effectiveAt, multiplier: p.multiplier.toString(), oldMultiplier: p.oldMultiplier.toString(), symbol: t.symbol };
        if (p.kind === "scheduled") {
          for (const [lead, secs] of Object.entries(LEADS)) {
            if (now >= p.effectiveAt - secs && now < p.effectiveAt) this.enqueue("upcoming", t.address, data, `lead:${t.address}:${p.effectiveAt}:${p.multiplier}:${lead}`, lead);
          }
          if (now >= p.effectiveAt) this.enqueue("effective", t.address, data, `eff:${t.address}:${p.effectiveAt}:${p.multiplier}`);
        }
      }
      void pendingAt;
    }
  }

  /** Attempt due deliveries. Retries with exponential backoff (30s, 2m, 8m, 32m, ~2h), then marks failed. */
  async processQueue(): Promise<number> {
    const now = this.clock();
    const due = this.db.sql
      .prepare("SELECT d.*, s.url, s.secret, s.active FROM deliveries d JOIN subscriptions s ON s.id=d.sub_id WHERE d.status='pending' AND d.next_attempt<=? LIMIT 50")
      .all(now) as any[];
    for (const d of due) {
      const attempts = d.attempts + 1;
      let status = 0;
      let err: string | null = null;
      try {
        if (!d.active) throw new Error("subscription removed");
        const url = validateWebhookUrl(d.url, this.policy);
        const ts = this.clock();
        const res = await this.post(url, d.payload, { [SIGNATURE_HEADER]: sign(d.secret, d.payload, ts), "user-agent": "ActionFeed-Webhook/1" }, this.policy);
        status = res.status;
        if (status < 200 || status >= 300) err = `HTTP ${status}`;
      } catch (e) {
        err = e instanceof SsrfError ? `blocked: ${e.message}` : (e as Error).message;
        if (e instanceof SsrfError) status = -1;
      }
      const terminal = err === null ? "delivered" : status === -1 || attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      const next = now + 30 * 4 ** (attempts - 1);
      this.db.sql
        .prepare("UPDATE deliveries SET status=?, attempts=?, next_attempt=?, last_status=?, last_error=? WHERE id=?")
        .run(terminal, attempts, next, status, err, d.id);
    }
    return due.length;
  }
}
