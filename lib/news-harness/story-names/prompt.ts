// news-harness: story-names prompt builder (PURE, RN-free).
//
// A followed story's mustMatch names: the 1-3 names every article about exactly
// that story must mention. Written by a background job from the label and search
// the reader accepted, never by the chat that offered the story.

import { asUntrusted } from '../prompts/untrusted-text';

/** Caps on the accepted label and search fed in (raw characters). */
const MAX_LABEL_CHARS = 120;
const MAX_SEARCH_CHARS = 200;

const STORY_NAMES_SYSTEM_PROMPT = `You list the names that define one followed news story.
You are given the story's label and its search query. Give the names any article about exactly this story must mention.

Rules:
- 1-3 distinctive names (event, organisation, product or person) that any article about exactly this story must mention, written as English headlines write them: Latin script, no year, spelling variants in the spare slots.
- Never a city, region or country on its own: a place name alone lets in every other event held there.
- Empty for a broad story that no single name covers.

Output ONLY a JSON object, nothing else:
{"mustMatch": ["Name", "Other spelling"]} or {"mustMatch": []}`;

export interface StoryNamesPrompt {
  system: string;
  user: string;
}

export function buildStoryNamesPrompt(input: { label: string; search: string }): StoryNamesPrompt {
  const user = `Story label: ${asUntrusted(input.label ?? '', MAX_LABEL_CHARS)}
Search: ${asUntrusted(input.search ?? '', MAX_SEARCH_CHARS)}

Write the JSON object now.`;
  return { system: STORY_NAMES_SYSTEM_PROMPT, user };
}
