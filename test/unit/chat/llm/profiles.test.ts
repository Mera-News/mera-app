// The default routing table is what every lane uses when the gateway's table has not answered,
// so a wrong entry is invisible until an outage. These pins exist so a change is deliberate.
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import { DEFAULT_TABLE, PROFILES, MODEL_LABELS, firstTokenDeadlineMs } from '@/lib/llm/profiles';
import { LANES } from '@/lib/llm/router/lanes';

describe('profiles and the default table', () => {
  it('ships the three contract profiles with their provider model ids', () => {
    expect(Object.fromEntries(Object.values(PROFILES).map((p) => [p.id, [p.provider, p.model, p.harness]]))).toEqual({
      'near/qwen3.8-27b': ['near', 'Qwen/Qwen3.8-27B', 'qwen3.8-27b'],
      'near/qwen3.6-35b-a3b': ['near', 'Qwen/Qwen3.6-35B-A3B-FP8', 'qwen3.6-35b-a3b'],
      'redpill/qwen3.8-27b': ['redpill', 'qwen/qwen3.8-27b', 'qwen3.8-27b'],
    });
  });

  it('ranks every lane per the contract, every profile once', () => {
    const chat = ['near/qwen3.8-27b', 'near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b'];
    const bulk = ['near/qwen3.6-35b-a3b', 'near/qwen3.8-27b', 'redpill/qwen3.8-27b'];
    expect(DEFAULT_TABLE).toEqual({
      'chat-tools': chat, 'chat-single': chat, 'fact-check': chat,
      scoring: bulk, topics: bulk, background: bulk,
    });
    for (const lane of LANES) expect(new Set(DEFAULT_TABLE[lane]).size).toBe(DEFAULT_TABLE[lane].length);
  });

  it('keeps BIG_MODEL and SMALL_MODEL as aliases of the heads', () => {
    expect(PROFILES[DEFAULT_TABLE['chat-tools'][0]].model).toBe(BIG_MODEL);
    expect(PROFILES[DEFAULT_TABLE.scoring[0]].model).toBe(SMALL_MODEL);
  });

  it('gives chat lanes 30s to a first token and the rest 120s', () => {
    for (const p of Object.values(PROFILES)) {
      expect(firstTokenDeadlineMs(p, 'chat-tools')).toBe(30_000);
      expect(firstTokenDeadlineMs(p, 'fact-check')).toBe(30_000);
      expect(firstTokenDeadlineMs(p, 'scoring')).toBe(120_000);
      expect(MODEL_LABELS[p.harness]).toBeDefined();
    }
  });
});
