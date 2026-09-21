import {
  HEADER_STAGE_POOL_IDS,
  advanceHeaderNarrationRun,
  headerStagePool,
  resolveHeaderNarration,
  startHeaderNarrationRun,
  type HeaderNarrationRun,
} from '../header-narration';
import { PROCESSING_STAGE_IDS } from '../processing-stage';

/** One tick, with the boring arguments defaulted. */
function at(
  tick: number,
  over: Partial<Parameters<typeof resolveHeaderNarration>[0]> = {},
) {
  return resolveHeaderNarration({
    tick,
    stageStartTick: 0,
    stage: 'fetching',
    onDevice: false,
    nudgeSeed: 0,
    ...over,
  });
}

describe('resolveHeaderNarration — the alternation', () => {
  it('opens on a STAGE slot, so the first thing after the title vanishes says why', () => {
    expect(at(0).kind).toBe('stage');
  });

  it('alternates stage, nudge, stage, nudge over a long run', () => {
    const kinds = Array.from({ length: 12 }, (_, t) => at(t).kind);
    expect(kinds).toEqual([
      'stage', 'nudge', 'stage', 'nudge', 'stage', 'nudge',
      'stage', 'nudge', 'stage', 'nudge', 'stage', 'nudge',
    ]);
  });

  it('sends every nudge slot to the one nudge pool', () => {
    for (const t of [1, 3, 5, 99]) expect(at(t).poolId).toBe('nudges');
  });
});

describe('resolveHeaderNarration — which pool a stage slot draws from', () => {
  it('falls back to `starting` when no stage has resolved yet', () => {
    // The row is height-pinned, so a null here would paint a blank box.
    expect(at(0, { stage: null }).poolId).toBe('starting');
    expect(at(0, { stage: null, onDevice: true }).poolId).toBe('starting');
  });

  it('maps each pipeline stage to its own pool', () => {
    for (const stage of PROCESSING_STAGE_IDS) {
      expect(at(0, { stage }).poolId).toBe(stage);
    }
  });

  it('overrides `analysing` with `onDevice`, and overrides NOTHING else', () => {
    expect(at(0, { stage: 'analysing', onDevice: true }).poolId).toBe('onDevice');
    for (const stage of PROCESSING_STAGE_IDS) {
      if (stage === 'analysing') continue;
      expect(at(0, { stage, onDevice: true }).poolId).toBe(stage);
    }
  });

  it('every pool a stage slot can name is declared in HEADER_STAGE_POOL_IDS', () => {
    // Guards the registry's exhaustiveness check from the other side: a stage
    // added to the pipeline with no pool here would otherwise surface as a
    // missing i18n key at runtime.
    const reachable = new Set<string>(['starting']);
    for (const stage of PROCESSING_STAGE_IDS) {
      reachable.add(headerStagePool(stage, false));
      reachable.add(headerStagePool(stage, true));
    }
    expect([...reachable].sort()).toEqual([...HEADER_STAGE_POOL_IDS].sort());
  });
});

describe('resolveHeaderNarration — the cursors', () => {
  it('opens a new stage on its own FIRST line', () => {
    expect(at(0, { stageStartTick: 0 }).cursor).toBe(0);
    expect(at(6, { stageStartTick: 6 }).cursor).toBe(0);
  });

  it('advances the stage cursor once per stage slot, not once per tick', () => {
    // Slots 0,2,4,6 are the stage slots of a run whose stage began at tick 0.
    expect([0, 2, 4, 6].map((t) => at(t, { stageStartTick: 0 }).cursor)).toEqual([0, 1, 2, 3]);
  });

  it('advances the nudge cursor once per nudge slot', () => {
    expect([1, 3, 5, 7].map((t) => at(t).cursor)).toEqual([0, 1, 2, 3]);
  });

  it('offsets the nudge cursor by the seed, so every run does not open on the same nudge', () => {
    expect(at(1, { nudgeSeed: 4 }).cursor).toBe(4);
    expect(at(3, { nudgeSeed: 4 }).cursor).toBe(5);
  });

  it('never returns a negative cursor, even for a stageStartTick ahead of tick', () => {
    // A caller should never produce this. The function is total anyway, because
    // a negative index into a pool is a crash rather than a wrong sentence.
    expect(at(2, { stageStartTick: 10 }).cursor).toBe(0);
  });
});

