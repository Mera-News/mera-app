import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  RELEVANCE_MODEL,
  RETIRED_MODEL_IDS,
  TEXT_MODEL,
  isRetiredModelId,
  supportsJsonGrammar,
} from '@/lib/mera-protocol-toolkit/core/model-catalog';

describe('model catalogue', () => {
  it('holds exactly the two on-device models, text first (the download order)', () => {
    expect(MODEL_CATALOG).toEqual([TEXT_MODEL, RELEVANCE_MODEL]);
    expect(TEXT_MODEL).toMatchObject({ modelId: 'mera-qwen3.5-4b-instruct', role: 'text', sizeBytes: 2_740_937_888 });
    expect(RELEVANCE_MODEL).toMatchObject({ modelId: 'mera-kev-4b', role: 'relevance', sizeBytes: 3_033_489_824 });
  });

  it('every entry downloads a Q4_K_M GGUF pinned to a HuggingFace commit and names its licence', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.modelUrl).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/[^/]+-Q4_K_M\.gguf$/);
      expect(m.licenseName).toBe('Apache 2.0');
      expect(m.licenseUrl).toMatch(/^https:\/\//);
    }
  });

  it('the default is the text model and is not retired', () => {
    expect(DEFAULT_MODEL_ID).toBe(TEXT_MODEL.modelId);
    expect(isRetiredModelId(DEFAULT_MODEL_ID)).toBe(false);
  });

  it('retires every earlier model id, and no catalogue id', () => {
    expect(RETIRED_MODEL_IDS).toEqual([
      'mera-qwen3.5-4b',
      'mera-qwen3-4b',
      'mera-lfm2.5-2.6b',
      'mera-lfm2-2.6b',
      'mera-qwen3.5-2b',
    ]);
    for (const m of MODEL_CATALOG) expect(isRetiredModelId(m.modelId)).toBe(false);
  });

  it('the JSON grammar is on for the text model only, and off for anything unknown', () => {
    expect(supportsJsonGrammar(TEXT_MODEL.modelId)).toBe(true);
    expect(supportsJsonGrammar(RELEVANCE_MODEL.modelId)).toBe(false);
    expect(supportsJsonGrammar('mera-qwen3.5-2b')).toBe(false);
    expect(supportsJsonGrammar(null)).toBe(false);
  });
});
