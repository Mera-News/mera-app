// Mera Protocol — persona and topic-generation system prompts.
//
// Split out of ./prompts.ts, which kept the article-pipeline half (relevance,
// reason, headline, verifier). The two halves have different owners and are
// edited by different waves; one 1,956-line file made every edit a conflict.
//
// NOTHING HERE MOVED BY BYTE. Every prompt string is identical to its
// pre-split form, and `persona-prompts.golden.test.ts` pins the measured token
// size of each one so a later edit has to restate the number on purpose.
//
// IMPORT SITES DID NOT CHANGE. `./prompts.ts` re-exports this whole module, so
// the many existing importers of `../prompts/prompts` keep one import site.
import {
  BASELINE_VARIANT_ID,
  resolvePromptVariant,
  systemPromptForSlot,
  type PromptSlot,
  type PromptVariantId,
} from './prompt-variants';
// Import from here directly in new code; either path resolves to the same
// symbols.

import type { ToolDefinition } from '../core/types';
import { buildExampleQuestionsText } from './questionnaire-data';
import { asUntrusted } from './untrusted-text';
import { CLOUD_BASE_SLOTS } from '../../harnesses/slots.generated';
import { render } from '../../harnesses/template';

/**
 * Builds tool definitions in OpenAI JSON Schema format (sent to cloud backend).
 * Same tools as the XML format in buildToolFormatSection() — single source of truth.
 */
/**
 * How much of the "not interested" FILTERS feature this turn's prompt can
 * afford (not-interested P4a). The feature YIELDS TO THE USER'S DATA, never the
 * reverse: the persona's facts are the whole point of this prompt, our filter
 * rules are the newest and least essential thing in it.
 *
 *  - `full`    — the complete rules block + the three staged-proposal tools.
 *  - `compact` — a one-line rule + the same three tools (Mera can still stage a
 *                filter, it just gets less guidance).
 *  - `off`     — no filter rules and no filter tools. BYTE-IDENTICAL to the
 *                pre-P4a prompt, so a fact-saturated turn can never cost more
 *                than it did before this wave (useLocalLLM HARD-ERRORS a turn
 *                over budget — a dead turn is far worse than a turn where Mera
 *                can't stage a filter).
 *
 * The variant is chosen by MEASUREMENT per turn — see
 * persona-management/persona-agent-core::planPersonaPrompt.
 */
export type FilterToolsVariant = 'full' | 'compact' | 'off';

/**
 * DEEP MODE question bank (item 17) — used in place of the standard
 * `EXAMPLE_QUESTIONS` when the user turns "Deeper questions" on.
 *
 * REPLACES rather than extends, and that is a hard budget requirement, not a
 * style choice. The LOCAL path has a 3072-token input budget that HARD-ERRORS
 * the turn when exceeded, and the measured pre-existing worst case
 * (CONFIG + LOCAL + XML tools + 22 saturated facts) already sits at ~3008 with
 * ~64 to spare. Appending a second bank would put a deep-mode user over that
 * line, and the filters ladder cannot save them — its last rung still carries
 * the question bank. So this list is deliberately SHORTER than the standard
 * one, and `persona-agent-core.test.ts` asserts the deep prompt is no larger.
 *
 * The first four keep the anchors relevance actually needs (place, work); the
 * rest are the deeper interview. Note what is NOT here: nothing asks the user
 * to route an alert or schedule a briefing. There is no briefing in this app
 * and notifications are an hourly cron, so a question implying urgency routing
 * would be a promise the code does not honour. "Same day vs. can wait" is
 * asked as an IMPORTANCE signal — which is real (the feed's High/Med/Low
 * filter) — and its answers land as ordinary local facts feeding relevance and
 * reason generation.
 */
