// Cloud inference model identifiers.
// BIG  — persona-update chat (tool-calling, multi-turn) and quick fact-check synthesis.
// SMALL — everything else: topic generation, relevance scoring, reason generation.

export const BIG_MODEL = 'Qwen/Qwen3.8-27B';
export const SMALL_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';

/**
 * Session-scoped fallback model per primary. When a primary model fails in a
 * TIMEOUT-CLASS way (see lib/llm/model-fallback) we stop sending it for the rest
 * of the JS session and send its fallback instead.
 *
 * WHICH MODELS ARE EVEN ELIGIBLE. The E2EE path keys on
 * `model_attestations[0].signing_public_key` from `/v1/attestation/report`
 * (lib/e2ee/e2ee-service). Only NEAR's self-hosted TEE tier returns that shape.
 * The `attested 3p` tier (moonshotai/kimi-*, deepseek/deepseek-v3.2, the
 * lowercase qwen/* ids) answers 200 with `e2e_pubkey` / `certificate_b64` and
 * no `signing_public_key`, so the parser throws before any request is sent.
 * The catalogue's "Private TEE" label and the id namespace say nothing about
 * this: `z-ai/glm-5.3-flash` is self-hosted, `qwen/qwen3-32b` is not. Probe
 * the attestation endpoint before adopting any id. Ready, non-deprecated,
 * self-hosted text models on 2026-09-11: this file's three ids and nothing else
 * (`z-ai/glm-5.2` carries the same deprecation date as GLM 5.1).
 *
 * MEASURED 2026-09-11 (harness-local/scripts/replay-persona-chat.ts and
 * replay-fact-extraction.ts, 20 and 10 runs per cell, the app's prompt, tool
 * schema and thinking gear; `--model` selects the candidate, `--stream` times
 * the SSE body the way cloudChatStream consumes it):
 *
 *                       confirm  decline  conv   facts  completion tokens (median / p90 / max)
 *   DeepSeek-V4-Flash    20/20    20/20   20/20   9/10     29 /  43 /   58   (deprecated 2026-09-17)
 *   z-ai/glm-5.3-flash   20/20    20/20   14/20  10/10    238 / 834 / 1024
 *   Qwen/Qwen3.8-27B     20/20    20/20    2/20  10/10    195 / 274 /  742
 *
 *   First VISIBLE streamed delta, 15 runs (median / p90 / max):
 *                       tool turn                 conversational turn
 *   DeepSeek-V4-Flash    1.2s /  6.8s / 86s        1.2s / 10.0s / 75s
 *   z-ai/glm-5.3-flash   4.0s / 10.7s / 47s        8.5s / 26.1s / 55s
 *   Qwen/Qwen3.8-27B     3.3s /  4.5s /  8s        2.0s /  3.3s /  8s
 *
 *   BIG (persona chat) needs FUNCTION TOOL CALLING with schema-conformant
 *   arguments. Both remaining models pass confirm, decline and fact extraction;
 *   `conv` ("thanks!" after an invitation) is a behavioural difference, not a
 *   schema failure — GLM asks for confirmation where DeepSeek staged the card,
 *   Qwen moves on, so calibration needs an explicit yes. Qwen3.8-27B is the
 *   primary because the SPEED TAIL decides chat UX: its worst turn is ~8s where
 *   GLM's is 55s, since GLM thinks far longer on conversational prompts. It
 *   costs $0.44/$3.30 per 1M, ~3x GLM per turn, on the low-volume path. GLM
 *   5.3 Flash is the fallback (tools + json_mode, $0.15/$0.50) and the only
 *   other TEE model that calls tools correctly.
 *
 *   THINKING STAYS ON for chat, and the budget carries headroom for it (see
 *   CHAT_REASONING_HEADROOM_TOKENS). Qwen3.8 honours `enable_thinking:false`
 *   but drops to 17/20 confirm and 3/10 composed facts without its trace, so
 *   the flag stays on. GLM's completion tokens include its trace: 7 of 60
 *   turns used 800+ and 3 hit the 1024 cap, one of them truncating a tool
 *   call's arguments to `{}`; and thinking OFF is not an option on GLM at all:
 *   `enable_thinking:false` and `reasoning_effort:'none'` both return the trace
 *   INSIDE `content` as `trace</think>answer` (2/2 on a short prompt), which is
 *   the prefill leak the local path already strips.
 *
 *   SMALL (scoring / topics / reasons) sends JSON-shaped prompts with thinking
 *   off, never function tools. GLM 5.3 Flash replayed the article pipeline
 *   52/52 parsed, 0 failed, 0 leaked traces, ~50 completion tokens a call, at
 *   $0.50 output against the primary's $1.10. Qwen3.8 also parses (12/12) but
 *   advertises no json_mode and costs 3x on output. cloudComplete strips a
 *   leaked `…</think>` prefix defensively (lib/llm/reasoning-leak) because the
 *   short-prompt leak is real even though the shipped prompts did not trigger it.
 *
 * This map is the single point to change if a different fallback is chosen.
 */
export const MODEL_FALLBACKS: Record<string, string> = {
  [BIG_MODEL]: 'z-ai/glm-5.3-flash',
  [SMALL_MODEL]: 'z-ai/glm-5.3-flash',
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
 * Measured on GLM 5.3 Flash (the BIG fallback): trace median ~240 tokens, p90
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
