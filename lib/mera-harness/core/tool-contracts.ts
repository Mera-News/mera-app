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

/**
 * The ids `explainMera` answers on. Declared HERE because the harness imports
 * nothing from news-harness; a test pins this list to MERA_EXPLAINER_TOPIC_IDS
 * so the two cannot drift.
 */
export const EXPLAIN_MERA_TOPIC_IDS = [
  'what_is_mera',
  'privacy_what_leaves_device',
  'privacy_what_we_store',
  'encryption_and_inference',
  'how_news_works',
  'source_available',
  'plans_and_limits',
  'known_gaps',
] as const;

/**
 * MERA'S OWN REFERENCE TEXT, for a question about Mera itself. Declared only on
 * the `conversation/about-mera` leg, and only when the device offers it. Its
 * arguments are topic ids, and the result travels inside the E2EE envelope.
 */
export const EXPLAIN_MERA_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'explainMera',
    description:
      `Returns Mera's own reference text on 1 to 3 topics. Answer a question about Mera only from what it returns. Topics: ${EXPLAIN_MERA_TOPIC_IDS.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        topics: {
          type: 'array',
          items: { type: 'string', enum: [...EXPLAIN_MERA_TOPIC_IDS] },
          minItems: 1,
          maxItems: 3,
          description: '1 to 3 topic ids.',
        },
      },
      required: ['topics'],
    },
  },
};

export const DELETE_FACTS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'deleteUserFacts',
    description:
      'Offer to remove facts the user asked you to remove. Pass EXACT fact ids from the known facts, or all: true when they want everything gone. Nothing is removed by this call: a card lists the facts and the user taps Remove or Keep, so never ask about the removal with ask_choice.',
    parameters: {
      type: 'object',
      properties: {
        fact_ids: { type: 'array', items: { type: 'string' }, description: 'Exact fact ids.' },
        all: { type: 'boolean', description: 'true when the user wants every fact removed.' },
      },
      required: [],
    },
  },
};

/**
 * A CARD the user confirms: filters and source preferences (the persona's four
 * kinds). Staging changes nothing; the card's tap, or the user agreeing in
 * words (`applyProposal`), applies it. ENDS THE TURN, like `ask_choice`.
 */
export const PROPOSE_CHANGES_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'proposeChanges',
    description:
      'Put a change on a card for the user to confirm. Nothing changes until they agree. Use for "stop showing me X" '
      + '(add_suppression), "show me X again" (retire_suppression with an id from <filters>), more or less or mute of a '
      + 'named outlet (set_publication_pref) and "prefer <country> sources" (set_source_scope_pref). This ENDS your turn.',
    parameters: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'What the card does, one sentence.' },
        expected_effects: { type: 'string', description: 'What changes in their news, one sentence.' },
        actions: {
          type: 'array',
          description: 'The smallest list of changes.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['add_suppression', 'retire_suppression', 'set_publication_pref', 'set_source_scope_pref'],
              },
              suppressionPattern: { type: 'string', description: 'add_suppression: the phrase to hide, in English, in their own words.' },
              suppressionStrength: { type: 'number', description: 'add_suppression: 0.9 never show it, 0.5 less of it.' },
              suppressionId: { type: 'string', description: 'retire_suppression: an id from <filters>. Never invent one.' },
              publicationId: { type: 'string', description: 'set_publication_pref: the outlet name exactly as they said it.' },
              scopeCountry: { type: 'string', description: 'set_source_scope_pref: the country in English.' },
              publicationPref: {
                type: 'string',
                enum: ['boost', 'deprioritize', 'mute'],
                description: 'set_source_scope_pref takes boost or deprioritize only.',
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['explanation', 'expected_effects', 'actions'],
    },
  },
};

/** The user agreed, in words, to the card that is waiting. Offered only while
 *  that card may be applied by typing (one option, nothing tap-only). */
export const APPLY_PROPOSAL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'applyProposal',
    description: 'Apply the card that is waiting, because the user just agreed to it. Never on anything else they said.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

/** The user declined the card that is waiting. */
export const CANCEL_PROPOSAL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'cancelProposal',
    description: 'Drop the card that is waiting, because the user said no to it.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

/** What the driver says about the card waiting for the user, for the tools a
 *  leg may carry. */
export interface PendingCardTools {
  /** Typed agreement may apply it (one option, nothing tap-only). */
  appliable: boolean;
}

/** Every tool a skill's `tools:` list may name, in declaration order. Pinned
 *  to the generator's KNOWN_SKILL_TOOLS by a test. */
export const SKILL_TOOL_ORDER = [
  'find_similar_facts', 'lookup_place', 'ask_choice', 'saveExtractedFacts', 'deleteUserFacts',
  'webSearch', 'explainMera', 'proposeChanges', 'applyProposal', 'cancelProposal',
] as const;

const SKILL_TOOL_DEFS: Record<(typeof SKILL_TOOL_ORDER)[number], ToolDefinition> = {
  find_similar_facts: FIND_SIMILAR_FACTS_TOOL,
  lookup_place: LOOKUP_PLACE_TOOL,
  ask_choice: ASK_CHOICE_TOOL,
  saveExtractedFacts: SAVE_FACTS_TOOL,
  deleteUserFacts: DELETE_FACTS_TOOL,
  webSearch: WEB_SEARCH_TOOL,
  explainMera: EXPLAIN_MERA_TOOL,
  proposeChanges: PROPOSE_CHANGES_TOOL,
  applyProposal: APPLY_PROPOSAL_TOOL,
  cancelProposal: CANCEL_PROPOSAL_TOOL,
};

/**
 * The tools a skill lists, for an id with no `tools:` frontmatter (a skill a
 * test injects). The generated index carries the same lists for every real
 * skill, and a test pins the two to agree.
 */
function fallbackSkillTools(skillId: string): readonly string[] {
  if (skillId.startsWith('facts/')) {
    return ['find_similar_facts', 'lookup_place', 'ask_choice', 'saveExtractedFacts', 'deleteUserFacts', 'webSearch'];
  }
  if (skillId === 'conversation/correction') {
    return ['find_similar_facts', 'lookup_place', 'ask_choice', 'saveExtractedFacts', 'deleteUserFacts'];
  }
  if (skillId === 'conversation/question') return ['find_similar_facts', 'lookup_place', 'ask_choice', 'webSearch'];
  if (skillId === 'conversation/about-mera') return ['find_similar_facts', 'lookup_place', 'ask_choice', 'explainMera'];
  return ['find_similar_facts', 'lookup_place', 'ask_choice'];
}

/**
 * The tools a leg is offered, which is NOT one fixed list.
 *
 *  - ROUTE leg (nothing loaded): `load_skill`, and while a card waits and is
 *    the most recent ask, `applyProposal` (when appliable) and
 *    `cancelProposal`: a reply that agrees to the card is answered there
 *    instead of being routed as a new intent.
 *  - SKILL leg: the skill's own `tools:` list, filtered by what the device
 *    offers (web search, explainMera, the card tools) and the card's state.
 *  - FORCED leg: saveExtractedFacts and ask_choice only, the two calls that
 *    answer "propose something now".
 *
 * WHY THE ROUTE LEG GETS ONE TOOL: of 99 G2d route legs that loaded no skill,
 * 9 discharged "call a tool" with a discovery tool instead of routing. A tool
 * the model cannot see is one it cannot spend a leg on.
 */
export function toolsForLeg(opts: {
  skillLoaded: string | null;
  /** The skill's `tools:` list, or null to use the built-in fallback. */
  skillTools?: readonly string[] | null;
  forcingProposal?: boolean;
  /** The `pre-enforcement` control arm only: the route leg carries all four
   *  discovery tools, as it did when the 99 no-route legs were measured. */
  wideRouteLeg?: boolean;
  /** False once another segment of the same turn has asked its question: one
   *  question per turn, so later segments put other readings on the card. */
  allowChoice?: boolean;
  /** The device offers web search (the setting is on). */
  webSearch?: boolean;
  /** The device offers explainMera. */
  explainMera?: boolean;
  /** The device offers the card tools. */
  cards?: boolean;
  /** The card waiting for the user, or null. */
  pendingCard?: PendingCardTools | null;
  /** The waiting card is the most recent ask, so the route leg may answer it. */
  cardOnRouteLeg?: boolean;
}): ToolDefinition[] {
  if (opts.forcingProposal) return withoutChoice([SAVE_FACTS_TOOL, ASK_CHOICE_TOOL], opts.allowChoice);
  const cardTools = (): ToolDefinition[] =>
    opts.cards && opts.pendingCard
      ? [...(opts.pendingCard.appliable ? [APPLY_PROPOSAL_TOOL] : []), CANCEL_PROPOSAL_TOOL]
      : [];
  if (opts.skillLoaded === null) {
    if (opts.wideRouteLeg) return withoutChoice([...HARNESS_TOOLS], opts.allowChoice);
    return [LOAD_SKILL_TOOL, ...(opts.cardOnRouteLeg ? cardTools() : [])];
  }
  const listed = new Set(opts.skillTools ?? fallbackSkillTools(opts.skillLoaded));
  const offered = SKILL_TOOL_ORDER.filter((name) => {
    if (!listed.has(name)) return false;
    if (name === 'webSearch') return opts.webSearch === true;
    if (name === 'explainMera') return opts.explainMera === true;
    if (name === 'proposeChanges') return opts.cards === true;
    if (name === 'applyProposal') return opts.cards === true && opts.pendingCard?.appliable === true;
    if (name === 'cancelProposal') return opts.cards === true && !!opts.pendingCard;
    return true;
  });
  return withoutChoice(offered.map((name) => SKILL_TOOL_DEFS[name]), opts.allowChoice);
}

function withoutChoice(tools: ToolDefinition[], allowChoice?: boolean): ToolDefinition[] {
  return allowChoice === false ? tools.filter((t) => t.function.name !== 'ask_choice') : tools;
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