export const DEEP_EXAMPLE_QUESTIONS: string[] = [
  'Where do you live? (neighborhood, city, country)',
  'What do you do for work? (role, company, industry)',
  'Why does that place matter to you — family, work, safety, money, or travel?',
  'What are you trying to protect your attention from?',
  'Which topics feel necessary but leave you anxious?',
  'Which topics feel useful but mostly waste your time?',
  'What decisions are you weighing this month?',
  'Whose lives elsewhere do you keep an eye on?',
  'Which news matters to you the same day, and which can wait?',
  'What would you regret not hearing about?',
];

/** The numbered question list for the system prompt. `deepMode` swaps the bank
 *  wholesale — with it off this returns the pre-item-17 string byte for byte. */
function buildQuestionBankText(deepMode: boolean): string {
  if (!deepMode) return buildExampleQuestionsText();
  return DEEP_EXAMPLE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

export function buildToolDefinitions(
  surface: 'ONBOARDING' | 'CONFIG',
  filterTools: FilterToolsVariant = 'full',
  /** False On this phone: recalibration is a cloud scoring call, so it is not offered. */
  canCalibrate: boolean = true,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'saveExtractedFacts',
        description: 'OFFER facts from the user message for them to confirm. Nothing is saved until the user taps a reading on the card. Call in every response (empty array if no new facts).',
        parameters: {
          type: 'object',
          properties: {
            extracted_user_information: {
              type: 'array',
              description: 'New facts from the user message. Empty if none.',
              items: {
                type: 'object',
                properties: {
                  statement: { type: 'string', description: 'Fact in English, <200 chars. Your BEST reading of what they said.' },
                  questionnaire_attribute: { type: 'string', description: 'Full attribute string (e.g. "location: neighborhood/area, city, and country")' },
                  alternatives: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '0-3 OTHER readings of the SAME thing they said, offered beside `statement` so they pick. Add one ONLY when the readings would produce DIFFERENT topics. Omit when there is one sensible reading — one option is one tap.',
                  },
                },
                required: ['statement'],
              },
            },
          },
          required: ['extracted_user_information'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'updateUserConfig',
        description: 'Set the user\'s language preference codes.',
        parameters: {
          type: 'object',
          properties: {
            language_codes: {
              type: 'array',
              description: 'Language codes',
              items: { type: 'string' },
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'issueWarning',
        description: 'Warn an off-topic or abusive user. Chat blocks at 3 warnings.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Reason' },
          },
          required: ['reason'],
        },
      },
    },
  ];

  if (surface === 'CONFIG') {
    tools.push({
      type: 'function',
      function: {
        name: 'deleteUserFacts',
        description: 'Delete facts when the user explicitly asks to remove or correct information about the SAME subject.',
        parameters: {
          type: 'object',
          properties: {
            fact_ids: {
              type: 'array',
              description: 'Questionnaire attribute strings (the key before \': \' in Known Facts, e.g. "location: neighborhood/area, city, and country (preserve specifics)")',
              items: { type: 'string' },
            },
          },
          required: ['fact_ids'],
        },
      },
    });
    // not-interested P4a (D6): filters are manageable in PLAIN persona chat, not
    // only from an article. Same staged-proposal contract as the
    // ArticleFeedbackAgent — nothing is applied until the user taps confirm.
    // CONFIG only: onboarding has no feed yet, so there is nothing to filter.
    // Omitted entirely at the `off` variant (see FilterToolsVariant).
    if (filterTools !== 'off') {
      tools.push({
        type: 'function',
        function: {
          name: 'proposeChanges',
          description:
            filterTools === 'full'
              ? 'Stage a "not interested" filter change or a SOURCE preference for the user to confirm — NEVER applies it directly. Use for "stop showing me X" (add_suppression), "show me X again" / "remove that filter" (retire_suppression), "more from" or "hide <outlet>" (set_publication_pref) and "prefer <country> sources" (set_source_scope_pref).'
              : 'Stage a "not interested" filter change for the user to confirm — NEVER applies it directly. Use for "stop showing me X" (add_suppression) and "show me X again" / "remove that filter" (retire_suppression).',
          parameters: {
            type: 'object',
            properties: {
              explanation: { type: 'string', description: 'Why (≤2 sentences).' },
              expected_effects: { type: 'string', description: 'What changes in the feed (≤2 sentences).' },
              actions: {
                type: 'array',
                description: 'Minimal list of filter changes.',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      // source-pref v47: the two SOURCE actions ride the `full`
                      // rung ONLY. The degradation ladder's `compact` rung keeps
                      // exactly the pre-source-pref filter feature, so both the
                      // prose (FILTERS_PROMPT_SECTION_COMPACT) and the schema
                      // below stay byte-identical there — the ~104-token
                      // headroom does not stretch to carrying them twice.
                      enum:
                        filterTools === 'full'
                          ? [
                              'add_suppression',
                              'retire_suppression',
                              'set_publication_pref',
                              'set_source_scope_pref',
                            ]
                          : ['add_suppression', 'retire_suppression'],
                      description: 'Action kind.',
                    },
                    suppressionPattern: {
                      type: 'string',
                      description:
                        'add_suppression: the phrase to hide, in English, in the user\'s own words. Matched as text anywhere in a story — do not invent a category or section name.',
                    },
                    suppressionStrength: {
                      type: 'number',
                      description: 'add_suppression: 0.9 = never show it, 0.5 = just less of it (defaults to a strong value).',
                    },
                    suppressionId: {
                      type: 'string',
                      description: 'retire_suppression: the [id] of a row in the YOUR FILTERS block of <context>. Never invent one.',
                    },
                    // source-pref v47 (D5). NOTE: `schemaTypeToString` never
                    // emits `enum` or `description` into the local-LLM XML
                    // prompt — only `"name"?: type`. So every allowed value
                    // here is ALSO spelled out in FILTERS_PROMPT_SECTION_FULL,
                    // which is the only channel the local path reads. These
                    // descriptions are therefore free (cloud-only) budget.
                    ...(filterTools === 'full'
                      ? {
                          publicationId: {
                            type: 'string',
                            description:
                              'set_publication_pref: the outlet name EXACTLY as the user said it (e.g. "The Times of India"). Never invent or expand a name — an unrecognised one is discarded.',
                          },
                          scopeCountry: {
                            type: 'string',
                            description:
                              'set_source_scope_pref: the country whose outlets to prefer, as its English NAME (e.g. "India", "Germany"). Not a code, not a nationality, not a region.',
                          },
                          publicationPref: {
                            type: 'string',
                            enum: ['boost', 'mute'],
                            description:
                              'set_publication_pref: boost | mute. set_source_scope_pref: boost ONLY.',
                          },
                        }
                      : {}),
                  },
                  required: ['type'],
                },
              },
            },
            required: ['explanation', 'expected_effects', 'actions'],
          },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'applyProposal',
          description: 'Apply the pending filter proposal when the user confirms.',
          parameters: { type: 'object', properties: {} },
        },
      });
      tools.push({
        type: 'function',
        function: {
          name: 'cancelProposal',
          description: 'Discard the pending filter proposal when the user declines.',
          parameters: { type: 'object', properties: {} },
        },
      });
    }
    if (canCalibrate) tools.push({
      type: 'function',
      function: {
        name: 'runCalibration',
        description: 'Run the scoring recalibration the user was invited to. ONLY call when the user explicitly confirms recalibrating.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    });
  }

  return tools;
}

/**
 * Converts a ToolDefinition's JSON Schema parameters into a compact type signature
 * for the local LLM XML prompt (e.g. `{"fact_ids": string[]}`).
 */
function schemaToCompactSignature(params: ToolDefinition['function']['parameters']): string {
  const props = params.properties;
  const required = new Set(params.required ?? []);
  const entries = Object.entries(props);
  if (entries.length === 0) return '{}';

  const parts = entries.map(([key, schema]) => {
    const opt = required.has(key) ? '' : '?';
    const typeStr = schemaTypeToString(schema as Record<string, unknown>);
    return `"${key}"${opt}: ${typeStr}`;
  });
  return `{${parts.join(', ')}}`;
}

function schemaTypeToString(schema: Record<string, unknown>): string {
  const type = schema.type as string | undefined;
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (!items) return 'any[]';
    if (items.type === 'object') {
      const nested = schemaToCompactSignature(items as ToolDefinition['function']['parameters']);
      return `[${nested}]`;
    }
    return `${items.type as string}[]`;
  }
  return type ?? 'any';
}

