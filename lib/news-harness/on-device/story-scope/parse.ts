import type { StoryScope } from '../../story-scope';
import type { StoryScopeReply } from './schema';

/**
 * The scope in a reply that fits `STORY_SCOPE_SCHEMA`. A blank field falls back
 * to the other; throws when both are blank, which leaves the story unmigrated.
 */
export function storyScopeFromReply(reply: StoryScopeReply): StoryScope {
  const label = reply.label.trim();
  const search = reply.search.trim();
  if (!label && !search) throw new Error('story-scope: no label/search in model output');
  return { label: label || search, search: search || label };
}
