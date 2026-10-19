import {
  averageMs,
  getInferenceStats,
  hasAnyStat,
  recordCompletion,
  recordModelLoad,
  resetInferenceStats,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';

beforeEach(() => resetInferenceStats());

describe('inference stats (in memory only)', () => {
  it('averages labelled calls per label and ignores unlabelled ones', () => {
    recordModelLoad('text', 1234.4);
    recordCompletion({ label: 'relevance', latencyMs: 300 });
    recordCompletion({ label: 'relevance', latencyMs: 500 });
    recordCompletion({ label: 'reason', latencyMs: 2000, promptTokPerSec: 900.6, genTokPerSec: 40.2 });
    recordCompletion({ latencyMs: 99999 }); // chat: tok/s only

    const s = getInferenceStats();
    expect(s.loadMs).toEqual({ text: 1234, relevance: null });
    expect(averageMs(s.relevance)).toBe(400);
    expect(averageMs(s.reason)).toBe(2000);
    expect(s.promptTokPerSec).toBe(901);
    expect(s.genTokPerSec).toBe(40);
  });

  it('averageMs is null before the first call', () => {
    expect(averageMs(getInferenceStats().relevance)).toBeNull();
  });

  it('swapping between the two models keeps every reading, with a load time per model', () => {
    recordModelLoad('relevance', 3000);
    recordCompletion({ label: 'relevance', latencyMs: 10 });
    recordModelLoad('text', 2000);
    recordCompletion({ label: 'reason', latencyMs: 20 });
    recordModelLoad('relevance', 2500);
    const s = getInferenceStats();
    expect(s.loadMs).toEqual({ text: 2000, relevance: 2500 });
    expect(s.relevance.count).toBe(1);
    expect(s.reason.count).toBe(1);
  });

  it('hasAnyStat turns true with the first figure, and reset clears everything', () => {
    expect(hasAnyStat(getInferenceStats())).toBe(false);
    recordModelLoad('relevance', 100);
    expect(hasAnyStat(getInferenceStats())).toBe(true);
    resetInferenceStats();
    expect(getInferenceStats().loadMs).toEqual({ text: null, relevance: null });
    expect(hasAnyStat(getInferenceStats())).toBe(false);
  });
});