/**
 * Builds the XML tool format section (tool definitions, rules, and examples).
 * Tool listing is derived from buildToolDefinitions() — single source of truth.
 */
export function buildToolFormatSection(
  surface: 'ONBOARDING' | 'CONFIG',
  filterTools: FilterToolsVariant = 'full',
  canCalibrate: boolean = true,
): string {
  const isOnboarding = surface === 'ONBOARDING';

  const tools = buildToolDefinitions(surface, filterTools, canCalibrate);
  const toolLines = tools
    .map((t) => `- ${t.function.name}: ${schemaToCompactSignature(t.function.parameters)}`)
    .join('\n');

  return render(CLOUD_BASE_SLOTS["persona/tool-format"], { toolLines, isOnboarding });
}

/**
 * The "not interested" FILTERS section (not-interested P4a, D6) — CONFIG only
 * (onboarding has no feed yet, so there is nothing to filter). Shared verbatim
 * by the CLOUD and LOCAL prompt variants so the two paths can't drift.
 *
 * Wording is deliberately keyword-first: this surface has no article in front
 * of it, so there is nothing to copy a structured field value from and nothing
 * to validate one against. A phrase the user said always matches as text; an
 * invented category name would match nothing (see D9). The article-feedback
 * agent is the surface that mints structured filters.
 */
