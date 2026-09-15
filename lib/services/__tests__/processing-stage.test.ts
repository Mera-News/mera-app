import {
  PROCESSING_STAGE_IDS,
  processingStageIndex,
  resolveProcessingStage,
  type ProcessingStageInput,
} from '../processing-stage';

const base: ProcessingStageInput = {
  syncState: null,
  schedulerRunning: false,
  isFeedProcessing: false,
  asyncJobPhase: 'idle',
  isDeviceProcessing: false,
  chunks: null,
  previousStage: null,
};

const at = (over: Partial<ProcessingStageInput>) =>
  resolveProcessingStage({ ...base, ...over });

describe('resolveProcessingStage — the stage table, row by row', () => {
  it('shows nothing when nothing is happening', () => {
    expect(at({})).toBeNull();
    expect(at({ syncState: 'idle' })).toBeNull();
    expect(at({ syncState: 'done' })).toBeNull();
    expect(at({ syncState: 'failed' })).toBeNull();
    expect(at({ syncState: 'paused-offline' })).toBeNull();
  });

  it('fetching: the sync machine is looking for ids, or diffing them', () => {
    expect(at({ syncState: 'fetching-topic-ids', schedulerRunning: true })).toBe('fetching');
    expect(at({ syncState: 'diffing', schedulerRunning: true })).toBe('fetching');
  });

  it('downloading: hydrating', () => {
    expect(at({ syncState: 'hydrating', schedulerRunning: true })).toBe('downloading');
  });

  it('grouping: a run exists and every live batch is still queued', () => {
    expect(at({ chunks: ['queued', 'queued'] })).toBe('grouping');
    // Already-terminal batches do not stop it being the grouping window: the
    // gate re-elects held-back siblings into new queued batches behind them.
    expect(at({ chunks: ['ready', 'queued', 'failed'] })).toBe('grouping');
  });

  it('is NOT grouping once anything has been submitted', () => {
    expect(at({ chunks: ['queued', 'in-flight'] })).not.toBe('grouping');
    expect(at({ chunks: [] })).not.toBe('grouping');
    expect(at({ chunks: null })).not.toBe('grouping');
  });

  it('analysing: cloud relevance, or on-device scoring, or the scoring state', () => {
    expect(at({ asyncJobPhase: 'relevance' })).toBe('analysing');
    expect(at({ isDeviceProcessing: true })).toBe('analysing');
    expect(at({ syncState: 'scoring', schedulerRunning: true })).toBe('analysing');
  });

  it('summarising: the reasons round', () => {
    expect(at({ asyncJobPhase: 'reasons' })).toBe('summarising');
  });

  it('preparing: work is still in flight but no named stage owns it', () => {
    expect(at({ syncState: 'done', isFeedProcessing: true })).toBe('preparing');
    expect(at({ syncState: 'done', schedulerRunning: true })).toBe('preparing');
  });

  it('scoring outranks the sync machine, which can say done while notes are written', () => {
    expect(at({ syncState: 'done', asyncJobPhase: 'reasons' })).toBe('summarising');
    expect(at({ syncState: 'hydrating', asyncJobPhase: 'relevance' })).toBe('analysing');
  });
});

describe('resolveProcessingStage — the scheduler flag is a first-class input', () => {
  // The single likeliest way to build this feature and have it not appear. The
  // first happy-path publish is `hydrating`, i.e. after two network round trips
  // and the diff, and it is skipped entirely on the `missingIds.length === 0`
  // branch. A resolver reading only the message shows up seconds late or never.
  it('resolves to fetching on the scheduler flag alone, with no message yet', () => {
    expect(at({ schedulerRunning: true })).toBe('fetching');
  });

  it('still resolves when the message never arrives at all', () => {
    // missingIds.length === 0: nothing to hydrate, so the machine publishes
    // nothing, and the flag is the only evidence a pull happened.
    expect(at({ schedulerRunning: true, syncState: null })).toBe('fetching');
    expect(at({ isFeedProcessing: true, syncState: null })).toBe('preparing');
  });
});

describe('resolveProcessingStage — the monotonic high-water mark', () => {
  it('never walks backwards when a signal drops out mid-run', () => {
    // hydrating clears before the pipeline publishes relevance. Without the
    // mark this reads "downloading" again, which looks like the app losing its
    // place.
    expect(at({ previousStage: 'analysing', syncState: 'hydrating' })).toBe('analysing');
    expect(at({ previousStage: 'summarising', asyncJobPhase: 'relevance' })).toBe(
      'summarising',
    );
  });

  it('still moves forward', () => {
    expect(at({ previousStage: 'downloading', asyncJobPhase: 'reasons' })).toBe(
      'summarising',
    );
  });

  it('holds equal', () => {
    expect(at({ previousStage: 'analysing', asyncJobPhase: 'relevance' })).toBe('analysing');
  });

  it('releases the mark by going null, so the next run starts from the top', () => {
    expect(at({ previousStage: 'summarising' })).toBeNull();
  });
});

describe("resolveProcessingStage — `persisting` is dead and stays dead", () => {
  // feed-sync-types: hydrate, persist and enqueue are merged into `hydrating`
  // and the machine never transitions into `persisting`. It is kept in the
  // switch for exhaustiveness only, so this pins that it has no stage of its
  // own rather than pretending a user can reach it.
  it('maps to downloading rather than to a stage of its own', () => {
    expect(at({ syncState: 'persisting', schedulerRunning: true })).toBe('downloading');
  });
});

describe('processingStageIndex', () => {
  it('orders the six stages as the progress bar draws them', () => {
    expect(PROCESSING_STAGE_IDS.map(processingStageIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
