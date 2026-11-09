/**
 * Canonical effective multiplier history, computed the way the Base docs prescribe:
 * replay UIMultiplierUpdated events, drop the ones later cancelled, date each by effectiveAtTimestamp.
 */
export interface MultEvent {
  kind: "updated" | "cancelled";
  blockNumber: number;
  logIndex: number;
  blockTimestamp: number;
  oldMult: bigint; // updated: oldMultiplier;  cancelled: unused
  newMult: bigint; // updated: newMultiplier;  cancelled: cancelledMultiplier
  effectiveAt: number; // updated: effectiveAtTimestamp; cancelled: cancelledEffectiveAt
}

export interface HistoryPoint {
  effectiveAt: number; // unix seconds the multiplier takes effect
  multiplier: bigint;
  oldMultiplier: bigint;
  scheduledAtBlock: number;
  kind: "instant" | "scheduled";
}

export interface CanonicalHistory {
  /** multiplier before the first observed change (from that event's oldMultiplier), if any event exists */
  baseline: bigint | null;
  points: HistoryPoint[]; // sorted by effectiveAt ascending, cancelled removed
}

export function canonicalHistory(events: MultEvent[]): CanonicalHistory {
  const ordered = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const live: HistoryPoint[] = [];
  let baseline: bigint | null = null;
  for (const e of ordered) {
    if (e.kind === "updated") {
      if (baseline === null) baseline = e.oldMult;
      live.push({
        effectiveAt: e.effectiveAt,
        multiplier: e.newMult,
        oldMultiplier: e.oldMult,
        scheduledAtBlock: e.blockNumber,
        kind: e.effectiveAt > e.blockTimestamp ? "scheduled" : "instant",
      });
    } else {
      // remove the most recent matching pending update
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i]!;
        if (p.multiplier === e.newMult && p.effectiveAt === e.effectiveAt && p.kind === "scheduled") {
          live.splice(i, 1);
          break;
        }
      }
    }
  }
  live.sort((a, b) => a.effectiveAt - b.effectiveAt || a.scheduledAtBlock - b.scheduledAtBlock);
  return { baseline, points: live };
}

/** Multiplier in force at `t`; `known:false` if t precedes all information (no events at all). */
export function multiplierAt(h: CanonicalHistory, t: number): { multiplier: bigint | null; known: boolean } {
  let cur: bigint | null = h.baseline;
  for (const p of h.points) {
    if (p.effectiveAt <= t) cur = p.multiplier;
    else break;
  }
  return { multiplier: cur, known: cur !== null };
}

/** The not-yet-effective point, if any (at most one live pending exists onchain). */
export function pendingAt(h: CanonicalHistory, now: number): HistoryPoint | null {
  return h.points.find((p) => p.effectiveAt > now) ?? null;
}