const FILTERS_PROMPT_SECTION_FULL = CLOUD_BASE_SLOTS["persona/filters-prompt-section-full"];

/** The degraded rung: the same two FILTER actions and the same
 *  never-apply-directly rule, minus the worked detail. ~a third of the full
 *  section's tokens.
 *
 *  source-pref v47 — DELIBERATELY UNCHANGED. The two SOURCE actions do NOT
 *  survive here (and `buildToolDefinitions` drops their schema properties at
 *  this rung to match). A turn that has already yielded its filters block is
 *  one where the user's own facts are crowding the budget; spending ~70 more
 *  tokens to keep a *second* feature alive there would push the `compact` rung
 *  toward `off` and cost the user the filter tools entirely. Source
 *  preferences are also reachable from the Source-preferences screen, which
 *  filters are not — so this is the cheaper thing to drop. */
const FILTERS_PROMPT_SECTION_COMPACT = CLOUD_BASE_SLOTS["persona/filters-prompt-section-compact"];

/** Resolves the FILTERS rules block for a variant. `off` contributes nothing at
 *  all, which is what makes that rung byte-identical to the pre-P4a prompt. */
function filtersPromptSection(variant: FilterToolsVariant): string {
  if (variant === 'full') return FILTERS_PROMPT_SECTION_FULL;
  if (variant === 'compact') return FILTERS_PROMPT_SECTION_COMPACT;
  return '';
}

/**
 * Builds the STATIC persona update system prompt.
 * Contains only session-constant content: role, rules, fact rules, config rules, tool format.
 * Dynamic data (known facts, questionnaire, config) is provided via buildPersonaUpdateContext().
 */
