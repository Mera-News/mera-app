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
 * `openai/gpt-oss-120b` is a similar-cost TEE-served model on the same NEAR
 * fleet — verified `is_ready: true` with a healthy attestation report on
 * 2026-08-03. The ids here are pending final user sign-off; this map is the
 * single point to change if a different fallback is chosen.
 */
export const MODEL_FALLBACKS: Record<string, string> = {
  [BIG_MODEL]: 'openai/gpt-oss-120b',
  [SMALL_MODEL]: 'openai/gpt-oss-120b',
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
