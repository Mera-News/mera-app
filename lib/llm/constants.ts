// Cloud inference model identifiers.
// BIG  — persona-update chat (tool-calling, multi-turn).
// SMALL — everything else: topic generation, relevance scoring, reason generation.

export const BIG_MODEL = 'Qwen/Qwen3.5-122B-A10B';
export const SMALL_MODEL = 'Qwen/Qwen3-30B-A3B-Instruct-2507';

// Noise injection — number of decoy topics generated per real topic when the
// "Inject noise" Mera-Protocol setting is enabled. 1 = parity (one decoy per
// real topic). Bumping this widens the obfuscation window at the cost of more
// on-device LLM time and a larger submission batch.
export const NOISE_MULTIPLIER = 1;
