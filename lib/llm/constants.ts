// Cloud inference model identifiers. ONE model serves both lanes since 2026-10-22.
// BIG  — persona-update chat (tool-calling, multi-turn) and quick fact-check synthesis.
// SMALL — everything else: topic generation, relevance scoring, reason generation.
//
// Two names for one id on purpose: every call site still says which lane it is,
// so splitting the lanes again is a one-line change here.

export const BIG_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
export const SMALL_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';

/**
 * Session-scoped fallback model per primary. When a primary model fails in a
 * TIMEOUT-CLASS way (see lib/llm/model-fallback) we stop sending it for the rest
 * of the JS session and send its fallback instead.
 *
 * WHICH MODELS ARE EVEN ELIGIBLE. The E2EE path keys on
 * `model_attestations[0].signing_public_key` from `/v1/attestation/report`
 * (lib/e2ee/e2ee-service). Only NEAR's self-hosted TEE tier (`owned_by: nearai`)
 * returns that shape. The `attested 3p` tier (moonshotai/kimi-*,
 * deepseek/deepseek-v3.2, the lowercase qwen/* ids) answers 200 with
 * `e2e_pubkey` / `certificate_b64` and no `signing_public_key`, so the parser
 * throws before any request is sent. Ready self-hosted text models on
 * 2026-10-22: Qwen3.6-35B-A3B-FP8, Qwen3.8-27B, Qwen3-VL-30B-A3B (rejected as a
 * text model by product decision) and z-ai/glm-5.3-flash (closed: 0/6 parsed
 * with a leaked trace on every call, and it ignores `enable_thinking:false`).
 * Probe the attestation endpoint before adopting any other id.
 *
 * WHY Qwen3.6 FOR BIG (owner decision 2026-10-22, for chat speed). It has ~3B
 * active parameters, so it decodes faster than the dense Qwen3.8-27B (NEAR
 * decoded Qwen3.8 at ~58 tok/s, so a 500-token answer took ~9.5s), and scoring
 * keeps it warm all day where the BIG-only Qwen3.8 saw cold first calls (5.7s
 * against 0.6s warm, n=1). Its old rejection (finish_reason=length on 12 of 19
 * persona turns) was measured with thinking ON; the persona loop now sends
 * thinking off on every leg. Thinking-ON single-shot chat (article chat,
 * tutorial help) is the shape still to re-measure on it.
 *
 * Qwen3.8-27B is the one fallback for both lanes: clean on scoring (60/60
 * tiered parses, 0 leaks) and the previous BIG primary for chat. One shared
 * fallback means one dead model can take out both lanes; prewarm attests it on
 * every cold start so that is noticed before an outage needs it.
 */
export const MODEL_FALLBACKS: Record<string, string> = {
  [BIG_MODEL]: 'Qwen/Qwen3.8-27B',
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

/**
 * Extra `max_tokens` the CLOUD chat stream adds on top of the caller's budget,
 * because the cloud chat gear is thinking ON and a reasoning model's trace is
 * billed and capped inside the same `max_tokens` as the visible answer.
 * Measured on GLM 5.3 Flash (a former BIG fallback): trace median ~240 tokens, p90
 * ~830, and the 1024 budget alone truncated 3 of 60 turns (one lost a tool
 * call's arguments); Qwen3.8-27B peaks at ~740. 2048 covers every trace seen;
 * a longer one still ends as `finish_reason: length` rather than being hidden. The visible answer is not lengthened by
 * this — the prompts bound it, and no measured turn came near 1024 of prose —
 * so the shared CHAT_MAX_OUTPUT_TOKENS keeps its meaning on both engines.
 *
 * SCOPE: cloudChatStream only. The non-streaming SMALL calls run thinking off.
 */
export const CHAT_REASONING_HEADROOM_TOKENS = 2048;

// Noise injection — number of decoy topics generated per real topic when the
// "Inject noise" Mera-Protocol setting is enabled. 1 = parity (one decoy per
// real topic). Bumping this widens the obfuscation window at the cost of more
// on-device LLM time and a larger submission batch.
export const NOISE_MULTIPLIER = 1;
