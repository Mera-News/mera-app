// The on-device model catalogue: the one downloadable model "On this phone"
// runs, and the ids that are retired.
//
//   RELEVANCE  Kev, a decision model: pass-1 relevance and the chat decisions,
//              through llama.rn's `context.decide()`. llama.rn refuses
//              `completion()` on it.
//
// The text (chat, notes, topics) is written by the phone's built-in model,
// Apple Intelligence or Gemini Nano, which needs no download (text-engine.ts,
// D37). llama.rn holds Kev only.
//
// Pure data with no imports, so the Zustand store can take its default from here
// without an import cycle through modelManager (which imports the store).
//
// URLs are pinned to a HuggingFace commit, so a re-upload upstream cannot change
// the bytes behind an id. `decide()` first shipped in llama.rn 0.13.0-rc.7, so
// this catalogue needs that native build; it can never ship over the air.

export type ModelCatalogEntry = {
  modelId: string;
  /** Proper noun, never translated, never shown in the UI. */
  label: string;
  modelUrl: string;
  /** Exact byte size of the GGUF. A download of any other size is damaged. */
  sizeBytes: number;
  /** Proper noun, never translated. */
  licenseName: string;
  licenseUrl: string;
};

export const RELEVANCE_MODEL: ModelCatalogEntry = {
  modelId: 'mera-kev-4b',
  label: 'Kev 4B',
  // ggml-org/Kev-4B-GGUF at commit d924f2e2 (2026-10-01).
  modelUrl:
    'https://huggingface.co/ggml-org/Kev-4B-GGUF/resolve/d924f2e2c3872da8b8aaf3eb4453b4126deceb79/Kev-4B-Q4_K_M.gguf',
  sizeBytes: 3_033_489_824,
  licenseName: 'Apache 2.0',
  licenseUrl: 'https://huggingface.co/jaredpalmer/kev-4b',
};

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [RELEVANCE_MODEL];

/**
 * The store's `selectedModelId` default and the remap target for a retired id.
 * Nothing chooses a model any more; the field is a dead mirror kept so the
 * store needs no change.
 */
export const DEFAULT_MODEL_ID = RELEVANCE_MODEL.modelId;

/**
 * Ids no longer offered. A persisted selection naming one is remapped to the
 * default at hydrate, and its files are deleted at boot for every reader
 * (`retire-models.ts` on this phone, `purgeStaleModels` otherwise).
 * `mera-qwen3.5-4b-instruct` is the downloadable text model, retired by D37.
 */
export const RETIRED_MODEL_IDS: readonly string[] = [
  'mera-qwen3.5-4b-instruct',
  'mera-qwen3.5-4b',
  'mera-qwen3-4b',
  'mera-lfm2.5-2.6b',
  'mera-lfm2-2.6b',
  'mera-qwen3.5-2b',
];

export function isRetiredModelId(modelId: string): boolean {
  return RETIRED_MODEL_IDS.includes(modelId);
}