export function buildPersonaUpdateStaticPrompt(params: {
  surface: 'ONBOARDING' | 'CONFIG';
  /** When false, omits XML tool format instructions (AI SDK handles tool calling natively). Default true. */
  includeToolFormat?: boolean;
  /** Human-readable name of the user's app language (e.g. "Hindi", "Spanish").
   *  When provided, the LLM is instructed to respond in this language. */
  languageName?: string;
  /** Inference path. CLOUD = Qwen3.5-122B-A10B (large MoE, holds the full
   *  rubric); LOCAL = Qwen3.5-4B on-device (qwen35 architecture; richer than
   *  the over-compressed Qwen3 4B prompt would imply — see
   *  buildPersonaUpdateLocalPrompt for the architecture-aware rationale). */
  mode?: 'CLOUD' | 'LOCAL';
  /** not-interested P4a: how much of the FILTERS feature this turn can afford.
   *  Chosen by measurement per turn (planPersonaPrompt); `off` reproduces the
   *  pre-P4a prompt exactly. Defaults to `full`. */
  filterTools?: FilterToolsVariant;
  /** item 17 — swap in the deeper question bank. Applies to BOTH paths (the
   *  bank is smaller than the standard one, so LOCAL stays inside budget). */
  deepMode?: boolean;
  /** False On this phone: no runCalibration tool and no line about it. Default true. */
  canCalibrate?: boolean;
  /** item 13 — the user's "Web search in chat" toggle. CLOUD-only prose, and
   *  only when ON: an off toggle must cost zero prompt tokens. */
  webSearch?: boolean;
  /** Experiment arm. Omitted or 'baseline' returns the shipped prompt BYTE FOR
   *  BYTE; an unknown id throws rather than silently scoring the control. The
   *  arm supplies a WHOLE replacement string, never a transform — see
   *  prompt-variants.ts for why. */
  promptVariant?: PromptVariantId;
}): string {
  const {
    surface,
    includeToolFormat = true,
    languageName,
    mode = 'CLOUD',
    filterTools = 'full',
    deepMode = false,
    webSearch = false,
    promptVariant,
    canCalibrate = true,
  } = params;
  const isOnboarding = surface === 'ONBOARDING';

  // The arm's whole-string override, resolved once and applied to whichever
  // mode's prompt is built below. Placed here rather than at each return so
  // CLOUD and LOCAL cannot drift over which one honours an arm; `baseline`
  // resolves to no override and both paths return their shipped bytes.
  const variantSpec = resolvePromptVariant(promptVariant);
  const armPrompt = variantSpec.systemPrompts?.personaStatic;
  if (armPrompt !== undefined) return armPrompt;

  if (mode === 'LOCAL') {
    // `webSearch` is deliberately NOT forwarded: the LOCAL path carries neither
    // search tool (both are appended CLOUD-only at the getPersonaToolDefinitions
    // seam), so prose about them would be instructions for tools that do not
    // exist — and bytes the 3072-token budget cannot spare.
    return buildPersonaUpdateLocalPrompt({
      surface,
      includeToolFormat,
      languageName,
      filterTools,
      deepMode,
      canCalibrate,
    });
  }

  const toolSection = includeToolFormat ? buildToolFormatSection(surface, filterTools, canCalibrate) : '';
  const filtersSection = filtersPromptSection(filterTools);
  const questionBank = buildQuestionBankText(deepMode);

  return render(CLOUD_BASE_SLOTS["persona/static"], { isOnboarding, toolSection, canCalibrate, filtersSection, webSearch, questionBank, languageName });
}

/**
 * LOCAL variant — Qwen3.5-4B on-device (architecture qwen35, base
 * `Qwen/Qwen3.5-4B`, GGUF Q4_K_M via unsloth). Stronger instruction follower
 * than Qwen3 4B — can carry the full Facts rubric reliably as long as
 * procedures are imperatively numbered. Compared to the cloud (Qwen3.5-122B-
 * A10B) variant: dropped the Per-turn order intro fluff, collapsed the
 * languageRule to one line, kept the off-script extraction rule inline at
 * the top of Rules where the 4B can't miss it, kept a single anchoring
 * example instead of two.
 */
function buildPersonaUpdateLocalPrompt(params: {
  surface: 'ONBOARDING' | 'CONFIG';
  includeToolFormat: boolean;
  languageName?: string;
  filterTools?: FilterToolsVariant;
  deepMode?: boolean;
  canCalibrate?: boolean;
}): string {
  const { surface, includeToolFormat, languageName, filterTools = 'full', deepMode = false, canCalibrate = true } = params;
  const isOnboarding = surface === 'ONBOARDING';

  const toolSection = includeToolFormat ? buildToolFormatSection(surface, filterTools, canCalibrate) : '';
  const filtersSection = filtersPromptSection(filterTools);
  const questionBank = buildQuestionBankText(deepMode);

  return render(CLOUD_BASE_SLOTS["persona/local"], { isOnboarding, includeToolFormat, toolSection, canCalibrate, filtersSection, questionBank, languageName });
}

