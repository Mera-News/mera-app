// The on-device model catalogue: which GGUF models a user may choose from in
// Mera Protocol settings, and which ids are retired.
//
// Pure data with no imports, so the Zustand store can take its default from here
// without an import cycle through modelManager (which imports the store).
//
// Both architectures (`lfm2`, `qwen35`) are registered in the llama.cpp that
// llama.rn 0.12.9 vendors (`node_modules/llama.rn/cpp/llama-arch.cpp`), so this
// list ships over the air. A model on a new architecture needs that check first.

export type ModelCatalogEntry = {
  modelId: string;
  /** Proper noun, never translated. */
  label: string;
  modelUrl: string;
  /** Empty by decision D5: size plus GGUF header validation, no whole-file digest. */
  expectedChecksum: string;
  sizeLabel: string;
  /** Proper noun, never translated. */
  licenseName: string;
  licenseUrl: string;
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    modelId: 'mera-lfm2.5-2.6b',
    label: 'LFM2.5 2.6B',
    modelUrl:
      'https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/resolve/main/LFM2.5-2.6B-Q4_K_M.gguf',
    expectedChecksum: '',
    sizeLabel: '~1.7GB',
    // Commercial use is licensed below USD 10M annual revenue; the licence must
    // be provided to recipients, which the settings row does by linking it.
    licenseName: 'LFM Open License v1.0',
    licenseUrl: 'https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/blob/main/LICENSE',
  },
  {
    modelId: 'mera-qwen3.5-2b',
    label: 'Qwen3.5 2B',
    modelUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    expectedChecksum: '',
    sizeLabel: '~1.3GB',
    licenseName: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE',
  },
];

/** Pre-selected row only. The user picks either model before downloading. */
export const DEFAULT_MODEL_ID = 'mera-qwen3.5-2b';

/**
 * Ids no longer offered. A persisted selection naming one is remapped to the
 * default at hydrate, and its files are deleted at boot (`retire-models.ts`).
 */
export const RETIRED_MODEL_IDS: readonly string[] = ['mera-qwen3.5-4b', 'mera-qwen3-4b'];

export function isRetiredModelId(modelId: string): boolean {
  return RETIRED_MODEL_IDS.includes(modelId);
}

/** The entry for `modelId`, or the default entry when the id is unknown or retired. */
export function catalogEntry(modelId: string): ModelCatalogEntry {
  return (
    MODEL_CATALOG.find((m) => m.modelId === modelId) ??
    MODEL_CATALOG.find((m) => m.modelId === DEFAULT_MODEL_ID)!
  );
}
