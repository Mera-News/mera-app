// news-harness — story-headline prompt builder (PURE, RN-free).

import { sanitizeForPrompt } from '../prompts/prompts';
import { MAX_HEADLINE_WORDS, MAX_TITLE_CHARS, MAX_TITLES } from './config';
import type { StoryHeadlinePrompt } from './types';

/** System prompt: name the overall story in ONE plain-language headline, strict
 *  JSON. Kept terse to protect the token budget. English-canonical (rendered
 *  via TranslatableDynamic downstream). */
export const STORY_HEADLINE_SYSTEM_PROMPT =
  `You name an ongoing news story with ONE short headline.
You are given a numbered list of article titles that all cover the same developing story. Write a single headline that captures the overall story they share.

Rules:
- ONE headline, ${MAX_HEADLINE_WORDS} words or fewer.
- Plain, neutral language a general reader understands. No clickbait, no ALL CAPS, no trailing punctuation gimmicks.
- Describe the shared story, not any single article.
- Do not invent details that are not supported by the titles.

Output ONLY a JSON object, nothing else:
{"headline": "Floods displace thousands across northern India"}`;

/**
 * Build the {system, user} pair for one story-headline generation call. Titles
 * are de-blanked, capped, sanitized, and truncated before numbering.
 */
export function buildStoryHeadlinePrompt(titles: string[]): StoryHeadlinePrompt {
  const lines = (titles ?? [])
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .slice(0, MAX_TITLES)
    .map((t, i) => `${i + 1}. ${sanitizeForPrompt(t, MAX_TITLE_CHARS)}`);
  const user = `Article titles for this story:\n${lines.join('\n')}\n\nWrite the one-line headline now as a JSON object.`;
  return { system: STORY_HEADLINE_SYSTEM_PROMPT, user };
}
