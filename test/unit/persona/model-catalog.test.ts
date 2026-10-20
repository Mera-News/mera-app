import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  RELEVANCE_MODEL,
  RETIRED_MODEL_IDS,
  isRetiredModelId,
} from '@/lib/mera-protocol-toolkit/core/model-catalog';

describe('model catalogue', () => {
  it('holds Kev only: the built-in model writes the text (D37)', () => {
    expect(MODEL_CATALOG).toEqual([RELEVANCE_MODEL]);
    expect(RELEVANCE_MODEL).toMatchObject({ modelId: 'mera-kev-4b', sizeBytes: 3_033_489_824 });
  });

  it('every entry downloads a Q4_K_M GGUF pinned to a HuggingFace commit and names its licence', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.modelUrl).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/[^/]+-Q4_K_M\.gguf$/);
      expect(m.licenseName).toBe('Apache 2.0');
      expect(m.licenseUrl).toMatch(/^https:\/\//);
    }
  });

  it('the default is Kev and is not retired', () => {
    expect(DEFAULT_MODEL_ID).toBe(RELEVANCE_MODEL.modelId);
    expect(isRetiredModelId(DEFAULT_MODEL_ID)).toBe(false);
  });

  it('retires the Qwen text model and every earlier model id, and no catalogue id', () => {
    expect(RETIRED_MODEL_IDS).toEqual([
      'mera-qwen3.5-4b-instruct',
      'mera-qwen3.5-4b',
      'mera-qwen3-4b',
      'mera-lfm2.5-2.6b',
      'mera-lfm2-2.6b',
      'mera-qwen3.5-2b',
    ]);
    for (const m of MODEL_CATALOG) expect(isRetiredModelId(m.modelId)).toBe(false);
  });
});