/**
 * Builds the DYNAMIC context block injected into user messages.
 * The questionnaire is omitted entirely — just Known Facts (+ filters/proposal).
 */
export function buildPersonaUpdateContext(params: {
  knownFactsList: string;
  /** not-interested P4a: pre-rendered `- [id] "phrase"` rows of the user's
   *  ACTIVE filters. Omitted (not empty-stated) when there are none, so a user
   *  with no filters pays zero tokens for the feature. */
  filtersList?: string;
  /** not-interested P4a: pre-rendered body of the in-flight staged proposal.
   *  Re-injected every turn so the one-shot LOCAL path can still confirm. */
  pendingProposal?: string;
  /** Pre-rendered record of what the user did with topic-plan cards this
   *  session. Omitted (not empty-stated) when they have answered none. */
  topicPlanNotesList?: string;
}): string {
  const { knownFactsList, filtersList, pendingProposal, topicPlanNotesList } = params;

  const blocks: string[] = [];

  blocks.push(`## Known Facts\n${knownFactsList}`);

  // Placed AFTER Known Facts (which it annotates) and BEFORE the filters and
  // pending-proposal blocks, so `## PENDING PROPOSAL`'s imperative tail stays
  // the last thing in <context> exactly as it was.
  if (topicPlanNotesList) {
    blocks.push(
      `## TOPIC PLAN DECISIONS (already applied — do not repeat or undo them)\n${topicPlanNotesList}`,
    );
  }
  if (filtersList) {
    blocks.push(
      `## YOUR FILTERS (already hidden — retire_suppression removes one by [id])\n${filtersList}`,
    );
  }
  if (pendingProposal) {
    blocks.push(
      `## PENDING PROPOSAL\n${pendingProposal}\nIf the user confirms call applyProposal; if they decline call cancelProposal.`,
    );
  }

  return `<context>\n${blocks.join('\n\n')}\n</context>`;
}

// ============================================================
// Topic Generation Prompt — On-device topic generation from user facts
// ============================================================

/**
 * Shared CLOUD fact-only rules + examples — single source of truth embedded
 * by both `CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT` (real fact-only generation)
 * and `NOISE_GENERATION_SYSTEM_PROMPT` (which runs the same rules against a
 * model-invented decoy fact). Anchoring, granularity, big-country exception,
 * and examples live here and only here.
 */
export const CLOUD_TOPIC_GEN_RULES_SNIPPET = CLOUD_BASE_SLOTS["topic-gen/cloud-topic-gen-rules-snippet"];

/**
 * CLOUD fact-only topic-generation prompt — Qwen3-30B-A3B-Instruct-2507.
 * One of two parallel prompts per fact (the other being the combo prompt
 * below). This prompt sees ONLY the Fact and the optional User location —
 * never Other user facts. The caller specifies the exact topic count in the
 * user message ("Generate N topics") so the same prompt powers both the
 * "no Other facts → full count" fallback and the "half-with, half-without"
 * split case.
 */
export const CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["topic-gen/cloud-topic-generation-system-prompt"];

/**
 * CLOUD combo topic-generation prompt — Qwen3-30B-A3B-Instruct-2507.
 * Runs in parallel with the fact-only prompt above (same fact, same model,
 * one batch HTTP call). Sees Fact + User location + Other user facts and is
 * REQUIRED to weave one Other fact into every topic as a qualifier. The
 * caller never invokes this prompt when there are zero Other facts.
 */
export const CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["topic-gen/cloud-fact-combo-topic-generation-system-prompt"];

