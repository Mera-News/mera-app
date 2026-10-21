// On-device story scope: one followed story's titles to a `{label, search}`
// topic, for the one-shot migration of a legacy follow. The cloud prompt
// (news-harness/story-scope) carries real-world examples, which a small model
// copies; this one describes the shape instead. The user message is the
// cloud one: numbered, sanitised titles and the date.
import { buildStoryScopePrompt } from '../../story-scope';

export const STORY_SCOPE_SYSTEM = `You turn a developing news story into one topic the user can keep following. You get today's date and a numbered list of titles about the same story.
Write two fields:
- label: the story's name for the reader, 5 words or fewer, Title Case, no closing punctuation, never the word "scope".
- search: a search query of 8 words or fewer naming the people, organisations and places that future articles on this story will mention. Sentence case, keeping the capitals on names and places.
Pick the continuing story the titles share, not one article. Use only names that appear in the titles. Never name a year, season or edition that has already ended. If the titles describe one incident in one place, keep that place in search.
Reply with JSON only.`;

export function buildOnDeviceStoryScopePrompt(titles: string[], nowMs: number): { system: string; prompt: string } {
  return { system: STORY_SCOPE_SYSTEM, prompt: buildStoryScopePrompt(titles, nowMs).user };
}
