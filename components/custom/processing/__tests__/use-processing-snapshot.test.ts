// The hook's WIRING only: the visibility predicate, the high-water ref, and
// which store value reaches which snapshot field.
//
// The stage table itself is covered row by row in
// `lib/services/__tests__/processing-stage.test.ts` against the pure function,
// which is the whole reason that function lives in `lib/`. Re-asserting the
// table through a renderer here would test the mocks.
/* eslint-disable @typescript-eslint/no-require-imports */

const flags = {
  schedulerRunning: false,
  isFeedProcessing: false,
  syncState: null as string | null,
  asyncJobPhase: 'idle' as 'idle' | 'relevance' | 'reasons',
  isDeviceProcessing: false,
  chunkStates: null as { chunks: string[]; ready: number; total: number } | null,
  batchProgress: null as { done: number; total: number } | null,
  hydrationCompleted: 0,
  hydrationTotal: 0,
  reduceMotion: false,
  staticGradient: false,
  animationsActive: true,
  lastRunFinishedAt: null as number | null,
};

jest.mock('@/components/custom/FeedSyncIndicator', () => ({
  useFeedSyncRunning: () => flags.schedulerRunning,
  useIsFeedProcessing: () => flags.isFeedProcessing,
}));

jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
  useAnimationsActive: () => flags.animationsActive,
}));

jest.mock('react-native-reanimated', () => ({
  useReducedMotion: () => flags.reduceMotion,
}));

jest.mock('@/lib/stores/display-prefs-store', () => ({
  useDisplayPrefsStore: (sel: (s: { staticGradient: boolean }) => unknown) =>
    sel({ staticGradient: flags.staticGradient }),
}));

jest.mock('@/lib/stores/selectors', () => ({
  useForYouAsyncJobPhase: () => flags.asyncJobPhase,
  useForYouLastProcessingRunFinishedAt: () => flags.lastRunFinishedAt,
  useForYouBatchProgress: () => flags.batchProgress,
  useForYouChunkStates: () => flags.chunkStates,
  useForYouDeviceProcessing: () => ({ isDeviceProcessing: flags.isDeviceProcessing }),
  useForYouHydrationProgress: () => ({
    hydrationCompleted: flags.hydrationCompleted,
    hydrationTotal: flags.hydrationTotal,
  }),
  useForYouSyncStatusMessage: () =>
    flags.syncState ? { state: flags.syncState, headlineKey: 'x' } : null,
}));

import { renderHook } from '@testing-library/react-native';

import {
  _resetProcessingStageMarkForTests,
  useProcessingSnapshot,
} from '../use-processing-snapshot';

const reset = () =>
  Object.assign(flags, {
    schedulerRunning: false,
    isFeedProcessing: false,
    syncState: null,
    asyncJobPhase: 'idle',
    isDeviceProcessing: false,
    chunkStates: null,
    batchProgress: null,
    hydrationCompleted: 0,
    hydrationTotal: 0,
    reduceMotion: false,
    staticGradient: false,
    animationsActive: true,
    lastRunFinishedAt: null,
  });

beforeEach(() => {
  reset();
  // The mark is module-level on purpose (see the hook). Tests have to release
  // it themselves, the way a finished run or an invisible area does.
  _resetProcessingStageMarkForTests();
});

describe('useProcessingSnapshot — the visibility predicate', () => {
  it('is invisible when nothing is running', () => {
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.visible).toBe(false);
    expect(result.current.stage).toBeNull();
  });

  it('is visible on the scheduler flag alone, with no status message', () => {
    // The check that catches building this on syncStatusMessage: the first
    // happy-path publish is `hydrating`, i.e. after two network round trips.
    // `reserveTask` is a synchronous set(), so the flag lights on the same JS
    // tick as the pull and the area appears on the same frame.
    flags.schedulerRunning = true;
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.visible).toBe(true);
    expect(result.current.stage).toBe('fetching');
  });

  it('is visible on isFeedProcessing alone, which is the pipeline-already-running case', () => {
    flags.isFeedProcessing = true;
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.visible).toBe(true);
  });
});

describe('useProcessingSnapshot — the high-water ref', () => {
  it('holds the highest stage reached across renders', () => {
    flags.schedulerRunning = true;
    flags.asyncJobPhase = 'reasons';
    const { result, rerender } = renderHook(() => useProcessingSnapshot());
    expect(result.current.stage).toBe('summarising');

    // hydrating arrives late, or the phase drops out for a tick. Without the
    // ref this reads "downloading" again and the reader watches the app lose
    // its place.
    flags.asyncJobPhase = 'idle';
    flags.syncState = 'hydrating';
    rerender({});
    expect(result.current.stage).toBe('summarising');
  });

  it('releases the mark when the area goes invisible, so the next run starts at the top', () => {
    flags.schedulerRunning = true;
    flags.asyncJobPhase = 'reasons';
    const { result, rerender } = renderHook(() => useProcessingSnapshot());
    expect(result.current.stage).toBe('summarising');

    flags.schedulerRunning = false;
    flags.asyncJobPhase = 'idle';
    rerender({});
    expect(result.current.visible).toBe(false);

    flags.schedulerRunning = true;
    rerender({});
    expect(result.current.stage).toBe('fetching');
  });
});

