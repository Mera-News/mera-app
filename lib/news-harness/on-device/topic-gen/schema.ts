import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';

export interface TopicGenReply {
  topics: string[];
}

/** `{topics: string[]}`, at most `count` of them. An empty list is a valid answer. */
export function topicGenSchema(count: number): JsonSchema {
  return {
    type: 'object',
    properties: {
      topics: {
        type: 'array',
        items: { type: 'string', description: 'A news search phrase of 1 to 5 words' },
        maxItems: count,
      },
    },
    required: ['topics'],
  };
}
