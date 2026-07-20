// news-harness — persona-summary prompt builder (PURE, RN-free).

import { sanitizeForPrompt } from '../prompts/prompts';
import { MAX_FACTS_IN_PROMPT, MAX_STATEMENT_CHARS } from './config';
import type { PersonaSummaryFactInput } from './types';

/** System prompt: warm, plain-language, strict-JSON, cites fact numbers. Kept
 *  terse to protect the token budget. English-canonical (rendered via
 *  TranslatableDynamic downstream). */
export const PERSONA_SUMMARY_SYSTEM_PROMPT =
  `You describe a person back to themselves so they recognise who you think they are.
You are given a numbered list of facts about the user. Write 4 to 8 short, warm, plain-language lines describing who they are and what they follow.

Rules for each line:
- Everyday language a non-technical person understands. No jargon, no numbers, no scores.
- 60 characters or fewer.
- Concrete and specific (e.g. "Lives in Pune with family", "Follows Indian startups", "Keeps up with cricket").
- Cite the fact number(s) each line is based on.
- Do not invent facts that are not supported by the list.

Output ONLY a JSON array, nothing else:
[{"text": "Lives in Pune with family", "facts": [1]}, {"text": "Follows Indian startups", "facts": [2, 4]}]`;

/**
 * Pick and order the facts fed to the prompt: highest fact-weight first,
 * capped. The returned order IS the 1-based index space the model cites and the
 * assembler maps back — callers MUST pass this same array to
 * `assemblePersonaSummaryStrings`.
 */
export function selectFactsForSummary(
  facts: PersonaSummaryFactInput[],
  cap: number = MAX_FACTS_IN_PROMPT,
): PersonaSummaryFactInput[] {
  return facts
    .map((f, i) => ({ f, i }))
    // Stable sort: weight desc, original order as tiebreak.
    .sort((a, b) => (b.f.weight ?? 1) - (a.f.weight ?? 1) || a.i - b.i)
    .slice(0, Math.max(0, cap))
    .map((x) => x.f);
}

/** Build the {system, user} pair for one persona-summary generation call. */
export function buildPersonaSummaryPrompt(
  selected: PersonaSummaryFactInput[],
): { system: string; user: string } {
  const lines = selected.map(
    (f, i) => `${i + 1}. ${sanitizeForPrompt(f.statement, MAX_STATEMENT_CHARS)}`,
  );
  const user = `Facts about the user:\n${lines.join('\n')}\n\nWrite the description lines now as a JSON array.`;
  return { system: PERSONA_SUMMARY_SYSTEM_PROMPT, user };
}
