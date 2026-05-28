// Topic Submission Service — Sends on-device-generated topics to server.
// Server synchronously creates UserTopic records and returns their ids,
// allowing the caller to wire up fact_topic_links immediately.

import { AccountService, type SubmittedUserTopic } from '../account-service';
import logger from '../logger';

export interface TopicForSubmission {
  text: string;
  sourceFactLocalId: string;
}

/**
 * Submits on-device-generated topics to the server. Returns the server's
 * (topicId, sourceFactLocalId, text, status) tuples — when `topicId` is
 * present the server has persisted the topic and attached it to the user's
 * persona. `topicId` may be null if the server skipped a topic (e.g. too
 * similar to an existing one).
 */
export async function submitTopicsToServer(
  userId: string,
  topics: TopicForSubmission[],
): Promise<SubmittedUserTopic[]> {
  if (topics.length === 0) return [];

  const response = await AccountService.submitUserTopics(userId, topics);

  if (!response.success) {
    logger.warn('Server rejected topic submission', {
      message: response.message,
      topicCount: topics.length,
    });
  }

  return response.topics ?? [];
}
