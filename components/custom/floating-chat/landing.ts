// Which step rows land (glyph, then the tick draws) and when. Pure.
//
// A row lands only when it turns `done` while the box is on screen. The box
// takes a BASELINE of every row id at mount, so a reopened chat (ChatPopover
// unmounts on close), a resumed thread or a reopened fold shows ticks only and
// never replays a landing.

export const LANDING_MS = 800;
export const LANDING_STAGGER_MS = 120;

export interface LandingPlan {
  /** Row id -> delay before its landing starts. */
  delays: ReadonlyMap<string, number>;
  /** How long the strip must rest: until the last landing finishes. 0 = none. */
  totalMs: number;
}

export function landingPlan(
  seen: ReadonlySet<string>,
  steps: readonly { id: string; status: 'pending' | 'done' | 'error' }[],
): LandingPlan {
  const fresh = steps.filter((s) => s.status === 'done' && !seen.has(s.id));
  const delays = new Map(fresh.map((s, i) => [s.id, i * LANDING_STAGGER_MS] as const));
  return {
    delays,
    totalMs: fresh.length === 0 ? 0 : LANDING_MS + LANDING_STAGGER_MS * (fresh.length - 1),
  };
}
