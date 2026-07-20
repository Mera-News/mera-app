// news-harness — persona-summary tuning constants (PURE, RN-free).
//
// The generation prompt shares the same 4096-ctx / 1024-out budget as every
// other on-device flow, so the input side must fit in ~3072 tokens. We cap the
// number of facts fed in and truncate each statement to keep well under that
// even for a heavy persona (see lib/news-harness/persona-summary/prompt.ts).

/** Max facts fed to the summary prompt (highest-weight first). */
export const MAX_FACTS_IN_PROMPT = 30;

/** Each fact statement is truncated to this many chars in the prompt. */
export const MAX_STATEMENT_CHARS = 120;

/** We aim for 4–8 strings; the assembler never returns more than this. */
export const MIN_SUMMARY_STRINGS = 4;
export const MAX_SUMMARY_STRINGS = 8;

/** Strings longer than this are dropped (kept short + glanceable). */
export const MAX_STRING_CHARS = 80;
