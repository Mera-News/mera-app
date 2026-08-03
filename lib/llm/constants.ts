// Cloud inference model identifiers.
// BIG  — persona-update chat (tool-calling, multi-turn).
// SMALL — everything else: topic generation, relevance scoring, reason generation.

export const BIG_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
export const SMALL_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';

/**
 * Session-scoped fallback model per primary. When a primary model fails in a
 * TIMEOUT-CLASS way (see lib/llm/model-fallback) we stop sending it for the rest
 * of the JS session and send its fallback instead.
 *
 * Both fallbacks are TEE-served on the same NEAR fleet with healthy
 * attestation reports (verified 2026-08-03). They are picked per PRIMARY by
 * what that primary's callers actually need, not by price:
 *
 *   BIG (persona chat) needs FUNCTION TOOL CALLING. `openai/gpt-oss-120b` held
 *   this slot until a live session exposed the cost: it answers conversation-
 *   ally while calling `saveExtractedFacts` with an empty list, so the user's
 *   fact is silently dropped. A streamed tool-call probe across every ready
 *   model (2026-08-03, same prompt + schema) separates them cleanly — only
 *   DeepSeek-V4-Flash (the primary) and `zai-org/GLM-5.1-FP8` returned
 *   schema-conformant arguments. Qwen3.5-122B leaked `</parameter>` markers
 *   into its JSON, both Qwen3.6 variants emitted a call with EMPTY arguments,
 *   and Gemma-4-31B made no call at all under `tool_choice: 'required'`.
 *   GLM-5.1 costs ~10x the primary ($1.40/$4.40 vs $0.17/$0.35), which is the
 *   right trade for a path that only runs when the primary has stalled.
 *
 *   SMALL (scoring / topics / reasons) uses JSON MODE, never function tools
 *   (`responseFormat: 'json'`), so the tool-call probe above does not apply to
 *   it. `google/gemma-4-31B-it` (~31B dense, $0.13/$0.40, 262K ctx, json_mode
 *   + structured outputs) stays.
 *
 * Kimi K2.6 was evaluated and REJECTED: it serves no usable attestation
 * report, so the E2EE path cannot key against it at all.
 *
 * This map is the single point to change if a different fallback is chosen.
 */
export const MODEL_FALLBACKS: Record<string, string> = {
  [BIG_MODEL]: 'zai-org/GLM-5.1-FP8',
  [SMALL_MODEL]: 'google/gemma-4-31B-it',
};

/**
 * Max output tokens for a CHAT turn — the on-device path and the cloud path
 * share this so the same conversation can't be cut at two different lengths
 * depending on which engine served it.
 *
 * The cloud path used to hardcode 300, which truncated Mera's narration
 * mid-sentence whenever a turn also carried a tool call (a `proposeTrack` with
 * 3–4 scope options routinely exceeds 300 output tokens) — the tool args
 * survived, the prose did not. 1024 is the value the on-device chat has always
 * used, so this raises the cloud path to the existing budget rather than
 * inventing a new one.
 *
 * SCOPE: chat turns only. The scoring / reason / topic-generation pipelines have
 * their own, much smaller output budgets (see HarnessConfig) and are deliberately
 * NOT governed by this.
 */
export const CHAT_MAX_OUTPUT_TOKENS = 1024;

// Noise injection — number of decoy topics generated per real topic when the
// "Inject noise" Mera-Protocol setting is enabled. 1 = parity (one decoy per
// real topic). Bumping this widens the obfuscation window at the cost of more
// on-device LLM time and a larger submission batch.
export const NOISE_MULTIPLIER = 1;
