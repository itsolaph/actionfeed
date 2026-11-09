import { EventEmitter } from "node:events";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { EV } from "../src/abi.js";
import { buildApp } from "../src/app.js";
import { Db } from "../src/db.js";
import { decodeToRow } from "../src/indexer.js";
import { verify } from "../src/signing.js";
import { Webhooks, type Poster } from "../src/webhooks.js";

const TOKEN = "0xb20000000000000000000078ee7ce2fe4908108c";
const W = 10n ** 18n;
const NOW = 2_000_000;

function mkLog(name: "UIMultiplierUpdated" | "UIMultiplierUpdateCancelled", args: bigint[], block: number, idx: number): Log {
  const item = EV[name];
  return {
    address: TOKEN, blockNumber: BigInt(block), logIndex: idx, transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    topics: encodeEventTopics({ abi: [item], eventName: name } as any) as any,
    data: encodeAbiParameters(item.inputs as any, args as any),
  } as unknown as Log;
}

function setup() {
  const db = new Db(":memory:");
  db.upsertToken({ address: TOKEN, symbol: "NVDAc", name: "NVIDIA", decimals: 8 });
  // recorded-fixture style: schedule 2:1 split (block ts 1_000_000 -> effective 2_500_000), plus a cancelled one
  const rows = [
    decodeToRow(mkLog("UIMultiplierUpdated", [W, 2n * W, 2_500_000n], 100, 0), 1_000_000),
    decodeToRow(mkLog("UIMultiplierUpdated", [2n * W, 3n * W, 3_500_000n], 200, 0), 1_100_000),
    decodeToRow(mkLog("UIMultiplierUpdateCancelled", [3n * W, 3_500_000n], 210, 0), 1_110_000),
  ];
  for (const r of rows) db.insertEvent(r!);
  const posts: { url: string; body: string; sig: string }[] = [];
  const poster: Poster = async (url, body, headers) => {
    posts.push({ url: url.href, body, sig: headers["X-ActionFeed-Signature"]! });
    return { status: 200, body: "ok" };
  };
  const clock = { t: NOW };
  const webhooks = new Webhooks(db, { production: false }, poster, () => clock.t);
  return { db, webhooks, posts, clock };
}

describe("indexer decoding (fixtures)", () => {
  it("decodes logs", () => {
    const r = decodeToRow(mkLog("UIMultiplierUpdated", [W, 2n * W, 2_500_000n], 100, 0), 1_000_000)!;
    expect(r.kind).toBe("updated");
    expect(r.new_mult).toBe((2n * W).toString());
    expect(r.effective_at).toBe(2_500_000);
  });
  it("insert is idempotent", () => {
    const { db } = setup();
    const again = decodeToRow(mkLog("UIMultiplierUpdated", [W, 2n * W, 2_500_000n], 100, 0), 1_000_000)!;
    expect(db.insertEvent(again)).toBe(false);
  });
});

