import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';

export type PersonaSurface = 'ONBOARDING' | 'CONFIG';

export interface PersonaChatReply {
  reply: string;
  save: { statement: string; attribute: string }[];
  delete?: string[];
  confirm?: boolean;
  cancel?: boolean;
}

const SAVE: JsonSchema = {
  type: 'array',
  maxItems: 6,
  description: 'New facts the user just shared; empty when there are none',
  items: {
    type: 'object',
    properties: {
      statement: { type: 'string', description: 'One short fact in English' },
      attribute: { type: 'string', description: 'A short label, category: detail' },
    },
    required: ['statement', 'attribute'],
  },
};

/** Onboarding has no facts to remove yet, so its schema has no `delete`. */
export function personaChatSchema(surface: PersonaSurface): JsonSchema {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Under 200 characters, at most one question' },
      save: SAVE,
      ...(surface === 'CONFIG'
        ? { delete: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'Fact ids to remove' } as JsonSchema }
        : {}),
      confirm: { type: 'boolean', description: 'True only when the user agrees to a waiting change' },
      cancel: { type: 'boolean', description: 'True only when the user declines a waiting change' },
    },
    required: ['reply', 'save'],
  };
}
