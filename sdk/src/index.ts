import { createHmac, timingSafeEqual } from "node:crypto";

export interface HistoryPoint {
  effectiveAt: number;
  multiplier: string;
  oldMultiplier: string;
  kind: "instant" | "scheduled";
  scheduledAtBlock: number;
}
export interface TokenHistory {
  token: string;
  baseline: string | null;
  points: HistoryPoint[];
}
export interface TokenInfo {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  multiplier: string | null;
  pending: { multiplier: string; effectiveAt: number } | null;
  events: number;
}
export interface UpcomingAction {
  token: string;
  symbol: string | null;
  effectiveAt: number;
  multiplier: string;
  oldMultiplier: string;
  secondsUntil: number;
}
export interface ActionEvent {
  token: string;
  symbol: string | null;
  kind: string;
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  oldMultiplier: string | null;
  newMultiplier: string | null;
  effectiveAt: number | null;
  details: unknown;
}

export class ActionFeedClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.fetchImpl(this.baseUrl + path);
    if (!r.ok) throw new Error(`ActionFeed ${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  tokens = () => this.get<{ tokens: TokenInfo[] }>("/v1/tokens").then((r) => r.tokens);
  token = (address: string) => this.get<TokenInfo & { live: unknown }>(`/v1/tokens/${address}`);
  upcoming = () => this.get<{ actions: UpcomingAction[] }>("/v1/actions/upcoming").then((r) => r.actions);
  recent = (limit = 50) => this.get<{ events: ActionEvent[] }>(`/v1/actions/recent?limit=${limit}`).then((r) => r.events);
  history = (address: string) => this.get<TokenHistory & { events: ActionEvent[] }>(`/v1/tokens/${address}/history`);
  multiplierAt = (address: string, at?: number) =>
    this.get<{ token: string; at: number; multiplier: string | null; known: boolean }>(
      `/v1/tokens/${address}/multiplier${at === undefined ? "" : `?at=${at}`}`,
    );

  async createSubscription(body: { url: string; tokens?: string[]; events?: string[]; leads?: string[] }) {
    const r = await this.fetchImpl(this.baseUrl + "/v1/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ActionFeed subscribe: HTTP ${r.status}`);
    return (await r.json()) as { id: string; secret: string };
  }
}

/** Verify an `X-ActionFeed-Signature` header (`t=<unix>,v1=<hmac-sha256 hex of "<t>.<rawBody>">`). */
export function verifySignature(secret: string, rawBody: string, header: string, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Offline: multiplier in force at `at` (unix seconds) given a /history response. null = unknown. */
export function multiplierAt(h: Pick<TokenHistory, "baseline" | "points">, at: number): bigint | null {
  let cur: bigint | null = h.baseline === null ? null : BigInt(h.baseline);
  for (const p of [...h.points].sort((a, b) => a.effectiveAt - b.effectiveAt)) {
    if (p.effectiveAt <= at) cur = BigInt(p.multiplier);
    else break;
  }
  return cur;
}

/** raw base units -> UI amount, rounded down (same rule as the onchain `toShares`). */
export const toUiAmount = (raw: bigint, multiplier: bigint) => (raw * multiplier) / 10n ** 18n;
/** UI amount -> raw base units, rounded down. */
export const toRawAmount = (ui: bigint, multiplier: bigint) => (ui * 10n ** 18n) / multiplier;