describe("REST API", () => {
  async function app() {
    const s = setup();
    const a = await buildApp({ db: s.db, webhooks: s.webhooks, bus: new EventEmitter(), now: () => s.clock.t });
    return { a, ...s };
  }

  it("health, tokens, upcoming, recent", async () => {
    const { a } = await app();
    expect((await a.inject("/health")).json().ok).toBe(true);
    const tokens = (await a.inject("/v1/tokens")).json().tokens;
    expect(tokens[0].multiplier).toBe(W.toString());
    expect(tokens[0].pending.effectiveAt).toBe(2_500_000);
    const up = (await a.inject("/v1/actions/upcoming")).json().actions;
    expect(up).toHaveLength(1);
    expect(up[0].secondsUntil).toBe(500_000);
    expect((await a.inject("/v1/actions/recent")).json().events).toHaveLength(3);
  });

  it("tokens list carries live reads when available; fonts are served", async () => {
    const s = setup();
    const live = { uiMultiplier: (W + 5n * 10n ** 15n).toString(), newUIMultiplier: W.toString(), effectiveAt: 0 };
    const a = await buildApp({ db: s.db, webhooks: s.webhooks, bus: new EventEmitter(), now: () => s.clock.t, live: async () => live });
    expect((await a.inject("/v1/tokens")).json().tokens[0].live).toEqual(live);
    const f = await a.inject("/fonts/archivo-latin-wdth-normal.woff2");
    expect(f.statusCode).toBe(200);
    expect(f.headers["content-type"]).toContain("font/woff2");
    expect((await a.inject("/fonts/..%2Fapp.ts")).statusCode).toBe(404);
  });

  it("multiplier at time", async () => {
    const { a } = await app();
    const get = async (at: number) => (await a.inject(`/v1/tokens/${TOKEN}/multiplier?at=${at}`)).json();
    expect((await get(2_499_999)).multiplier).toBe(W.toString());
    expect((await get(2_500_000)).multiplier).toBe((2n * W).toString());
    expect((await a.inject(`/v1/tokens/${TOKEN}/multiplier?at=abc`)).statusCode).toBe(400);
  });

  it("history drops cancelled", async () => {
    const { a } = await app();
    const h = (await a.inject(`/v1/tokens/${TOKEN}/history`)).json();
    expect(h.points.map((p: any) => p.effectiveAt)).toEqual([2_500_000]);
    expect(h.events).toHaveLength(3);
  });

  it("validates addresses and unknown tokens", async () => {
    const { a } = await app();
    expect((await a.inject("/v1/tokens/nope")).statusCode).toBe(400);
    expect((await a.inject("/v1/tokens/0x0000000000000000000000000000000000000001")).statusCode).toBe(404);
  });

  it("serves CORS headers", async () => {
    const { a } = await app();
    const r = await a.inject({ method: "GET", url: "/health", headers: { origin: "https://x.example" } });
    expect(r.headers["access-control-allow-origin"]).toBe("*");
  });

  it("rate limits", async () => {
    const s = setup();
    const a = await buildApp({ db: s.db, webhooks: s.webhooks, bus: new EventEmitter(), rateLimitMax: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await a.inject("/health")).statusCode);
    expect(codes).toContain(429);
  });

  it("subscription: SSRF rejected in production, secret returned once, auth on log", async () => {
    const s = setup();
    const a = await buildApp({ db: s.db, webhooks: new Webhooks(s.db, { production: true }), bus: new EventEmitter() });
    const bad = await a.inject({ method: "POST", url: "/v1/subscriptions", payload: { url: "http://169.254.169.254/x" } });
    expect(bad.statusCode).toBe(400);
    const ok = await a.inject({ method: "POST", url: "/v1/subscriptions", payload: { url: "https://example.com/hook", events: ["scheduled"] } });
    expect(ok.statusCode).toBe(201);
    const { id, secret } = ok.json();
    expect(secret).toMatch(/^whsec_/);
    expect((await a.inject(`/v1/subscriptions/${id}/deliveries`)).statusCode).toBe(401);
    expect((await a.inject({ url: `/v1/subscriptions/${id}/deliveries`, headers: { authorization: `Bearer ${secret}` } })).statusCode).toBe(200);
  });
});

describe("webhooks", () => {
  it("signs, delivers, dedupes, and sends T-minus reminders", async () => {
    const { webhooks, posts, clock } = setup();
    const sub = webhooks.create({ url: "http://localhost:9/h", events: ["scheduled", "effective"], leads: ["T-1h"] });
    const row = decodeToRow(mkLog("UIMultiplierUpdated", [W, 2n * W, 2_500_000n], 100, 0), 1_000_000)!;
    webhooks.onChainEvent(row);
    webhooks.onChainEvent(row); // duplicate: ignored
    await webhooks.processQueue();
    expect(posts).toHaveLength(1);
    expect(verify(sub.secret, posts[0]!.body, posts[0]!.sig, 300, clock.t)).toBe(true);
    expect(JSON.parse(posts[0]!.body).type).toBe("scheduled");

    clock.t = 2_500_000 - 3000; // inside T-1h
    webhooks.scanSchedule();
    webhooks.scanSchedule();
    await webhooks.processQueue();
    expect(posts.filter((p) => JSON.parse(p.body).type === "upcoming")).toHaveLength(1);

    clock.t = 2_500_001;
    webhooks.scanSchedule();
    await webhooks.processQueue();
    expect(posts.some((p) => JSON.parse(p.body).type === "effective")).toBe(true);
  });

  it("retries with backoff then marks failed", async () => {
    const { db, clock } = setup();
    const wh = new Webhooks(db, { production: false }, async () => ({ status: 500, body: "" }), () => clock.t);
    const sub = wh.create({ url: "http://localhost:9/h", events: ["cancelled"] });
    wh.onChainEvent(decodeToRow(mkLog("UIMultiplierUpdateCancelled", [3n * W, 3_500_000n], 210, 0), 1_110_000)!);
    for (let i = 0; i < 8; i++) {
      await wh.processQueue();
      clock.t += 100_000;
    }
    const d = wh.deliveries(sub.id)[0] as any;
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(6);
  });
});
