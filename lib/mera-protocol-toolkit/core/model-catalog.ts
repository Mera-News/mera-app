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
  /**
   * Whether llama.rn's `json_object` grammar works with this model's tokenizer.
   * In the llama.cpp llama.rn 0.12.9 vendors it does NOT for the LFM family:
   * the grammar either fails to initialise ("Failed to initialize samplers") or
   * constrains the model to an empty `{}`. Where false, inference sends no
   * grammar and relies on the prompt asking for JSON.
   */
  jsonGrammar: boolean;
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    // LFM2, NOT LFM2.5: LFM2.5-2.6B is a reasoning-only model whose chat
    // template always opens the answer with `<think>` and ignores
    // `enable_thinking: false`, so chat printed its reasoning and the 24-token
    // relevance call never reached an answer. LFM2-2.6B is the non-reasoning
    // instruct model of the same size and licence.
    modelId: 'mera-lfm2-2.6b',
    label: 'LFM2 2.6B',
    modelUrl: 'https://huggingface.co/LiquidAI/LFM2-2.6B-GGUF/resolve/main/LFM2-2.6B-Q4_K_M.gguf',
    expectedChecksum: '',
    sizeLabel: '~1.6GB',
    // Commercial use is licensed below USD 10M annual revenue; the licence must
    // be provided to recipients, which the settings row does by linking it.
    licenseName: 'LFM Open License v1.0',
    licenseUrl: 'https://huggingface.co/LiquidAI/LFM2-2.6B-GGUF/blob/main/LICENSE',
    jsonGrammar: false,
  },
  {
    modelId: 'mera-qwen3.5-2b',
    label: 'Qwen3.5 2B',
    modelUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    expectedChecksum: '',
    sizeLabel: '~1.3GB',
    licenseName: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE',
    jsonGrammar: true,
  },
];

/** Pre-selected row only. The user picks either model before downloading. */
export const DEFAULT_MODEL_ID = 'mera-qwen3.5-2b';

/**
 * Ids no longer offered. A persisted selection naming one is remapped to the
 * default at hydrate, and its files are deleted at boot (`retire-models.ts`).
 */
export const RETIRED_MODEL_IDS: readonly string[] = [
  'mera-qwen3.5-4b',
  'mera-qwen3-4b',
  // Reasoning-only; see the LFM2 entry above.
  'mera-lfm2.5-2.6b',
];

export function isRetiredModelId(modelId: string): boolean {
  return RETIRED_MODEL_IDS.includes(modelId);
}

/**
 * Whether a JSON grammar may be applied for `modelId`. Unknown or retired ids
 * answer false: sending no grammar is the safe side, since every local prompt
 * that wants JSON also says so in words.
 */
export function supportsJsonGrammar(modelId: string | null | undefined): boolean {
  return MODEL_CATALOG.find((m) => m.modelId === modelId)?.jsonGrammar ?? false;
}

/** The entry for `modelId`, or the default entry when the id is unknown or retired. */
export function catalogEntry(modelId: string): ModelCatalogEntry {
  return (
    MODEL_CATALOG.find((m) => m.modelId === modelId) ??
    MODEL_CATALOG.find((m) => m.modelId === DEFAULT_MODEL_ID)!
  );
}
