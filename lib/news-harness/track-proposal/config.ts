// news-harness — track-proposal tuning constants (PURE, RN-free).
//
// Shares the same 4096-ctx / 1024-out budget as every other on-device flow, so
// the input side must stay well under ~3072 tokens. The inputs here are tiny
// (one title + optional snippet + one instruction), so generous per-field caps
// still leave the budget comfortable.

/** The tapped article's title is truncated to this many chars. */
export const MAX_TITLE_CHARS = 200;

/** The article description/snippet is truncated to this many chars. */
export const MAX_DESC_CHARS = 600;

/** The user's tweak instruction is truncated to this many chars. */
export const MAX_INSTRUCTION_CHARS = 300;

/** The previous proposal (revision context) is truncated to this many chars. */
export const MAX_PREV_PROPOSAL_CHARS = 300;

/** Target ceiling on the generated proposal length (prompt guidance). */
export const MAX_PROPOSAL_WORDS = 18;
