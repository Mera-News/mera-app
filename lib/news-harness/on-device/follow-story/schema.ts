import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';

/** Word cap on an option's display label. */
export const MAX_OPTION_LABEL_WORDS = 6;
/** Word cap on an option's hidden search query (the cloud prompt's figure). */
export const MAX_TRACK_SEARCH_WORDS = 8;

const TRACK_OPTION_ITEM: JsonSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', description: `The story name shown to the user, ${MAX_OPTION_LABEL_WORDS} words or fewer` },
    search: { type: 'string', description: `A search query of ${MAX_TRACK_SEARCH_WORDS} words or fewer` },
  },
  required: ['label', 'search'],
};

/** The story options a follow turn offers: up to 4, none while the story is still unnamed. */
export const TRACK_OPTIONS_SCHEMA: JsonSchema = {
  type: 'array',
  maxItems: 4,
  description: 'Empty until the story is named; then 3 or 4, from the narrow event to the broad story',
  items: TRACK_OPTION_ITEM,
};

export interface TrackOptionReply {
  label: string;
  search: string;
}

export interface FollowStoryReply {
  reply: string;
  options: TrackOptionReply[];
}

const REPLY_FIELD: JsonSchema = { type: 'string', description: 'One short sentence for the user' };

export const FOLLOW_STORY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { reply: REPLY_FIELD, options: TRACK_OPTIONS_SCHEMA },
  required: ['reply', 'options'],
};

/**
 * The Kev writer's schema once the message names a story. AFM's guided generation holds it to 3
 * or more options (the bridge maps minItems to minimumElements): left free it often wrote one.
 * A message that names nothing keeps FOLLOW_STORY_SCHEMA, so the writer can still ask which story.
 */
export const NAMED_STORY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reply: REPLY_FIELD,
    options: { type: 'array', minItems: 3, maxItems: 4, description: '3 or 4, from the narrow event to the broad story', items: TRACK_OPTION_ITEM },
  },
  required: ['reply', 'options'],
};
