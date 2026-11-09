import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ActionFeedClient, multiplierAt, toRawAmount, toUiAmount, verifySignature } from "./index.js";

const W = 10n ** 18n;

describe("sdk", () => {
  it("offline multiplierAt", () => {
    const h = { baseline: W.toString(), points: [{ effectiveAt: 100, multiplier: (2n * W).toString(), oldMultiplier: W.toString(), kind: "scheduled" as const, scheduledAtBlock: 1 }] };
    expect(multiplierAt(h, 99)).toBe(W);
    expect(multiplierAt(h, 100)).toBe(2n * W);
    expect(multiplierAt({ baseline: null, points: [] }, 5)).toBeNull();
  });
  it("conversions round down", () => {
    expect(toUiAmount(100n, 2n * W)).toBe(200n);
    expect(toRawAmount(1n, 1_000_537_939_576_369_481n)).toBe(0n);
  });
  it("verifySignature", () => {
    const body = "{}";
    const mac = createHmac("sha256", "s").update(`1000.${body}`).digest("hex");
    expect(verifySignature("s", body, `t=1000,v1=${mac}`, 300, 1100)).toBe(true);
    expect(verifySignature("s", body, `t=1000,v1=${mac}`, 300, 5000)).toBe(false);
    expect(verifySignature("x", body, `t=1000,v1=${mac}`, 300, 1100)).toBe(false);
  });
  it("client calls the right paths", async () => {
    const seen: string[] = [];
    const f = (async (u: string) => { seen.push(u); return { ok: true, json: async () => ({ actions: [], tokens: [], events: [] }) }; }) as any;
    const c = new ActionFeedClient("https://x.example/", f);
    await c.upcoming();
    await c.multiplierAt("0xabc", 5);
    expect(seen).toEqual(["https://x.example/v1/actions/upcoming", "https://x.example/v1/tokens/0xabc/multiplier?at=5"]);
  });
});
