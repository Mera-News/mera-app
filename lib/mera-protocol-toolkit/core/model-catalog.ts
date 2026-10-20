// The on-device model catalogue: the two downloadable models "On this phone"
// runs, and the ids that are retired. Kev is always needed; the text model only
// when it is the chosen text engine (text-engine.ts), since the phone's built-in
// model can write the text instead.
//
//   TEXT       every generative job: chat, notes (reasons), topic generation.
//   RELEVANCE  Kev, a decision model: pass-1 relevance through llama.rn's
//              `context.decide()`. llama.rn refuses `completion()` on it.
//
// Only one is ever loaded (modelManager swaps them inside the llama lock).
//
// Pure data with no imports, so the Zustand store can take its default from here
// without an import cycle through modelManager (which imports the store).
//
// URLs are pinned to a HuggingFace commit, so a re-upload upstream cannot change
// the bytes behind an id. `decide()` first shipped in llama.rn 0.13.0-rc.7, so
// this catalogue needs that native build; it can never ship over the air.

export type ModelRole = 'text' | 'relevance';

export type ModelCatalogEntry = {
  modelId: string;
  role: ModelRole;
  /** Proper noun, never translated. */
  label: string;
  modelUrl: string;
  /** Exact byte size of the GGUF. A download of any other size is damaged. */
  sizeBytes: number;
  /** Proper noun, never translated. */
  licenseName: string;
  licenseUrl: string;
  /** Whether llama.rn's `json_object` grammar works with this model's tokenizer. */
  jsonGrammar: boolean;
};

export const TEXT_MODEL: ModelCatalogEntry = {
  modelId: 'mera-qwen3.5-4b-instruct',
  role: 'text',
  label: 'Qwen3.5 4B',
  // unsloth/Qwen3.5-4B-GGUF at commit e87f1764 (2026-03-02). The local prompts in
  // lib/news-harness/prompts were written for exactly this file.
  modelUrl:
    'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf',
  sizeBytes: 2_740_937_888,
  licenseName: 'Apache 2.0',
  licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE',
  jsonGrammar: true,
};

export const RELEVANCE_MODEL: ModelCatalogEntry = {
  modelId: 'mera-kev-4b',
  role: 'relevance',
  label: 'Kev 4B',
  // ggml-org/Kev-4B-GGUF at commit d924f2e2 (2026-10-01).
  modelUrl:
    'https://huggingface.co/ggml-org/Kev-4B-GGUF/resolve/d924f2e2c3872da8b8aaf3eb4453b4126deceb79/Kev-4B-Q4_K_M.gguf',
  sizeBytes: 3_033_489_824,
  licenseName: 'Apache 2.0',
  licenseUrl: 'https://huggingface.co/jaredpalmer/kev-4b',
  jsonGrammar: false,
};

/** Download order: text first, then Kev. */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [TEXT_MODEL, RELEVANCE_MODEL];

/**
 * The store's `selectedModelId` default and the remap target for a retired id.
 * Nothing chooses a model any more; the field is a dead mirror kept so the
 * store needs no change.
 */
export const DEFAULT_MODEL_ID = TEXT_MODEL.modelId;

/**
 * Ids no longer offered. A persisted selection naming one is remapped to the
 * default at hydrate, and its files are deleted at boot (`retire-models.ts`).
 * `mera-qwen3.5-4b` stays retired: what it pointed at cannot be checked, so the
 * text model got a new id rather than trusting an old manifest.
 */
export const RETIRED_MODEL_IDS: readonly string[] = [
  'mera-qwen3.5-4b',
  'mera-qwen3-4b',
  'mera-lfm2.5-2.6b',
  'mera-lfm2-2.6b',
  'mera-qwen3.5-2b',
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
