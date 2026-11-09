import { describe, expect, it } from "vitest";
import { canonicalHistory, multiplierAt, pendingAt, type MultEvent } from "../src/history.js";

const W = 10n ** 18n;
const ev = (p: Partial<MultEvent> & Pick<MultEvent, "kind" | "blockNumber">): MultEvent => ({
  logIndex: 0, blockTimestamp: 1000, oldMult: W, newMult: W, effectiveAt: 0, ...p,
});

describe("canonicalHistory", () => {
  it("dates scheduled updates by effectiveAt, not block time", () => {
    const h = canonicalHistory([ev({ kind: "updated", blockNumber: 1, blockTimestamp: 1000, newMult: 2n * W, effectiveAt: 5000 })]);
    expect(h.points).toHaveLength(1);
    expect(h.points[0]!.kind).toBe("scheduled");
    expect(multiplierAt(h, 4999).multiplier).toBe(W);
    expect(multiplierAt(h, 5000).multiplier).toBe(2n * W);
  });

  it("drops cancelled updates", () => {
    const h = canonicalHistory([
      ev({ kind: "updated", blockNumber: 1, newMult: 2n * W, effectiveAt: 5000 }),
      ev({ kind: "cancelled", blockNumber: 2, newMult: 2n * W, effectiveAt: 5000 }),
    ]);
    expect(h.points).toHaveLength(0);
    expect(multiplierAt(h, 9999).multiplier).toBe(W);
  });

  it("instant override: cancel then immediate update", () => {
    const h = canonicalHistory([
      ev({ kind: "updated", blockNumber: 1, blockTimestamp: 1000, newMult: 2n * W, effectiveAt: 5000 }),
      ev({ kind: "cancelled", blockNumber: 2, logIndex: 0, blockTimestamp: 2000, newMult: 2n * W, effectiveAt: 5000 }),
      ev({ kind: "updated", blockNumber: 2, logIndex: 1, blockTimestamp: 2000, oldMult: W, newMult: 3n * W, effectiveAt: 2000 }),
    ]);
    expect(h.points.map((p) => [p.effectiveAt, p.multiplier])).toEqual([[2000, 3n * W]]);
    expect(h.points[0]!.kind).toBe("instant");
    expect(multiplierAt(h, 6000).multiplier).toBe(3n * W);
  });

  it("orders by effectiveAt and is order-independent of input array", () => {
    const a = ev({ kind: "updated", blockNumber: 1, newMult: 2n * W, effectiveAt: 3000 });
    const b = ev({ kind: "updated", blockNumber: 5, oldMult: 2n * W, newMult: 4n * W, effectiveAt: 9000 });
    expect(canonicalHistory([b, a])).toEqual(canonicalHistory([a, b]));
  });

  it("reverse split and baseline", () => {
    const h = canonicalHistory([ev({ kind: "updated", blockNumber: 1, oldMult: 4n * W, newMult: W / 2n, effectiveAt: 5000 })]);
    expect(h.baseline).toBe(4n * W);
    expect(multiplierAt(h, 0).multiplier).toBe(4n * W);
    expect(multiplierAt(h, 5000).multiplier).toBe(W / 2n);
  });

  it("empty history is unknown", () => {
    const h = canonicalHistory([]);
    expect(multiplierAt(h, 123)).toEqual({ multiplier: null, known: false });
  });

  it("pendingAt finds the future point", () => {
    const h = canonicalHistory([ev({ kind: "updated", blockNumber: 1, newMult: 2n * W, effectiveAt: 5000 })]);
    expect(pendingAt(h, 4000)?.effectiveAt).toBe(5000);
    expect(pendingAt(h, 5000)).toBeNull();
  });
});
