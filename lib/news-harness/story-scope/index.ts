// news-harness — story-scope generator (PURE, RN-free).
//
// Turns the known titles of a followed story into ONE trackable topic scope: a
// short generic display `label` (shown to the user) + a lowercase entity-
// anchored `search` query (minted as the tracked topic). Used to LLM-generate a
// scope for LEGACY stable-cluster follows during their one-shot migration to the
// topic model — the non-interactive sibling of the chat `proposeTrack` pills.
//
// Shares the 4096-ctx / 1024-out on-device budget, so the input is capped +
// truncated. English-canonical (rendered via TranslatableDynamic downstream).

import { sanitizeForPrompt } from '../prompts/prompts';

/** Max titles fed to the scope prompt. */
export const MAX_SCOPE_TITLES = 8;
/** Each title truncated to this many chars in the prompt. */
export const MAX_SCOPE_TITLE_CHARS = 140;
/** Prompt-guidance ceilings for the two generated fields. */
export const MAX_SCOPE_LABEL_WORDS = 5;
export const MAX_SCOPE_SEARCH_WORDS = 8;

/** The two fields the generator emits for a followed story. */
export interface StoryScope {
  /** Short generic display name shown to the user (Title Case, ≤5 words). */
  label: string;
  /** Lowercase entity-anchored retrieval query minted as the topic (≤8 words). */
  search: string;
}

export interface StoryScopePrompt {
  system: string;
  user: string;
}

/** System prompt: one generic label + one search query, strict JSON. Terse to
 *  protect the token budget. */
export const STORY_SCOPE_SYSTEM_PROMPT =
  `You turn an ongoing news story into ONE trackable topic the user can keep following.
You are given a numbered list of titles that all cover the same developing story. Pick the GENERIC continuing story they share (not any single article) so future developments keep matching.

Output TWO fields:
- "label": a short display name for the story, ${MAX_SCOPE_LABEL_WORDS} words or fewer, Title Case, no trailing punctuation. Generic and recognisable (e.g. "Russia–Ukraine war").
- "search": a plain lowercase search query, ${MAX_SCOPE_SEARCH_WORDS} words or fewer, with the concrete who / what / where entity anchors that make future articles match (e.g. "russia ukraine civilian infrastructure attacks").

Do not invent entities absent from the titles. Plain, neutral language; no clickbait, no ALL CAPS.

Output ONLY a JSON object, nothing else:
{"label": "Russia–Ukraine war", "search": "russia ukraine war"}`;

/**
 * Build the {system, user} pair for one story-scope generation call. Titles are
 * de-blanked, capped, sanitized, and truncated before numbering.
 */
export function buildStoryScopePrompt(titles: string[]): StoryScopePrompt {
  const lines = (titles ?? [])
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .slice(0, MAX_SCOPE_TITLES)
    .map((t, i) => `${i + 1}. ${sanitizeForPrompt(t, MAX_SCOPE_TITLE_CHARS)}`);
  const user = `Titles for this story:\n${lines.join('\n')}\n\nWrite the topic now as a JSON object with "label" and "search".`;
  return { system: STORY_SCOPE_SYSTEM_PROMPT, user };
}

/**
 * Extract `{label, search}` from raw model output. Tolerates markdown fences and
 * surrounding prose (first top-level {...}). Falls back `search`→`label` (and
 * vice-versa) when only one field is present. Throws when neither is usable —
 * the handler treats a throw as "leave this story unmigrated for now".
 */
export function parseStoryScopeOutput(raw: string): StoryScope {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('story-scope: empty model output');

  const candidates: string[] = [];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  candidates.push(trimmed);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const label = typeof rec.label === 'string' ? rec.label.trim() : '';
      const search = typeof rec.search === 'string' ? rec.search.trim() : '';
      // Either field alone is enough — the other falls back to it.
      if (label || search) {
        return { label: label || search, search: search || label };
      }
    }
  }

  throw new Error('story-scope: no label/search in model output');
}