// ── THE DELIBERATE DIVERGENCE ───────────────────────────────────────────────
// Both precedents (`processing-stages`, `chat-phases`) reset their cursor when
// the pool changes. This one resets the STAGE cursor only. These two tests are
// the whole reason, and a future "fix" that makes parity stage-scoped fails
// both of them rather than silently deleting the nudges.

describe('the nudge cursor and the parity are RUN-scoped, not stage-scoped', () => {
  it('does not rewind the nudge cursor when the stage changes under it', () => {
    // Same tick, same seed, wildly different stage start: the nudge is identical.
    const early = at(7, { stageStartTick: 0 });
    const justChanged = at(7, { stageStartTick: 6 });
    expect(early.kind).toBe('nudge');
    expect(justChanged.kind).toBe('nudge');
    expect(justChanged.cursor).toBe(early.cursor);
  });

  it('still shows nudges on a run that walks three stages in six slots', () => {
    // The failure this exists to prevent: with stage-scoped parity, each stage
    // restarts at its own tick 0, every slot is even, and the reader is never
    // shown a single nudge for the whole run.
    let run = startHeaderNarrationRun('fetching', false, 0);
    const walk: (typeof PROCESSING_STAGE_IDS)[number][] = [
      'fetching', 'downloading', 'downloading', 'grouping', 'grouping', 'analysing',
    ];
    const kinds = walk.map((stage, i) => {
      if (i > 0) run = advanceHeaderNarrationRun(run, stage, false);
      return resolveHeaderNarration({
        tick: run.tick,
        stageStartTick: run.stageStartTick,
        stage,
        onDevice: false,
        nudgeSeed: run.nudgeSeed,
      }).kind;
    });
    expect(kinds.filter((k) => k === 'nudge').length).toBeGreaterThan(0);
    expect(kinds).toEqual(['stage', 'nudge', 'stage', 'nudge', 'stage', 'nudge']);
  });
});

describe('advanceHeaderNarrationRun', () => {
  const run0: HeaderNarrationRun = startHeaderNarrationRun('fetching', false, 2);

  it('starts at tick 0 with the stage cursor at its origin', () => {
    expect(run0).toEqual({ tick: 0, stageStartTick: 0, pool: 'fetching', nudgeSeed: 2 });
  });

  it('advances the tick and leaves stageStartTick alone while the pool holds', () => {
    const r1 = advanceHeaderNarrationRun(run0, 'fetching', false);
    expect(r1).toEqual({ tick: 1, stageStartTick: 0, pool: 'fetching', nudgeSeed: 2 });
  });

  it('restarts stageStartTick at the tick the pool changed on', () => {
    let r = advanceHeaderNarrationRun(run0, 'fetching', false);
    r = advanceHeaderNarrationRun(r, 'downloading', false);
    expect(r).toEqual({ tick: 2, stageStartTick: 2, pool: 'downloading', nudgeSeed: 2 });
  });

  it('treats a flip to on-device DURING analysing as a pool change', () => {
    // Compared on the resolved POOL, not the raw stage. Comparing stages would
    // hold the cursor across the flip and drop the reader into the middle of a
    // pool whose first line they never saw.
    const analysing = advanceHeaderNarrationRun(run0, 'analysing', false);
    const flipped = advanceHeaderNarrationRun(analysing, 'analysing', true);
    expect(flipped.pool).toBe('onDevice');
    expect(flipped.stageStartTick).toBe(flipped.tick);
  });

  it('does not restart on a stage change that resolves to the same pool', () => {
    // `null` and a null-equivalent both resolve to `starting`.
    const started = startHeaderNarrationRun(null, false, 0);
    const still = advanceHeaderNarrationRun(started, null, true);
    expect(still.stageStartTick).toBe(0);
    expect(still.tick).toBe(1);
  });

  it('never rewinds the tick, so the nudge cursor only ever moves forward', () => {
    let r = startHeaderNarrationRun(null, false, 0);
    const ticks: number[] = [];
    for (const stage of [null, 'fetching', 'fetching', 'grouping', null, 'preparing'] as const) {
      r = advanceHeaderNarrationRun(r, stage, false);
      ticks.push(r.tick);
    }
    expect(ticks).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
