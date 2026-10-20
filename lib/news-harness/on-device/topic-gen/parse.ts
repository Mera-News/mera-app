import { cleanTopicList } from '../../persona-management/topic-generation';
import type { TopicGenReply } from './schema';

/** The usable topics in a reply that fit `topicGenSchema`. */
export function topicsFromReply(reply: TopicGenReply): string[] {
  return cleanTopicList(reply.topics);
}
