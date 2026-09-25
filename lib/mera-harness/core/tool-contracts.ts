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
      "Resolve a place the user named into its real locality, region and country. Call it before writing any place into a fact. Never write a country or region from memory. It returns 1 to 3 candidates: with one, use it, and put any unmatched words first as the district, spelled the usual way (an obvious typo is corrected, never asked about); with more, ask the user which they meant. With no match, offer the user's own words, never invented alternatives; if it reports the lookup is unavailable, offer their words as written and do not mention the tool.",
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
      'Ask the user to pick between 2 or 3 readings, shown as tap chips. Use it when a place is ambiguous, or when a new fact might replace one they already have. Never to pick between separate facts: offer every one of those with saveExtractedFacts. This ENDS your turn: the tap arrives as their next message. Ask nothing else in the same turn.',
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

/**
 * The ONE tool the forced-proposal leg may call, alongside ask_choice.
 *
 * Declared here rather than taken from the persona builder because the core
 * imports nothing from news-harness, and because a forced payload must be
 * exactly the tools whose call is a legitimate answer to "propose something
 * now": offer a reading, or ask which reading. Nothing else.
 */
export const SAVE_FACTS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'saveExtractedFacts',
    description:
      'OFFER facts from the user message for them to confirm. Nothing is saved until the user taps a reading on the card.',
    parameters: {
      type: 'object',
      properties: {
        extracted_user_information: {
          type: 'array',
          description: 'New facts from the user message.',
          items: {
            type: 'object',
            properties: {
              statement: { type: 'string' },
              questionnaire_attribute: { type: 'string' },
              alternatives: { type: 'array', items: { type: 'string' } },
              replaces: { type: 'string' },
              placeChain: { type: 'object', properties: {} },
            },
            required: ['statement'],
          },
        },
      },
      required: ['extracted_user_information'],
    },
  },
};

/**
 * THE WEB, from the user's device through the gateway (ux2 D10). `queries`,
 * never `query`: one call carries up to 4 searches and the gateway fans them
 * out. The query leaves the device in plaintext and is not linked to the user,
 * which the existing chat web-search disclosure already says.
 *
 * Declared only on facts and question legs, and only when the device offers
 * the tool (the "Web search in chat" setting is on). Never on the route leg.
 */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'webSearch',
    description:
      'Search the web for what a place, organisation or term is. Use it only when a lookup found nothing or the user asks what something is. A result never becomes a region or country in a fact; those come only from lookup_place.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 4,
          description: '1 to 4 short search queries.',
        },
      },
      required: ['queries'],
    },
  },
};

export const DELETE_FACTS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'deleteUserFacts',
    description:
      'Remove facts the user asked you to remove. Pass EXACT fact ids from the existing-facts list, never an attribute or a statement. Ask with ask_choice and wait for the tap before calling this: it is irreversible and it deletes the topics too.',
    parameters: {
      type: 'object',
      properties: {
        fact_ids: { type: 'array', items: { type: 'string' }, description: 'Exact fact ids.' },
      },
      required: ['fact_ids'],
    },
  },
};

/**
 * The tools a leg is offered, which is NOT one fixed list.
 *
 * WHY THIS EXISTS. `HARNESS_TOOLS` was the whole payload on every leg, and it
 * holds only the four discovery tools: saveExtractedFacts and deleteUserFacts
 * were never offered at all. Across 480 fact turns there was ONE save, and the
 * invented names `add_fact`, `save_fact` and `update_fact` were the model
 * reaching for a tool it could see the need for and could not see. No amount
 * of prompting fixes a tool that is not in the payload.
 *
 *  - ROUTER leg (nothing loaded): the four discovery tools. Nothing to save
 *    yet, and offering a writer here invites a save before the guideline that
 *    shapes it has been read.
 *  - FACTS leg: discovery minus load_skill, PLUS the two writers.
 *  - ANY OTHER skill: discovery minus load_skill. A conversation turn has
 *    nothing to write.
 *  - FORCED leg: saveExtractedFacts and ask_choice only, the two calls that
 *    answer "propose something now".
 */
export function toolsForLeg(opts: {
  skillLoaded: string | null;
  forcingProposal?: boolean;
  /** The `pre-enforcement` control arm only: the route leg carries all four
   *  discovery tools, as it did when the 99 no-route legs were measured. */
  wideRouteLeg?: boolean;
  /** False once another segment of the same turn has asked its question: one
   *  question per turn, so later segments put other readings on the card. */
  allowChoice?: boolean;
  /** The device offers web search (the setting is on). Declared on facts and
   *  question legs only, never on the route or forced leg. */
  webSearch?: boolean;
}): ToolDefinition[] {
  const tools = toolsForLegUnfiltered(opts);
  const withSearch =
    opts.webSearch === true
    && !opts.forcingProposal
    && opts.skillLoaded !== null
    && (opts.skillLoaded.startsWith('facts/') || opts.skillLoaded === 'conversation/question')
      ? [...tools, WEB_SEARCH_TOOL]
      : tools;
  return opts.allowChoice === false
    ? withSearch.filter((t) => t.function.name !== 'ask_choice')
    : withSearch;
}

function toolsForLegUnfiltered(opts: {
  skillLoaded: string | null;
  forcingProposal?: boolean;
  wideRouteLeg?: boolean;
}): ToolDefinition[] {
  if (opts.forcingProposal) return [SAVE_FACTS_TOOL, ASK_CHOICE_TOOL];
  // THE ROUTE LEG GETS ONE TOOL.
  //
  // It used to get all four, and the route leg has exactly one job. Of the 99
  // G2d route legs that loaded no skill, 9 discharged "call a tool" with a
  // discovery tool instead of routing: `find_similar_facts` and `lookup_place`
  // belong to the loaded skill, which has the guideline that says what to do
  // with the answer. A tool the model cannot see is one it cannot spend a leg
  // on, which is the same reasoning that took `load_skill` off every leg after
  // the first.
  //
  // mini-swe-agent runs its whole loop on ONE action for this reason: the
  // narrower the action space, the less there is to get wrong.
  if (opts.skillLoaded === null) return opts.wideRouteLeg ? [...HARNESS_TOOLS] : [LOAD_SKILL_TOOL];
  const discovery = HARNESS_TOOLS.filter((t) => t.function.name !== 'load_skill');
  // A SKILL TOLD TO WRITE MUST BE GIVEN THE MEANS.
  //
  // `conversation/correction` does not start with `facts/`, so the prefix test
  // alone denied it both writers while its own body says "Call deleteUserFacts
  // with the attribute keys of the facts to remove" and its frontmatter
  // promises "at most one saveExtractedFacts element and at most one
  // deleteUserFacts call". On device the model did the only thing left to it:
  // refused in prose and told the user to go tap a trash can in the app. The
  // payload contradicted the guideline, which is the same defect class as
  // HARNESS_TOOLS omitting saveExtractedFacts entirely (1 save in 480 turns).
  //
  // Deletion stays gated on `turn.resolvedChoice` in the loop, so offering the
  // tool here does not make a silent wipe reachable: it makes the confirmation
  // reachable.
  const writes = opts.skillLoaded.startsWith('facts/')
    || opts.skillLoaded === 'conversation/correction';
  return writes ? [...discovery, SAVE_FACTS_TOOL, DELETE_FACTS_TOOL] : discovery;
}

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
