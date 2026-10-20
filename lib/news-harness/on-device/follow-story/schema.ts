import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';
import { MAX_TRACK_SEARCH_WORDS } from '../../article-feedback/agent-core';

/** Word cap on an option's display label. */
export const MAX_OPTION_LABEL_WORDS = 6;

/** The story options a follow turn offers: up to 4, none while the story is still unnamed. */
export const TRACK_OPTIONS_SCHEMA: JsonSchema = {
  type: 'array',
  maxItems: 4,
  description: 'Empty until the story is named; then 3 or 4, from the narrow event to the broad story',
  items: {
    type: 'object',
    properties: {
      label: { type: 'string', description: `The story name shown to the user, ${MAX_OPTION_LABEL_WORDS} words or fewer` },
      search: { type: 'string', description: `A search query of ${MAX_TRACK_SEARCH_WORDS} words or fewer` },
    },
    required: ['label', 'search'],
  },
};

export interface TrackOptionReply {
  label: string;
  search: string;
}

export interface FollowStoryReply {
  reply: string;
  options: TrackOptionReply[];
}

export const FOLLOW_STORY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'One short sentence for the user' },
    options: TRACK_OPTIONS_SCHEMA,
  },
  required: ['reply', 'options'],
};
