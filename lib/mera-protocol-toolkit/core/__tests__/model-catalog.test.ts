import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  RETIRED_MODEL_IDS,
  catalogEntry,
  isRetiredModelId,
} from '../model-catalog';

describe('model catalogue', () => {
  it('offers exactly the two small models', () => {
    expect(MODEL_CATALOG.map((m) => m.modelId)).toEqual(['mera-lfm2.5-2.6b', 'mera-qwen3.5-2b']);
  });

  it('every entry downloads a Q4_K_M GGUF from a resolve/main URL and names its licence', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.modelUrl).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/main\/[^/]+-Q4_K_M\.gguf$/);
      expect(m.licenseName.length).toBeGreaterThan(0);
      expect(m.licenseUrl).toMatch(/^https:\/\//);
    }
  });

  it('the default is in the catalogue and is not retired', () => {
    expect(MODEL_CATALOG.some((m) => m.modelId === DEFAULT_MODEL_ID)).toBe(true);
    expect(isRetiredModelId(DEFAULT_MODEL_ID)).toBe(false);
  });

  it('retires both old Qwen 4B ids and no catalogue id', () => {
    expect(RETIRED_MODEL_IDS).toEqual(['mera-qwen3.5-4b', 'mera-qwen3-4b']);
    for (const m of MODEL_CATALOG) expect(isRetiredModelId(m.modelId)).toBe(false);
  });

  it('catalogEntry falls back to the default for a retired or unknown id', () => {
    expect(catalogEntry('mera-lfm2.5-2.6b').modelId).toBe('mera-lfm2.5-2.6b');
    expect(catalogEntry('mera-qwen3.5-4b').modelId).toBe(DEFAULT_MODEL_ID);
    expect(catalogEntry('nonsense').modelId).toBe(DEFAULT_MODEL_ID);
  });
});