/**
 * THE DEFERRED COMBINATION PASS (ux2 F3). Topic generation per fact is
 * isolated; the topics that exist only because two facts sit side by side
 * come from this pass, which runs once per fact after a Profile chat that
 * changed facts closes (cloud only), over the fact plus up to 25 supporting
 * facts and with NO location line.
 *
 * DERIVED from the shipped combo prompt, which stays byte-identical so the
 * topic eval's 'current' arm keeps measuring today's behaviour. The edits drop
 * the "User location" input and every reference to a sibling fact-only call;
 * where the user lives now arrives as one of the Other user facts. Each edit
 * is exact text; `combo-pass-prompt.test.ts` fails if any stops matching.
 */
const COMBO_PASS_EDITS: readonly (readonly [string, string])[] = [
  [
    '2. **User location** (optional) — where the user CURRENTLY LIVES, as the raw statement of their residence fact. A PLACE ANCHOR only: read the place out of it and IGNORE anything else it mentions (origin, profession, family). Origin appearing there never makes a work/interest Fact a diaspora topic.\n3. **Other user facts**',
    '2. **Other user facts**',
  ],
  [
    'output `[]` — the sibling fact-only prompt will cover the user.',
    'output `[]`: the Fact already has its own topics.',
  ],
  [' Ignore User location.', ''],
  [
    '- **(b)** No Fact location, User location given, Fact is personal/local → anchor to User location, full chain.',
    '- **(b)** No Fact location, an Other fact says where the user lives, Fact is personal/local → anchor to that place, full chain.',
  ],
  [
    '- **(c)** Fact is global/professional → unanchored. Never use User location.',
    '- **(c)** Fact is global/professional → unanchored. Never anchor it to where the user lives.',
  ],
  [
    '- No duplicates within this output OR with the sibling fact-only output (assume the sibling already covered plain Fact-only anchors).',
    '- No duplicates within this output, and nothing that restates the Fact alone: the Fact already has its own topics.',
  ],
  ['User location: Amsterdam, Netherlands\nOther user facts: ', 'Other user facts: Lives in Amsterdam, Netherlands; '],
  [
    'Empty is correct —\nthe sibling fact-only prompt still covers this fact.)',
    'Empty is correct:\nthe Fact already has its own topics.)',
  ],
  // NAME THE FACT (ux2 F6, measured: 40 of 146 combination topics named no
  // word of their own fact). The rule, and the shipped examples that broke it.
  [
    '## Count rule (hard requirement',
    '## Name the Fact (hard requirement)\nEvery topic contains at least one word from the Fact itself: its place, role, team, thing or group, spelled as the Fact spells it. "Bhopal elder care" for "Parents live in Bhopal"; never "India remittance rules", which names no word of the Fact. A topic only a reader of the Other facts would connect to the Fact is dropped.\n\n## Count rule (hard requirement',
  ],
  ['"Bhopal AI elder-care apps", "India remittance rules for tech expats" (Fact-subject preserved)', '"Bhopal AI elder-care apps", "Bhopal elder care for tech families" (Fact-subject preserved)'],
  ['"international schools Amsterdam"', '"Amsterdam expat international schools"'],
  ['"Randstad international school options"', '"Randstad expat school options"'],
  [
    '["DeepMind Amsterdam recruitment", "UK-EU AI talent mobility", "Formula 1 AI research", "DeepMind racing simulation"]',
    '["DeepMind Amsterdam recruitment", "DeepMind UK-EU engineer mobility", "DeepMind racing simulation"]',
  ],
];

export const COMBO_PASS_TOPIC_SYSTEM_PROMPT = COMBO_PASS_EDITS.reduce(
  (prompt, [from, to]) => prompt.split(from).join(to),
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
);

/** Combination topics per fact: a ceiling, and most facts share no overlap. */
export const COMBO_PASS_MAX_TOPICS = 4;

/** The pass's user message: the fact, its supporting facts, the ceiling. No
 *  location line: where the user lives is one of the supporting facts. */
