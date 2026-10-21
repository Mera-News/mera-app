import {
  averageMs,
  getInferenceStats,
  hasAnyStat,
  recordCompletion,
  recordModelLoad,
  recordRefusal,
  resetInferenceStats,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';

beforeEach(() => resetInferenceStats());

describe('inference stats (in memory only)', () => {
  it('averages labelled calls per label and ignores unlabelled ones', () => {
    recordModelLoad(1234.4);
    recordCompletion({ label: 'relevance', latencyMs: 300 });
    recordCompletion({ label: 'relevance', latencyMs: 500 });
    recordCompletion({ label: 'reason', latencyMs: 2000 });
    recordCompletion({ latencyMs: 99999 }); // chat: not counted

    const s = getInferenceStats();
    expect(s.loadMs).toBe(1234);
    expect(averageMs(s.relevance)).toBe(400);
    expect(averageMs(s.reason)).toBe(2000);
  });

  it('averageMs is null before the first call', () => {
    expect(averageMs(getInferenceStats().relevance)).toBeNull();
  });

  it('a later Kev load replaces the load time and keeps every other reading', () => {
    recordModelLoad(3000);
    recordCompletion({ label: 'relevance', latencyMs: 10 });
    recordCompletion({ label: 'reason', latencyMs: 20 });
    recordModelLoad(2500);
    const s = getInferenceStats();
    expect(s.loadMs).toBe(2500);
    expect(s.relevance.count).toBe(1);
    expect(s.reason.count).toBe(1);
  });

  it('hasAnyStat turns true with the first figure, and reset clears everything', () => {
    expect(hasAnyStat(getInferenceStats())).toBe(false);
    recordModelLoad(100);
    expect(hasAnyStat(getInferenceStats())).toBe(true);
    resetInferenceStats();
    expect(getInferenceStats().loadMs).toBeNull();
    expect(hasAnyStat(getInferenceStats())).toBe(false);
  });
});

describe('refusals', () => {
  it('counts native-engine refusals, which alone make the readout show', () => {
    recordRefusal();
    recordRefusal();
    expect(getInferenceStats().refused).toBe(2);
    expect(hasAnyStat(getInferenceStats())).toBe(true);
  });
});
