// On-device story scope: one followed story's titles to a `{label, search}`
// topic, for the one-shot migration of a legacy follow. The cloud prompt
// (news-harness/story-scope) carries real-world examples, which a small model
// copies; this one describes the shape instead. The user message is the
// cloud one: numbered, sanitised titles and the date.
import { buildStoryScopePrompt } from '../../story-scope';
import { DEVICE_SLOTS } from '../../../harnesses/slots';

export const STORY_SCOPE_SYSTEM = DEVICE_SLOTS["story-scope/story-scope-system"];

export function buildOnDeviceStoryScopePrompt(titles: string[], nowMs: number): { system: string; prompt: string } {
  return { system: STORY_SCOPE_SYSTEM, prompt: buildStoryScopePrompt(titles, nowMs).user };
}