export function buildComboPassUserMessage(
  fact: string,
  supporting: readonly string[],
  ceiling: number = COMBO_PASS_MAX_TOPICS,
  places?: string | null,
): string {
  const clean = (t: string) => asUntrusted(t, t.length);
  return [
    `Fact: "${clean(fact)}"`,
    ...(places ? [`Place: ${clean(places)}`] : []),
    `Other user facts: ${supporting.map(clean).join('; ')}`,
    `Generate at most ${ceiling} topics`,
  ].join('\n');
}

/**
 * The cloud topic-generation system prompt for one call half, honouring an
 * experiment arm.
 *
 * Exists so the two constants have a single resolution point: `baseline`
 * returns the shipped constant by reference, an arm returns its whole
 * replacement string, and an unknown id throws instead of quietly scoring the
 * control. The constants stay exported because the golden pin asserts
 * re-export identity BY REFERENCE and because `topic-generation.ts` still
 * accepts them as an injected `systemPrompts` pair.
 */
export function buildTopicGenSystemPrompt(
  kind: 'factOnly' | 'combo',
  promptVariant: PromptVariantId = BASELINE_VARIANT_ID,
): string {
  const shipped =
    kind === 'factOnly'
      ? CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT
      : CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT;
  const slot: PromptSlot = kind === 'factOnly' ? 'topicGenFactOnly' : 'topicGenCombo';
  return systemPromptForSlot(slot, shipped, resolvePromptVariant(promptVariant));
}


/**
 * Shared LOCAL fact-only rules + examples — single source of truth embedded
 * by `LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT` and the LOCAL noise prompt.
 * Trimmed examples vs. the cloud variant because the 4B starts duplicating
 * past ~18 outputs.
 */
export const LOCAL_TOPIC_GEN_RULES_SNIPPET = CLOUD_BASE_SLOTS["topic-gen/local-topic-gen-rules-snippet"];

/**
 * LOCAL fact-only topic-generation prompt — Qwen3.5-4B on-device. The caller
 * specifies the exact count in the user message. Sees ONLY the Fact and
 * optional User location — a sibling combo prompt below handles Other-fact
 * combinations.
 */
export const LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["topic-gen/local-topic-generation-system-prompt"];

/**
 * LOCAL combo topic-generation prompt — Qwen3.5-4B on-device. Mirrors the
 * cloud combo prompt: weaves Other facts into Fact-subject topics. Run as a
 * second sequential local call (the 4B has no batch path). Caller skips this
 * prompt when otherFacts.length === 0.
 */
export const LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["topic-gen/local-fact-combo-topic-generation-system-prompt"];

/**
 * Back-compat alias. New code should import the explicit CLOUD_/LOCAL_ pair
 * and choose by mode at the call site (see topic-generation-service.ts and
 * topic-gen-handler.ts).
 */
/**
 * TOPIC SANITY prompt (r12 K-P3) — judges whether each already-minted topic
 * genuinely belongs to the fact that owns it. Runs in the weekly hygiene sweep
 * over topics the user has not yet had audited.
 *
 * Deliberately NARROW: it answers "does this topic belong to this fact?", NOT
 * "is this a good topic". A false positive retires something the user may want,
 * so the instruction is to keep anything defensible and only flag the clear
 * mash-ups the old combo prompt produced.
 */
export const TOPIC_SANITY_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["topic-gen/topic-sanity-system-prompt"];

export const TOPIC_GENERATION_SYSTEM_PROMPT = CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT;

/**
 * Decoy generation via ENTITY SUBSTITUTION. Given the user's Fact and the
 * real topics produced for it, identify every concrete entity that appears
 * (place chain, profession, organization, role, project, etc.) and rewrite
 * each topic with a parallel-shape unrelated replacement applied
 * consistently. The output is shape-matched to the input automatically — no
 * vocabulary asymmetry, no volume asymmetry, no fabricated "decoy persona"
 * combos to invent — because the structure is copied from the real topics
 * one-to-one.
 */
export const NOISE_GENERATION_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["topic-gen/noise-generation-system-prompt"];

export const LOCAL_NOISE_GENERATION_SYSTEM_PROMPT = NOISE_GENERATION_SYSTEM_PROMPT;
