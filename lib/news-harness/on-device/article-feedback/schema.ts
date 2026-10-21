import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';
import { TRACK_OPTIONS_SCHEMA, type TrackOptionReply } from '../follow-story/schema';

export const ARTICLE_INTENTS = ['answer', 'track', 'less', 'more', 'mute', 'confirm', 'cancel'] as const;
export type ArticleIntent = (typeof ARTICLE_INTENTS)[number];

export interface ArticleFeedbackReply {
  intent: ArticleIntent;
  reply: string;
  options?: TrackOptionReply[];
  /** Named like the proposeChanges input: the topic to change and what the change does. */
  change?: { topicText: string; expected_effects: string };
}

export const ARTICLE_FEEDBACK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...ARTICLE_INTENTS] },
    reply: { type: 'string', description: 'One or two short sentences for the user' },
    options: TRACK_OPTIONS_SCHEMA,
    change: {
      type: 'object',
      description: 'Only for less or more',
      properties: {
        topicText: { type: 'string', description: 'One topic copied from Matched topics' },
        expected_effects: { type: 'string', description: 'One short sentence on what changes in the feed' },
      },
      required: ['topicText', 'expected_effects'],
    },
  },
  required: ['intent', 'reply'],
};
