// mera-harness/core — the tool wire contract. PURE, RN-free.
//
// THE schemas. P5's skill bodies and P6's fakes are checked against this file,
// not against each other: four plans previously disagreed on argument names,
// result field names and cardinality, and the model then followed the prose
// while the schema rejected it — which reads as model non-compliance in the one
// block built to measure non-compliance.

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * `id` ONLY.
 *
 * There is deliberately no `answerPending` argument. The loop computes whether
 * the user left the previous question unanswered from its own turn state and
 * injects it into the state line; asking the model to report it made the
 * router's step inert and scored every such call as schema-invalid.
 */
export const LOAD_SKILL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'load_skill',
    description:
      'Load the instructions for one kind of turn. Call this FIRST, before any other tool, whenever the user message matches a row in the skill index. Returns the full instructions; follow them for the rest of this turn. Never handle a fact, topic or place turn without loading its skill.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One id from the skill index, e.g. facts/residence.' },
      },
      required: ['id'],
    },
  },
};

/**
 * NO `statement`, NO `query`.
 *
 * Tool arguments sit OUTSIDE the E2EE envelope — the gateway must read them to
 * route the call. The device already holds the user's raw message, so sending
 * it here would put the user's residence, origin and profession into cleartext
 * for nothing. `kind` alone is enough to rank, and it is optional.
 */
export const FIND_SIMILAR_FACTS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'find_similar_facts',
    description:
      'Find facts already saved that cover the same ground as what the user just said. Call it before proposing a fact that might replace an existing one. Returns up to 5 candidates with their ids. It decides nothing: you still choose add or replace.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'residence | origin | profession | family | generic. Omit to search all.',
        },
      },
      required: [],
    },
  },
};

export const LOOKUP_PLACE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'lookup_place',
    description:
      "Resolve a place the user named into its real locality, region and country. Call it before writing any place into a fact. Never write a country or region from memory. It returns 1 to 3 candidates: with one, use it; with more, ask the user which they meant. If it returns no match, ask which place they meant; if it reports the lookup is unavailable, say the lookup did not work and ask them to write the place out in full.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The place as the user named it. At least 2 characters.' },
        countryHint: {
          type: 'string',
          description: 'ISO alpha-2 country code, when the conversation already implies one.',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * ENDS THE TURN. Deliberately NOT in CONTINUATION_TOOLS: the chips are
 * rendered, the tap arrives as the user's next message verbatim, and spending a
 * leg waiting for input that cannot arrive within the turn would be a leg
 * wasted. Typing instead of tapping stays possible, so the card is an
 * affordance and never a modal gate.
 */
export const ASK_CHOICE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ask_choice',
    description:
      'Ask the user to pick between 2 or 3 readings, shown as tap chips. Use it when a place is ambiguous, or when a new fact might replace one they already have. This ENDS your turn: the tap arrives as their next message. Ask nothing else in the same turn.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One short question, under 120 characters.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 3,
          description: 'Exactly 2 or 3 options, each under 60 characters.',
        },
      },
      required: ['question', 'options'],
    },
  },
};

export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 3;

/** A 1-option "choice" is not a choice and a 4-option row does not fit at
 *  400px, so an out-of-range list is a validation error returned to the model,
 *  never a clamped render. */
export function validateChoiceOptions(options: unknown): options is string[] {
  return (
    Array.isArray(options) &&
    options.length >= MIN_CHOICE_OPTIONS &&
    options.length <= MAX_CHOICE_OPTIONS &&
    options.every((o) => typeof o === 'string' && o.trim().length > 0)
  );
}

/** Every tool this harness adds, in declaration order. */
export const HARNESS_TOOLS: readonly ToolDefinition[] = [
  LOAD_SKILL_TOOL,
  FIND_SIMILAR_FACTS_TOOL,
  LOOKUP_PLACE_TOOL,
  ASK_CHOICE_TOOL,
];

/**
 * Tools whose RESULT is the point, so a turn that called one must run another
 * leg or the result is pushed and never read.
 *
 * `ask_choice` is NOT here: it terminates. Adding a name to this set is the
 * whole wiring for continuation.
 */
export const CONTINUATION_TOOLS: ReadonlySet<string> = new Set([
  'load_skill',
  'find_similar_facts',
  'lookup_place',
  'explainMera',
  'searchNews',
  'webSearch',
]);
