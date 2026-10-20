import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';

export interface StoryScopeReply {
  label: string;
  search: string;
}

export const STORY_SCOPE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', description: "The story's name for the reader, 5 words or fewer" },
    search: { type: 'string', description: 'A search query of 8 words or fewer' },
  },
  required: ['label', 'search'],
};
