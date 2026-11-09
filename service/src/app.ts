import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db, type EventRow } from "./db.js";
import { canonicalHistory, multiplierAt, pendingAt } from "./history.js";
import { SsrfError } from "./ssrf.js";
import { Webhooks } from "./webhooks.js";

export interface LiveState {
  uiMultiplier: string;
  newUIMultiplier: string;
  effectiveAt: number;
  transferPaused?: boolean;
}

export interface AppDeps {
  db: Db;
  webhooks: Webhooks;
  bus: EventEmitter;
  live?: (address: string) => Promise<LiveState | undefined>;
  now?: () => number;
  production?: boolean;
  rateLimitMax?: number;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => {
  const p = join(here, "..", "public", f);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
};

const ser = (v: bigint | null) => (v === null ? null : v.toString());

export function describeToken(deps: AppDeps, address: string) {
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  const t = deps.db.token(address);
  const h = canonicalHistory(deps.db.multEvents(address));
  const cur = multiplierAt(h, now);
  const pend = pendingAt(h, now);
  return {
    address: address.toLowerCase(),
    symbol: t?.symbol ?? null,
    name: t?.name ?? null,
    decimals: t?.decimals ?? null,
    multiplier: ser(cur.multiplier),
    pending: pend ? { multiplier: pend.multiplier.toString(), effectiveAt: pend.effectiveAt } : null,
    events: deps.db.eventsFor(address).length,
  };
}

function historyJson(deps: AppDeps, address: string) {
  const h = canonicalHistory(deps.db.multEvents(address));
  return {
    token: address.toLowerCase(),
    baseline: ser(h.baseline),
    note: "Canonical history: UIMultiplierUpdated events minus cancelled ones, dated by effectiveAt.",
    points: h.points.map((p) => ({ effectiveAt: p.effectiveAt, multiplier: p.multiplier.toString(), oldMultiplier: p.oldMultiplier.toString(), kind: p.kind, scheduledAtBlock: p.scheduledAtBlock })),
  };
}

function eventJson(r: EventRow, symbol?: string | null) {
  return {
    token: r.token,
    symbol: symbol ?? null,
    kind: r.kind,
    blockNumber: r.block_number,
    blockTimestamp: r.block_timestamp,
    txHash: r.tx_hash,
    oldMultiplier: r.old_mult,
    newMultiplier: r.new_mult,
    effectiveAt: r.effective_at,
    details: r.data ? JSON.parse(r.data) : null,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  await app.register(cors, { origin: "*" });
  await app.register(rateLimit, { max: deps.rateLimitMax ?? 120, timeWindow: "1 minute" });

  app.get("/health", async () => ({ ok: true, cursor: deps.db.getKv("cursor") ?? null, tokens: deps.db.tokens().length }));

  app.get("/v1/tokens", async () => ({ tokens: deps.db.tokens().map((t) => describeToken(deps, t.address)) }));

  app.get<{ Params: { address: string } }>("/v1/tokens/:address", async (req, reply) => {
    if (!ADDR.test(req.params.address)) return reply.code(400).send({ error: "bad address" });
    if (!deps.db.token(req.params.address)) return reply.code(404).send({ error: "unknown token" });
    const live = await deps.live?.(req.params.address).catch(() => undefined);
    return { ...describeToken(deps, req.params.address), live: live ?? null };
  });

  app.get<{ Params: { address: string }; Querystring: { at?: string } }>("/v1/tokens/:address/multiplier", async (req, reply) => {
    const { address } = req.params;
    if (!ADDR.test(address)) return reply.code(400).send({ error: "bad address" });
    if (!deps.db.token(address)) return reply.code(404).send({ error: "unknown token" });
    const at = req.query.at === undefined ? now() : Number(req.query.at);
    if (!Number.isInteger(at) || at < 0) return reply.code(400).send({ error: "at must be a unix timestamp" });
    const r = multiplierAt(canonicalHistory(deps.db.multEvents(address)), at);
    return { token: address.toLowerCase(), at, multiplier: ser(r.multiplier), known: r.known, scale: "1e18" };
  });

  app.get<{ Params: { address: string } }>("/v1/tokens/:address/history", async (req, reply) => {
    if (!ADDR.test(req.params.address)) return reply.code(400).send({ error: "bad address" });
    if (!deps.db.token(req.params.address)) return reply.code(404).send({ error: "unknown token" });
    return {
      ...historyJson(deps, req.params.address),
      events: deps.db.eventsFor(req.params.address).map((r) => eventJson(r)),
    };
  });

  app.get("/v1/actions/upcoming", async () => {
    const t = now();
    const out: unknown[] = [];
    for (const tok of deps.db.tokens()) {
      const h = canonicalHistory(deps.db.multEvents(tok.address));
      for (const p of h.points) {
        if (p.effectiveAt > t) out.push({ token: tok.address, symbol: tok.symbol, effectiveAt: p.effectiveAt, multiplier: p.multiplier.toString(), oldMultiplier: p.oldMultiplier.toString(), secondsUntil: p.effectiveAt - t });
      }
    }
    (out as any[]).sort((a, b) => a.effectiveAt - b.effectiveAt);
    return { actions: out };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/actions/recent", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = deps.db.recentEvents(limit);
    return { events: rows.map((r) => eventJson(r, deps.db.token(r.token)?.symbol)) };
  });

  // ── webhooks ──
  app.post<{ Body: { url?: string; tokens?: string[]; events?: string[]; leads?: string[] } }>("/v1/subscriptions", async (req, reply) => {
    const b = req.body ?? {};
    if (typeof b.url !== "string") return reply.code(400).send({ error: "url required" });
    try {
      return reply.code(201).send(deps.webhooks.create({ url: b.url, tokens: b.tokens, events: b.events, leads: b.leads }));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message, ssrf: e instanceof SsrfError || undefined });
    }
  });

  const authSub = (req: any, id: string) => {
    const sub = deps.webhooks.get(id);
    const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    return sub && sub.secret === tok ? sub : undefined;
  };
  app.get<{ Params: { id: string } }>("/v1/subscriptions/:id/deliveries", async (req, reply) => {
    if (!authSub(req, req.params.id)) return reply.code(401).send({ error: "use Authorization: Bearer <subscription secret>" });
    return { deliveries: deps.webhooks.deliveries(req.params.id) };
  });
  app.delete<{ Params: { id: string } }>("/v1/subscriptions/:id", async (req, reply) => {
    if (!authSub(req, req.params.id)) return reply.code(401).send({ error: "unauthorized" });
    deps.webhooks.remove(req.params.id);
    return { ok: true };
  });

  // ── SSE ──
  app.get("/v1/stream", (req, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    reply.raw.write(": connected\n\n");
    const onEvent = (row: Omit<EventRow, "id">) => {
      reply.raw.write(`event: ${row.kind}\ndata: ${JSON.stringify(eventJson(row as EventRow, deps.db.token(row.token)?.symbol))}\n\n`);
    };
    deps.bus.on("event", onEvent);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      deps.bus.off("event", onEvent);
    });
    reply.hijack();
  });

  // ── static ──
  const serve = (path: string, file: string, type: string) =>
    app.get(path, async (_req, reply) => {
      const body = pub(file);
      return body === undefined ? reply.code(404).send({ error: "not found" }) : reply.type(type).send(body);
    });
  serve("/", "index.html", "text/html; charset=utf-8");
  serve("/llms.txt", "llms.txt", "text/plain; charset=utf-8");
  serve("/openapi.json", "openapi.json", "application/json");

  return app;
}
