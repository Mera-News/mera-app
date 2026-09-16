// news-harness — the experiment seam for prompt arms.
//
// WHAT THIS IS FOR. Prompt quality work needs to run the SAME pipeline with a
// different prompt and compare. The previous way of doing that (see
// harness-local/scripts/score-v1-instruction.ts) derived each arm by string
// surgery over the shipped constant and asserted the surgery was invertible.
// That worked, but it makes the arm a function of whatever the live file
// happens to say today: the same named arm silently becomes a different
// experiment the moment someone edits the base prompt, and a result recorded
// last week stops being reproducible without also knowing that week's file.
//
// So a variant here supplies WHOLE prompt strings, never a transform. An arm is
// a value, not an edit. That is more typing exactly once, and in exchange the
// arm is diffable, hashable, and reproducible from the repo alone.
//
// THE DEFAULT IS ALWAYS 'baseline' AND 'baseline' IS ALWAYS A NO-OP. Every
// builder takes `promptVariant` optionally; omitted, or 'baseline', and the
// output is byte-for-byte what it was before this file existed. That is pinned
// by prompt-variants.test.ts and it is the property that lets this seam sit on
// the production path at all.
//
// UNKNOWN IDS THROW. A typo'd arm name must not silently score the baseline and
// then be written up as a result — that is a wrong number, which is worse than
// a crashed run.

import { ARTICLE_FENCE_MARKER } from './untrusted-text';

/** An arm's name. 'baseline' is reserved for the shipped prompts. */
export type PromptVariantId = string;

export const BASELINE_VARIANT_ID: PromptVariantId = 'baseline';

/**
 * The system prompts an arm may replace. These are slots, not the prompts
 * themselves.
 *
 * The four scoring slots are still routed by the existing standard/headline
 * routing (`ScoringVariant`), which this seam does not touch. The persona and
 * topic-generation slots have no such routing: each names exactly one shipped
 * prompt, and its builder resolves it directly.
 */
export type PromptSlot =
  | 'relevance'
  | 'reason'
  | 'headlineRelevance'
  | 'headlineReason'
  // The persona-update system prompt and the two cloud topic-generation
  // prompts, which live in ./persona-prompts and belong to the chat area. Same
  // slot semantics as the four above: a whole replacement string, never a
  // transform. `personaStatic` covers buildPersonaUpdateStaticPrompt's output
  // for both its CLOUD and LOCAL modes, which that builder selects itself.
  | 'personaStatic'
  | 'topicGenFactOnly'
  | 'topicGenCombo';

export interface PromptVariantSpec {
  id: PromptVariantId;
  /** What this arm is testing, in one line. Recorded alongside results. */
  description: string;
  /**
   * Whole replacement system prompts, per slot. A slot left out keeps the
   * shipped prompt, so an arm that only changes the reason pass names only
   * `reason` and cannot accidentally perturb scoring.
   */
  systemPrompts?: Partial<Record<PromptSlot, string>>;
  /**
   * Character cap applied to publisher title/description inside the article
   * fence, overriding `asUntrusted`'s 500-char default.
   *
   * A NUMBER, not a transform, because that is all the truncation arms need:
   * 18.1% of real article descriptions exceed 500 chars today (measured on
   * harness-local/fixtures/goldset-348.json; the longest is 26,067). Where that
   * cap sits is a real quality variable. It still applies to the RAW input
   * before escaping, exactly as it does by default — see untrusted-text.ts,
   * where that ordering is load-bearing.
   */
  articleTextMaxLength?: number;
}

const BASELINE: PromptVariantSpec = {
  id: BASELINE_VARIANT_ID,
  description: 'The shipped prompts, unmodified. The control arm.',
};

const REGISTRY = new Map<PromptVariantId, PromptVariantSpec>([
  [BASELINE_VARIANT_ID, BASELINE],
]);

/** Every registered arm's id, baseline first. */
export function promptVariantIds(): PromptVariantId[] {
  return [...REGISTRY.keys()];
}

/**
 * Resolve an arm. Absent means baseline. Unknown throws, deliberately: a typo'd
 * arm that quietly scored the baseline would be written up as a real result.
 */
export function resolvePromptVariant(id?: PromptVariantId): PromptVariantSpec {
  if (id === undefined) return BASELINE;
  const spec = REGISTRY.get(id);
  if (!spec) {
    throw new Error(
      `Unknown prompt variant '${id}'. Registered: ${promptVariantIds().join(', ')}.`,
    );
  }
  return spec;
}

/**
 * Add an arm at runtime. For experiment runners under harness-local, which are
 * excluded from the app build — an arm whose numbers get quoted should land in
 * this file, but forcing a commit for every throwaway probe would just push
 * people back to string surgery.
 *
 * Cannot replace an existing id, and cannot replace 'baseline' at all. Silently
 * redefining the control is the one failure this seam exists to prevent: every
 * arm is measured against it, so a mutated baseline corrupts every comparison
 * in the run rather than only its own.
 */
export function registerPromptVariant(spec: PromptVariantSpec): void {
  if (spec.id === BASELINE_VARIANT_ID) {
    throw new Error("The 'baseline' variant is the control and cannot be replaced.");
  }
  if (REGISTRY.has(spec.id)) {
    throw new Error(`Prompt variant '${spec.id}' is already registered.`);
  }
  REGISTRY.set(spec.id, spec);
}

/** Test-only: drop every arm except the baseline. */
export function resetPromptVariantsForTest(): void {
  for (const id of REGISTRY.keys()) {
    if (id !== BASELINE_VARIANT_ID) REGISTRY.delete(id);
  }
}

/**
 * Pick the system prompt for a slot: the arm's override if it has one, else the
 * shipped prompt the caller already resolved.
 */
export function systemPromptForSlot(
  slot: PromptSlot,
  shipped: string,
  variant: PromptVariantSpec,
): string {
  return variant.systemPrompts?.[slot] ?? shipped;
}

// ---------------------------------------------------------------------------
// Prompt hashing
// ---------------------------------------------------------------------------

/**
 * Replace every article-fence marker with a fixed token.
 *
 * THIS IS WHY THE HASH HELPER HAS TO EXIST. Article content is fenced with a
 * fresh random nonce per prompt build, so two byte-identical prompts hash
 * differently and a naive hash reports "the prompt changed" on every single
 * call. `golden-prompts.test.ts` hit the same wall and solved it the same way,
 * with a `stripNonce` before comparing. Normalising here means the runner and
 * the pin tests agree by construction instead of by each remembering to do it.
 */
export function normalizeForHash(text: string): string {
  return text.replace(ARTICLE_FENCE_MARKER, '<<FENCE>>');
}

const HASH_SEPARATOR = String.fromCharCode(0);

/**
 * A stable short digest of the messages a call actually sent, for recording
 * alongside a result.
 *
 * FNV-1a rather than a crypto hash: the harness may not import node:crypto (it
 * has to run on-device and stay RN-free), this is a change detector and not a
 * security boundary, and a 32-bit hex digest is short enough to sit in a
 * results table.
 */
export function promptHash(...parts: string[]): string {
  let h = 0x811c9dc5;
  const joined = parts.map(normalizeForHash).join(HASH_SEPARATOR);
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    // FNV prime 16777619, expressed as shifts so this stays in 32-bit math.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
