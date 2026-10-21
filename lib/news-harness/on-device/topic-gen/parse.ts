import type { TopicGenReply } from './schema';

/** The usable topics in a reply that fit `topicGenSchema`: trimmed, non-empty strings, at most 20. */
export function topicsFromReply(reply: TopicGenReply): string[] {
  const items: unknown[] = Array.isArray(reply.topics) ? reply.topics : [];
  return items
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 20);
}
