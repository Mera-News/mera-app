import {
  averageMs,
  getInferenceStats,
  recordCompletion,
  recordModelLoad,
  resetInferenceStats,
} from '../inference-stats';

beforeEach(() => resetInferenceStats());

describe('inference stats (in memory only)', () => {
  it('averages labelled calls per label and ignores unlabelled ones', () => {
    recordModelLoad('m', 1234.4);
    recordCompletion({ label: 'relevance', latencyMs: 300, promptTokPerSec: 900.6, genTokPerSec: 40.2 });
    recordCompletion({ label: 'relevance', latencyMs: 500 });
    recordCompletion({ label: 'reason', latencyMs: 2000 });
    recordCompletion({ latencyMs: 99999 }); // chat: tok/s only

    const s = getInferenceStats();
    expect(s.loadMs).toBe(1234);
    expect(averageMs(s.relevance)).toBe(400);
    expect(averageMs(s.reason)).toBe(2000);
    expect(s.promptTokPerSec).toBe(901);
    expect(s.genTokPerSec).toBe(40);
  });

  it('averageMs is null before the first call', () => {
    expect(averageMs(getInferenceStats().relevance)).toBeNull();
  });

  it('loading a different model starts a fresh reading', () => {
    recordModelLoad('a', 100);
    recordCompletion({ label: 'reason', latencyMs: 10 });
    recordModelLoad('b', 200);
    const s = getInferenceStats();
    expect(s.modelId).toBe('b');
    expect(s.reason.count).toBe(0);
  });

  it('reloading the same model keeps its averages', () => {
    recordModelLoad('a', 100);
    recordCompletion({ label: 'reason', latencyMs: 10 });
    recordModelLoad('a', 150);
    expect(getInferenceStats().reason.count).toBe(1);
    expect(getInferenceStats().loadMs).toBe(150);
  });

  it('reset clears everything', () => {
    recordModelLoad('a', 100);
    resetInferenceStats();
    expect(getInferenceStats().modelId).toBeNull();
  });
});