describe('useProcessingSnapshot — the mark is SHARED, not per mount', () => {
  // The card, the status panel's headline and the panel's chunk row all call
  // this hook in one live run. A per-mount ref gave each its own mark, so a
  // panel opened mid-run started at null and could name a LOWER step than the
  // card was showing at that instant. Same run, two steps, on screen together.
  it('a second surface mounting mid-run inherits the mark rather than starting over', () => {
    flags.schedulerRunning = true;
    flags.asyncJobPhase = 'reasons';
    const card = renderHook(() => useProcessingSnapshot());
    expect(card.result.current.stage).toBe('summarising');

    // The panel opens now, and the phase has just dropped out for a tick.
    flags.asyncJobPhase = 'idle';
    flags.syncState = 'hydrating';
    const panel = renderHook(() => useProcessingSnapshot());
    expect(panel.result.current.stage).toBe('summarising');
  });

  it('a NEW run releases the mark even with every surface unmounted in between', () => {
    // Both callers can be absent across a run boundary: the card renders only
    // on an empty list, the panel only while expanded. Without a run identity
    // nothing would clear the mark and the next run would start part-way down
    // its own bar.
    flags.schedulerRunning = true;
    flags.asyncJobPhase = 'reasons';
    expect(renderHook(() => useProcessingSnapshot()).result.current.stage).toBe('summarising');

    flags.lastRunFinishedAt = 1_700_000_000_000;
    flags.asyncJobPhase = 'idle';
    expect(renderHook(() => useProcessingSnapshot()).result.current.stage).toBe('fetching');
  });
});

describe('useProcessingSnapshot — the numbers it passes through', () => {
  it('reports hydration and article counts separately from chunk counts', () => {
    flags.schedulerRunning = true;
    flags.syncState = 'hydrating';
    flags.hydrationCompleted = 12;
    flags.hydrationTotal = 40;
    flags.batchProgress = { done: 3, total: 9 };
    flags.chunkStates = { chunks: ['ready', 'in-flight'], ready: 1, total: 2 };
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.hydrationCompleted).toBe(12);
    expect(result.current.hydrationTotal).toBe(40);
    expect(result.current.analysedDone).toBe(3);
    expect(result.current.analysedTotal).toBe(9);
    expect(result.current.chunksReady).toBe(1);
    expect(result.current.chunksTotal).toBe(2);
  });

  it('gives the bar a percentage only where the stage has an honest numerator', () => {
    flags.schedulerRunning = true;
    flags.syncState = 'hydrating';
    flags.hydrationCompleted = 10;
    flags.hydrationTotal = 40;
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.stageValue).toBe(25);

    // fetching knows nothing, so it reports 0 rather than inventing a number.
    // A NEW RUN, not just a fresh mount: the mark is shared across surfaces and
    // released by a run boundary, so re-mounting alone would still hold
    // `downloading`, which is the designed behaviour asserted above.
    reset();
    flags.schedulerRunning = true;
    flags.lastRunFinishedAt = 1_700_000_000_001;
    const second = renderHook(() => useProcessingSnapshot());
    expect(second.result.current.stage).toBe('fetching');
    expect(second.result.current.stageValue).toBe(0);
  });

  it('never divides by a zero total', () => {
    flags.schedulerRunning = true;
    flags.syncState = 'hydrating';
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.stageValue).toBe(0);
  });

  it('hands back a stable empty array when there is no run', () => {
    flags.schedulerRunning = true;
    const { result, rerender } = renderHook(() => useProcessingSnapshot());
    const first = result.current.chunks;
    rerender({});
    // Same reference, so a memoised child does not re-render on every tick of
    // a sync that has no batches yet.
    expect(result.current.chunks).toBe(first);
  });
});

describe('useProcessingSnapshot — the two motion gates are separate', () => {
  it('reports isStatic for OS Reduce Motion', () => {
    flags.schedulerRunning = true;
    flags.reduceMotion = true;
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.isStatic).toBe(true);
    expect(result.current.animationsActive).toBe(true);
  });

  it("reports isStatic for the app's own Static background setting", () => {
    flags.schedulerRunning = true;
    flags.staticGradient = true;
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.isStatic).toBe(true);
  });

  it('reports animationsActive separately, for blurred or backgrounded', () => {
    flags.schedulerRunning = true;
    flags.animationsActive = false;
    const { result } = renderHook(() => useProcessingSnapshot());
    expect(result.current.isStatic).toBe(false);
    expect(result.current.animationsActive).toBe(false);
  });
});
