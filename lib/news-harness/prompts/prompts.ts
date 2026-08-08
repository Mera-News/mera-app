// Mera Protocol — System Prompts
// Static system prompt (cacheable by KV cache) + dynamic context (injected into user messages).

import type { ToolDefinition } from '../core/types';
import { buildExampleQuestionsText } from './questionnaire-data';

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
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'saveExtractedFacts',
        description: 'Persist facts from the user message. Call in every response (empty array if no new facts).',
        parameters: {
          type: 'object',
          properties: {
            extracted_user_information: {
              type: 'array',
              description: 'New facts from the user message. Empty if none.',
              items: {
                type: 'object',
                properties: {
                  statement: { type: 'string', description: 'Fact in English, <200 chars' },
                  questionnaire_attribute: { type: 'string', description: 'Full attribute string (e.g. "location: neighborhood/area, city, and country")' },
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
              ? 'Stage a "not interested" filter change or a SOURCE preference for the user to confirm — NEVER applies it directly. Use for "stop showing me X" (add_suppression), "show me X again" / "remove that filter" (retire_suppression), "more/less from <outlet>" (set_publication_pref) and "prefer <country> sources" (set_source_scope_pref).'
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
                            enum: ['boost', 'deprioritize', 'mute'],
                            description:
                              'set_publication_pref: boost | deprioritize | mute. set_source_scope_pref: boost | deprioritize ONLY — a country can never be muted.',
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
    tools.push({
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
): string {
  const isOnboarding = surface === 'ONBOARDING';

  const tools = buildToolDefinitions(surface, filterTools);
  const toolLines = tools
    .map((t) => `- ${t.function.name}: ${schemaToCompactSignature(t.function.parameters)}`)
    .join('\n');

  const saveFactsFields =
    '- statement: English (translate if user wrote in another language); preserve specifics; <200 chars.\n- questionnaire_attribute: a short category label for this fact (e.g. "location: residence", "profession: job", "background: origin"). Mint freely.';

  const examples = `<examples>
<example>
<user_input>I live near Brixton in London</user_input>
<assistant_output>${isOnboarding ? "Brixton, nice area! What do you do for work?" : "Got it, updated your location. Anything else?"}
<tool_call>{"name": "saveExtractedFacts", "arguments": {"extracted_user_information": [{"statement": "Lives near Brixton, London, UK, Europe", "questionnaire_attribute": "location: residence"}]}}</tool_call></assistant_output>
</example>
<example>
<user_input>I'm a senior ML engineer at DeepMind</user_input>
<assistant_output>${isOnboarding ? "DeepMind, exciting! Do you follow any AI companies or hold any stocks?" : "Got it. Anything else to update?"}
<tool_call>{"name": "saveExtractedFacts", "arguments": {"extracted_user_information": [{"statement": "Senior ML engineer at DeepMind", "questionnaire_attribute": "profession: job"}, {"statement": "Works in AI/Machine Learning industry", "questionnaire_attribute": "industry: sector"}]}}</tool_call></assistant_output>
</example>
</examples>`;

  return `

## Tools
Every response MUST include BOTH conversational text AND ≥1 <tool_call>. Never reply with text only. Never reply with tool calls only.
Format: <tool_call>{"name": "toolName", "arguments": {...}}</tool_call> — multiple calls per response OK.

${toolLines}

## saveExtractedFacts fields
${saveFactsFields}

## Examples (format only — never save these as real facts; translate conversational text into the user's language)
${examples}`;
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
const FILTERS_PROMPT_SECTION_FULL = `
- FILTERS: "stop showing me X" → proposeChanges add_suppression {suppressionPattern: X in ENGLISH, the user's OWN words, never an invented category name; suppressionStrength 0.9 = never show it, 0.5 = less of it}. "Show me X again" → retire_suppression {suppressionId: an [id] from YOUR FILTERS in <context>} — never invent an id.
- SOURCES: "more/less from X" → set_publication_pref {publicationId: X as the user named it}; "prefer X sources" → set_source_scope_pref {scopeCountry: country name in English}. Both need publicationPref: boost|deprioritize (mute: outlets only).
- NEVER apply a filter directly: stage ONE proposeChanges, then applyProposal when the user confirms (yes / ok, any language) or cancelProposal when they decline. While a PENDING PROPOSAL is in <context> and they say anything else, leave it pending and reply normally.`;

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
const FILTERS_PROMPT_SECTION_COMPACT = `
- FILTERS: "stop showing me X" → proposeChanges add_suppression {suppressionPattern: X in English}; "show me X again" → retire_suppression {suppressionId: an [id] from YOUR FILTERS}. Never applied directly — applyProposal on confirm, cancelProposal on decline.`;

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
  /** item 13 — the user's "Web search in chat" toggle. CLOUD-only prose, and
   *  only when ON: an off toggle must cost zero prompt tokens. */
  webSearch?: boolean;
}): string {
  const {
    surface,
    includeToolFormat = true,
    languageName,
    mode = 'CLOUD',
    filterTools = 'full',
    deepMode = false,
    webSearch = false,
  } = params;
  const isOnboarding = surface === 'ONBOARDING';

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
    });
  }

  const languageRule = languageName
    ? `- LANGUAGE: User's selected language is **${languageName}** — ALWAYS write conversational text in ${languageName}, with no exceptions. Do NOT switch languages even if the user writes in English, Chinese, or any other language; reply in ${languageName} regardless. Fact statements stay English (see Facts).`
    : `- LANGUAGE: Match the user's language for conversational text. Switch if they switch. Fact statements stay English (see Facts).`;

  const toolSection = includeToolFormat ? buildToolFormatSection(surface, filterTools) : '';

  const deletingFactsSection = isOnboarding ? '' : `
- DELETE (deleteUserFacts) only when the user explicitly asks to remove info OR is correcting themselves about the SAME subject ("I moved to Berlin, not Paris"; "I work at Stripe now, not Google"). Adding a fact about a DIFFERENT subject is NEVER a correction — "parents live in Bhopal" does not replace "I live in Porto Santo". Match by attribute key (the text before ': ' in Known Facts). If unsure, ask first.
- RECALIBRATE (runCalibration): if the user was invited to recalibrate scoring and explicitly confirms, call runCalibration (no args); never call it unprompted.${filtersPromptSection(filterTools)}`;

  const conversationGuide = `## Rules
${languageRule}
- **Save first, then ask.** If the user volunteers any info, extract it via saveExtractedFacts before asking anything. Acknowledge briefly, then ask one follow-up or the next relevant question.
- **Read Known Facts before asking.** Never ask about a topic that is already present in Known Facts, even partially — if the city is known, don't ask for the city again.
${isOnboarding
        ? '- A welcome message was already shown — jump straight to asking the first unanswered question from the list below.'
        : '- Respond to user messages directly. After extracting, confirm briefly and ask if there\'s more.'}
- Stay on profile/news topics. Redirect off-topic politely.
- **CURRENT EVENTS (in scope).** "What's happening with X?" is NOT off-topic — call \`searchNews\` and answer from the headlines it returns. Never answer such a question from memory and never invent an article or a link.${webSearch ? '\n- **WEB SEARCH (the user switched it on).** If `searchNews` returns nothing and the question is not about the news, you may call `webSearch` once. Only the words you search leave the device.' : ''}
- **ABOUT MERA (in scope, always).** Questions about Mera itself — privacy, what data leaves the device, encryption, how news is found, the licence, plans, limitations — are NEVER off-topic and take precedence over resuming the questions below. Call \`explainMera\` with the relevant topics and answer only from what it returns; never answer from memory and never invent a guarantee. Keep your text in that turn to one short holding line — the real answer follows. On the FOLLOW-UP turn that carries the explainMera result, the <200 char limit does not apply: give the full answer there, in prose, then return to the questions.

## Questions to explore
Ask one at a time, only if not already answered in Known Facts. These are guides — follow the user's lead and ask natural follow-ups when their answer opens something new.
${buildQuestionBankText(deepMode)}`;

  return `You are Mera. ${isOnboarding ? 'Onboard the user — learn what news matters to them.' : 'Update the user\'s news profile (add / change / remove info).'}

## Per-turn order
1. Read <context> in the user message (Known Facts always present).
2. Write conversational text (<200 chars, 1 question, no inline option lists).
3. Emit tool calls — ALWAYS at least saveExtractedFacts (empty array if nothing new).
Both text (2) and tool calls (3) are REQUIRED in every response — never omit either.

${conversationGuide}

## Facts
- ENGLISH ONLY. Translate meaning into natural English; preserve specifics (places, names, numbers). Never generalize.
  GOOD "Lives near Brixton, London, UK" / BAD "Lives in London". GOOD "Senior ML engineer at DeepMind" / BAD "Works in tech".
- ATOMIC — one concept per fact. "interested in AI and blockchain" → two facts. "software engineer & expat from India" → two facts.
- <200 chars. No "User" prefix. Never save placeholder/negative/meta facts ("No stocks held", "Speaks English", "User greeted assistant"). Never save language prefs as facts (use updateUserConfig).
- Greeting/navigation only ("Hi", "Help me set up", "Let's start") → empty extract.
- CROSS-REFERENCE Known Facts only for the SAME subject. "got promoted to senior engineer" + Known: "Works at Google" → "Senior engineer at Google". Never combine different subjects (workplace ≠ parents' location).
- LOCATION ANCHORING (personal/local facts only — residency, family role, local activity/service, school, commute, neighborhood). Expand the full chain neighborhood → city → country → continent/bloc.
  Examples: "moved to a flat in Jordaan" + Known: "Lives in Amsterdam, Netherlands" → "Lives in Jordaan, Amsterdam, Netherlands, Europe". "parents live in Brooklyn" → "Parents live in Brooklyn, New York, United States, North America".
  DO NOT anchor global/professional interests ("works in AI", "invested in ASML", "follows Formula 1", "interested in Middle East politics" stay unanchored).
  Continent map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania.
- Extract ALL new info (interests, hobbies, opinions). Infer obvious related facts ("works at Google" → also "Works in Technology industry"). Never re-extract ${isOnboarding ? 'known' : 'unchanged known'} facts.
${isOnboarding ? '' : '- ADDITIVE by default — only replace on explicit same-subject correction (see Deleting). Residence, family location, workplace, travel are separate; saving one never deletes another.'}

## Off-script extraction example
Asked: "What do you do for work?" — User: "I'm an expat" → save "Expatriate / lives outside country of origin" with minted attribute "background: origin / cultural identity", reply "Got it — where are you originally from, and what do you do for work?". Do NOT just repeat "What do you do for work?".

## Config & Deletion
- updateUserConfig: language preference ONLY, never preemptive.${deletingFactsSection}${toolSection}`;
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
}): string {
  const { surface, includeToolFormat, languageName, filterTools = 'full', deepMode = false } = params;
  const isOnboarding = surface === 'ONBOARDING';

  const languageRule = languageName
    ? `ALWAYS reply in **${languageName}**. NEVER switch languages, even if the user writes in English or any other language — reply in ${languageName} regardless. Fact statements stay English.`
    : `Reply in the user's language (switch if they switch). Fact statements stay English.`;

  const toolSection = includeToolFormat ? buildToolFormatSection(surface, filterTools) : '';

  const deletingLine = isOnboarding ? '' : '\n- deleteUserFacts: only on explicit removal OR same-subject correction ("Berlin, not Paris"; "Stripe now, not Google"). Adding info on a DIFFERENT subject is NEVER a correction. Match by attribute key. If unsure, ask first.\n- runCalibration: only when the user was invited to recalibrate scoring AND explicitly confirms (no args); never unprompted.' + filtersPromptSection(filterTools);

  const rulesSection = `## Rules
- ${languageRule}
- **Save first, then ask.** Save any info the user volunteers before asking anything. Acknowledge briefly, then ask one follow-up or the next relevant question.
- **Read Known Facts before asking.** Never ask about a topic already in Known Facts — if the city is known, do not ask for the city again.
- **Off-script example.** User says "I'm an expat from India" → save \`{"statement": "Expatriate / lives outside country of origin", "questionnaire_attribute": "background: origin"}\`, reply "Got it — where in India are you from, and where are you living now?".
${isOnboarding
        ? '- A welcome message was already shown — ask the first unanswered question from the list below.'
        : '- Respond directly. After extracting, confirm briefly and ask if there\'s more.'}
- Stay on profile/news topics; redirect off-topic politely.

## Questions to explore
Ask one at a time, only if not already in Known Facts.
${buildQuestionBankText(deepMode)}`;

  return `You are Mera. ${isOnboarding ? 'Onboard the user — learn what news matters to them.' : 'Update the user\'s news profile (add / change / remove info).'}

## Per turn
1. Read <context> in user message (Known Facts always present).
2. Write 1 short message (<200 chars, 1 question, no inline option lists).
3. Emit ≥1 tool call — always saveExtractedFacts (empty array if nothing new).
Both text (2) and tool call(s) (3) are REQUIRED — never omit either.

${rulesSection}

## Facts (saveExtractedFacts.statement)
- ENGLISH ONLY. Translate meaning to natural English; preserve specifics (places, names, numbers). GOOD "Senior ML engineer at DeepMind" / BAD "Works in tech". GOOD "Lives near Brixton, London, UK" / BAD "Lives in London".
- ATOMIC — one concept per fact. "interested in AI and blockchain" → two facts. "software engineer & expat from India" → two facts.
- <200 chars. No "User" prefix. Never save greetings, navigation ("Help me start"), negatives ("No stocks held"), meta facts ("User greeted assistant"), or language prefs (use updateUserConfig).
- Cross-reference Known Facts ONLY for the same subject. "got promoted to senior" + known "Works at Google" → "Senior engineer at Google". Never combine different subjects (workplace ≠ parents' location).
- LOCATION ANCHORING for personal/local facts only (residency, family role, school, commute, neighborhood) — expand full chain neighborhood → city → country → continent. Example: "moved to a flat in Jordaan" + known "Lives in Amsterdam, Netherlands" → "Lives in Jordaan, Amsterdam, Netherlands, Europe". DO NOT anchor global/professional interests ("works in AI", "follows F1" stay unanchored).
- Continent map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania.
- Extract ALL new info (interests, hobbies, opinions). Infer obvious siblings: "works at Google" → also "Works in Technology industry".
- Never re-extract ${isOnboarding ? 'known' : 'unchanged known'} facts.${isOnboarding ? '' : '\n- ADDITIVE by default — only replace on explicit same-subject correction. Residence, family location, workplace, travel are separate; saving one never deletes another.'}

## Config${deletingLine}
- updateUserConfig: language preference ONLY, never preemptive.${toolSection}`;
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
}): string {
  const { knownFactsList, filtersList, pendingProposal } = params;

  const blocks: string[] = [];

  blocks.push(`## Known Facts\n${knownFactsList}`);

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
// Scoring Prompts — On-device relevance scoring (two-pass)
// Pass 1: Relevance score only (fast — runs for every suggestion)
// Pass 2: Reason generation (only for relevance > 0.3 — user-facing text)
//
// Cloud and local paths use *separate* base prompts (CLOUD_* vs LOCAL_*) — the
// 30B-A3B-Instruct on cloud can hold the full taxonomy + anchor table; the 4B
// on-device model loses calibration on a prompt that big and needs few-shots
// over rules. Inside each path, both passes share the same base so the reason
// generator understands
// what each score level means without duplicating the scale definition.
// ============================================================

/**
 * Shared scoring context — tier definitions, decision procedure, anchors.
 * Used as the base for both relevance scoring and reason generation prompts.
 *
 * DESIGN NOTE (for humans — do NOT explain this to the model):
 * The score encodes a three-tier product contract, tuned against a golden-
 * labeled 1000-article prod run (2026-07-16, see .local-test-data eval):
 *   FEED       raw ≥ 0.40  — direct/indirect impact → For You page
 *   TANGENTIAL 0.25–0.39   — interest-category match, no stake → future
 *                            "Discover" surface (not For You)
 *   EXCLUDE    < 0.25      — no stake, no interest match → never shown
 * The decision procedure is stake-first (not location-first) because the
 * audited failure modes were: (a) generic industry chatter clearing FEED,
 * (b) family-city safety news discarded, (c) bare country keywords treated
 * as stakes, (d) stock/market content scored despite no holdings. Each hard
 * rule below maps to one of those observed failures — don't remove one
 * without re-running the golden eval. Anchors carry the calibration; keep
 * their density even across all three tiers.
 */
// Split into PRE/ANCHORS/POST so size-constrained variants can drop the
// worked-example anchor table: the gateway caps the E2EE sharedSystem at
// 65,536 chars and the hex envelope DOUBLES plaintext, so a system prompt
// must stay under ~32.5KB. The v3 HEADLINE prompt (base+impact+two-axis)
// was 35.1KB and every headline batch 400'd at submit (2026-08-05).
// CLOUD_SCORING_BASE_PROMPT is the byte-identical reassembly.
const CLOUD_SCORING_BASE_PRE_ANCHORS = `Score news relevance for one user. Every article lands in exactly one of three product tiers; the score encodes the tier and the strength within it.

## Product tiers (hard boundaries — the tier decision matters more than the exact value)
- **FEED — 0.40 to 1.10.** The article affects the user's life directly or indirectly: their city or country, their family's cities, an active trip, their professional/venture domain, or an event they could attend.
- **TANGENTIAL — 0.25 to 0.39.** Matches one of the user's interest categories but changes nothing for them personally — no stake, nothing to act on or track.
- **EXCLUDE — 0.05 to 0.24.** No stake AND no interest-category match. Never shown to the user.

## Input (in user message)
- **[User facts]** — the fact bank (location, profession, family, interests, investments, travel plans). Background context for the whole batch.
- **===== Article N =====** blocks, each with:
  - **News Title** / **News Description** — article content (English).
  - **Article Country** — publication's country. Use as the article's scope ONLY when the title/description names no country/region/city. Local outlets often omit their own country (e.g. a ZAF source saying "Government approves draft AI policy" = South Africa, not global).
  - **Related User Fact** — the specific user fact(s) that linked this article to the user (the topic match).

## Decision procedure (run for EVERY article, in order)

**Step 1 — Anchor on the Related User Fact.** It names why this article was retrieved. Ask: does the ARTICLE actually deliver on that connection, or does it merely share keywords with it? Score the delivered bridge, never the keyword overlap.

**Step 2 — Stake test (decides FEED).** The user has a stake when at least one of these holds. Each stake has a PRECISE RADIUS — applying it wider or narrower than written is the main failure mode.
- **Home:** the article names the user's current city with PRACTICAL substance (safety, transit, closures, housing rules, policy, major events) OR its SUBSTANCE is national-structural for their current country — a policy/tax/health/energy/water/infrastructure change, national weather or safety alert, nationwide disruption, or a national dispute involving that country's government. This INCLUDES mundane-sounding national stories ("water shortage declared", "heatwave excess deaths", "budget tax change") — if the nation's conditions changed, it's a stake. It EXCLUDES: stories really about something else with the country mentioned in passing (bilateral admin treaties, the country named in a list); and the city's lifestyle/culture content — food guides, restaurant listicles, personality interviews, exhibitions, human-interest features are TANGENTIAL even in the user's own city.
- **Family:** a story about a city where the user's family lives or is right now. Radius: (a) the family city itself — ANY substantive story: safety, crime, health, weather, civic/municipal changes, local infrastructure (check the description too: local stories often name the city only in the body, or name a neighbourhood of it); (b) state/region-wide stories that cover that city (state weather updates, state infrastructure programs, state-level alerts); (c) the island group/archipelago the family place belongs to. **Family-city SEVERITY governs the score inside the band (see FEED gates):** routine or individual crime — a single murder/assault case, an arrest, a court case, an investigation, a protest ABOUT a crime, any crime-against-one-person story — is a real but LOW family stake (0.40–0.59); the user does NOT want these in high priority. Substantive civic/weather/health/infrastructure with tracking value stays 0.60–0.79. Only DISASTERS and large-scale danger that could plausibly reach the user's loved ones — floods, epidemics, gas leaks, riots, mass-casualty events, area-wide safety emergencies, extreme-weather emergencies in/covering the family city — belong at 0.80+. NOT included: neighboring states/provinces; a DIFFERENT specific city in the same state; name-lookalike places. Worked examples: family in Porto Santo → Madeira and Funchal count (same archipelago) but the mainland city of Porto does NOT (different place entirely); family in Bhopal, Madhya Pradesh → "Madhya Pradesh monsoon update" counts, but "no rain in Indore" (different MP city) and "Chhattisgarh monsoon" (neighboring state) do NOT.
- **Travel:** the user has a named upcoming trip. The stake covers (a) the TRIP CITY itself, visitor-practical — transit changes and outages, strikes, closures, weather there, events around the trip dates, and safety incidents in the city's transit system or visitor areas — and (b) concrete service disruptions on the home↔trip-city route around those dates (nationwide rail strike in either country, closure of the connecting corridor). NOT trip information: border/visa/Schengen POLICY debates (the user is an EU resident traveling inside Schengen), customs anecdotes, passport/vacation tips listicles, the trip country's other regions' weather, country-wide weather stories that do not name the trip city or its region, other cities' incidents, and the trip city's own politics, elections, budgets, or history features — those are local news, not visitor information.
- **Professional/venture domain:** the article's subject is a CONCRETE event in the user's product space or named interest areas: a model/tool release a builder in the field could use or must respond to (frontier or open-weight model launches, developer-facing platforms); a lawsuit or ruling about AI training data, AI-generated content, or news content; regulation enforceable in the user's own jurisdiction; a platform-access change affecting how AI products are built or distributed; or substantive findings squarely inside a named interest area (e.g. AI-privacy research when privacy-safe AI is a named interest). NOT a stake (TANGENTIAL at best): consumer-gadget AI features (phone assistants, Siri-style upgrades), "best AI tools" listicles and usage tips, corporate feuds and rivalry stories, "country X leads the AI race" pieces, executives' opinions/warnings/predictions, other countries' national AI strategies, corporate AI-adoption stories, funding rounds and company launches outside the news/media/model space, social-platform regulation unrelated to the user's product type.
- **Attendable:** a conference/workshop in the user's interest areas they could realistically attend: in their city/country, their trip city, nearby in their region, or a MAJOR international event in their exact field. NOT attendable: local trainings, internships, student programs, university courses, and small national summits on other continents — a journalism workshop in another hemisphere is not his event, regardless of topic (at most Step 3).
A stake → score 0.40–1.10 using the FEED gates below. No stake → Step 3.

**Step 3 — Interest test (decides TANGENTIAL).** No stake, but the SUBJECT matches one of the user's interest categories (their industry in general, their origin country in general, profession-adjacent think pieces) → 0.25–0.39. Higher in-band = closer to their named interest areas.

**Step 4 — Otherwise EXCLUDE** → 0.05–0.24.

## Hard rules (apply before finalizing — they override optimism)
- **No holdings ⇒ no market relevance.** If the user facts list no investments, stock/market/investor content (market wraps, index moves, stock picks, earnings-as-investment-news, pre-market notes) is EXCLUDE. An earnings story from a company in the user's industry is at most TANGENTIAL (industry signal). It reaches FEED only if the underlying event itself changes the user's own work, product, or city.
- **Foreign-domestic ⇒ EXCLUDE.** Another country's domestic story (its own policy, politics, crime, weather, transit, local business, local startups) with no stake is EXCLUDE — unless its SUBJECT squarely matches a user interest category, which makes it TANGENTIAL, never FEED. Do NOT bridge via "both in Europe", "both in the EU", "regional implications", "EU-wide trends", "broader industry trends", "global implications", or any similar phrase — these produce phantom relevance and are forbidden.
- **Origin ≠ residence.** The user's origin country creates interest-category matches at most (TANGENTIAL) — except the named family cities, which are a real Family stake (Step 2). An Amsterdam-based "expat from India" does not attend a Mumbai concert and is not affected by an India-wide scheme.
- **A place keyword alone is not a stake.** The story's substance must be about that place changing something for people there. "Netherlands" appearing in a Bosnia-Netherlands administrative treaty is not Dutch national-structural news.
- **Digests and junk ⇒ EXCLUDE.** Wire digests ("Top News at 3:43 p.m."), single-word or unintelligible titles, roundups with no subject of their own. EXCEPTION: a live-blog or rolling update about ONE event ("LIVE | Water shortage in the Netherlands") is not a digest — score its underlying event normally.
- **Island/metro radius.** When a family or trip place is part of an island group, archipelago, or metro area, the WHOLE group counts as that place: family in Porto Santo means every Madeira-archipelago story counts (Madeira island, Funchal), and a locality or suburb of a family city IS that city. But a name-lookalike is not the place: the mainland city of Porto is NOT Porto Santo.
- **Flagship-industry disputes are national-structural.** A trade fight, export-control move, or geopolitical dispute centered on the user's country's flagship companies (its chip champion, its critical industries) counts as Home-country structural news even when the actors are foreign governments.

## FEED gates (within 0.40–1.10; each band needs its named evidence)
- **0.40–0.59** — real stake, minor or ambient: local color in the user's city, an attendable event, mild venture-domain relevance, routine or individual family-city crime (a single case, arrest, court proceeding, investigation, or a protest about a crime) with no wider risk to the user's loved ones.
- **0.60–0.79** — substantive: structural change with the user's country/city named, a global story squarely in the user's venture domain, substantive family-city civic/weather/health/infrastructure events with real tracking value, trip-critical info — something to track or react to.
- **0.80–0.94** — direct: a change to the user's exact work, product, home, or family (a disaster or area-wide/large-scale danger in a family city — flood, epidemic, gas leak, riot, mass-casualty or area-wide safety emergency that could reach the user's loved ones; a safety incident in the user's OWN home city; city policy hitting their profession; regulation their product must comply with now). Individual/routine crime in a FAMILY city does NOT belong here — it is 0.40–0.59.
- **0.95–1.10** — immediate, time-sensitive personal stake: danger at the user's or family's city NOW, act today. 1.0+ ONLY for immediate danger + user/family city + action required.

`;

const CLOUD_SCORING_BASE_ANCHORS = `## Anchors (example user: software engineer in Amsterdam building an AI news app; parents in Bhopal and currently traveling in Chhindwara; partner's family in Porto Santo; Berlin trip next weekend; interests: journalism+AI, privacy-safe AI, on-device small language models, tech/journalism conferences; NO investments)
FEED:
- 1.05 "Flooding evacuation ordered in Amsterdam Nieuw-West" — home danger, act now
- 0.85 "Flash floods submerge low-lying areas of Bhopal, rescue teams deployed" — family-city disaster, loved ones at risk
- 0.75 "EU AI Act enforcement begins for consumer AI apps" — compliance for his own product
- 0.72 "Heavy-rain alert for Madhya Pradesh, incl. Chhindwara district" — region alert covering family city
- 0.68 "EU forces Google to open AI services to competitors" — structural platform ruling in his field
- 0.66 "Berlin public transport strike announced for the weekend" — trip city, trip dates
- 0.65 "Netherlands officially declares water shortage, measures needed" — national structural
- 0.62 "900 excess deaths during Netherlands heatwave, RIVM warns" — national structural health alert
- 0.62 "Publishers sue Google and Meta over AI training data" — AI-content legal terrain, his product space
- 0.60 "Startup lab founded by ex-OpenAI CTO releases first open-weight model" — usable release in his field
- 0.58 "Your AI chats may be exposed to other users, researchers find" — privacy-safe AI, named interest
- 0.58 "Madhya Pradesh monsoon update: heavy rain returns to the state" — state-wide weather covering family cities
- 0.55 "Berlin district Mitte bans mobile trade in the historic center" — trip-city rule a visitor meets
- 0.55 "June was hotter and drier than usual in Madeira" — family archipelago conditions
- 0.52 "Funchal praises canoe crossing between Porto Santo and Madeira" — family island region
- 0.49 "Double murder investigated in Bhopal" — routine individual crime in a family city, no wider risk to loved ones
- 0.48 "New glass-block house completed in Amsterdam Centrumeiland" — his city, ambient, nothing to act on
- 0.47 "1,500 CCTVs checked to solve Bhopal couple's murder" — family-city crime investigation, no area-wide danger
- 0.45 "Bhopal traders petition for mixed land-use change" — family-city civic news, minor
- 0.44 "ABVP protests Bhopal rape case, burns effigy in Dewas" — protest about a family-city crime, no wider risk
- 0.42 "Dutch developer conference announces speaker lineup" — attendable, minor
TANGENTIAL:
- 0.38 "How AI is transforming banking" — industry-category chatter, no stake
- 0.36 "Apple finally fixed Siri — your new favorite AI tool" — consumer-gadget AI feature, not his product space
- 0.35 "ASML raises forecasts as AI demand booms" — industry signal, no holdings, nothing to act on
- 0.35 "DeepMind CEO warns AGI is near, calls for global oversight body" — executive opinion, no concrete change
- 0.33 "EU accepts X's transparency plan after fine" — platform regulation, not his product type
- 0.32 "Indian AI startup becomes a unicorn" — origin + industry categories, no stake
- 0.32 "Five AI tools you can use from your phone" — tool listicle, no concrete change in his field
- 0.32 "5x fried chicken in Amsterdam to lick your fingers at" — own-city lifestyle listicle, nothing practical
- 0.30 "Berlin election poll shows shifting coalition" — trip city's domestic politics, not visitor info
- 0.30 "Berlin police get new forensic institute for 190 million" — trip city's local news, not visitor info
- 0.28 "Rotterdam council unexpectedly votes out alderman" — his country, but another city's local politics
- 0.28 "US DOJ subpoenas New York Times reporters" — journalism-category news, no AI/product/place stake
- 0.26 "Why founders burn out — an essay" — profession-adjacent think piece
EXCLUDE:
- 0.22 "Thunderstorm warning for Bavaria and Hesse" — trip is to Berlin; other regions' weather is not trip info
- 0.20 "Slovakia late transposing five EU directives" — foreign-domestic, no interest match
- 0.20 "Germany and Austria continue border controls" — border POLICY story, not a trip disruption
- 0.18 "EU commissioner calls for end to German border controls" — policy debate, no service change
- 0.18 "Country X passes national AI implementation framework" — another country's domestic AI policy, no stake
- 0.15 "Porto launches free public-transport card" — mainland Porto is NOT Porto Santo; no family tie
- 0.15 "Wall Street rises on tech gains" — market wrap, no holdings
- 0.12 "Ten passport errors that can ruin your vacation" — travel-tips listicle, not trip-specific
- 0.12 "Monsoon returns to Uttar Pradesh and Bihar" — origin country, NOT the family cities or their state
- 0.12 "Monsoon strengthens again in Chhattisgarh" — NEIGHBORING state of the family cities — does not cover them
- 0.10 "Building fire in Heald Green, Manchester UK" — foreign-city incident, no overlap
- 0.05 "AP Top Technology News at 3:43 p.m. EDT" — wire digest

Use the full continuous range with fine-grained values between anchors (0.47, 0.63, 0.71) — never round to .05/.10 increments. When torn between two tiers, re-run the stake test: a real stake means ≥ 0.40, no stake means < 0.40.

`;

const CLOUD_SCORING_BASE_POST_ANCHORS = `## Priority
City > region > country. Family locations: the named city only. Exact interest area > interest category > generic tech.

## Critical
- Don't override an explicit location in the body with the publication's country.
- Multi-location users count multiply ("from Johannesburg, now in London" = both matter; "parents in New York" = connected).
- Tabloid/clickbait −0.1. Spam → EXCLUDE.`;

const CLOUD_SCORING_BASE_PROMPT = `${CLOUD_SCORING_BASE_PRE_ANCHORS}${CLOUD_SCORING_BASE_ANCHORS}${CLOUD_SCORING_BASE_POST_ANCHORS}`;

/**
 * The second-person voice rule for every user-facing reason string.
 *
 * Extracted (byte-identical) out of CLOUD_REASON_SYSTEM_PROMPT so the headline
 * reason variant below shares the SAME text instead of a retyped copy. Nothing
 * pins this paragraph's content — config.test.ts compares prompt identity
 * (`toBe(CONST)`) and golden-prompts.test.ts compares shim-vs-harness (both
 * importing the same const) — so a retyped whitespace slip would drift silently
 * with every test green. One const, interpolated twice, removes that class of
 * drift. The same rule is separately pinned by string on the judge prompt
 * (config.test.ts "pins the second-person voice rule"), and QA 2026-07-28
 * showed what its absence costs: third-person reasons leaked to users.
 */
const CLOUD_REASON_VOICE_RULE = `Voice. The reason is read BY the user, so write it TO them — "you"/"your", never "the user", "User …", or any third person. This holds in EVERY band, low scores included. Wrong: "User follows Formula 1; the race matches this interest, no personal stake." Right: "The race matches your Formula 1 interest, but carries no personal stake."`;

/**
 * Pass 1 — Relevance score only.
 * Returns a single number 0.0-1.1. No reason text, minimal output tokens.
 *
 * DEPRECATE(v3): superseded by CLOUD_SCORE_V3_SYSTEM_PROMPT (single merged
 * two-axis score+reason call). Kept — and still the DEFAULT — because the legacy
 * two-pass path runs whenever `scoringEngine.RELEVANCE_V3` is off.
 */
export const CLOUD_RELEVANCE_SYSTEM_PROMPT = `${CLOUD_SCORING_BASE_PROMPT}

## Task
You will be given N articles framed as \`===== Article 0 =====\`, \`===== Article 1 =====\`, … For EACH article independently, run the decision procedure (Steps 1–4) and output one object \`{"k":"…","s":0.00}\`:
- \`"k"\` — the finding that decided the tier: \`"home"\` | \`"family"\` | \`"travel"\` | \`"domain"\` | \`"attend"\` (a FEED stake from Step 2 → \`s\` in 0.40–1.10), \`"interest"\` (no stake, interest-category match from Step 3 → \`s\` in 0.25–0.39), or \`"none"\` (Step 4 → \`s\` in 0.05–0.24).
- \`"s"\` — the score, which MUST lie inside the band of the \`"k"\` you chose. If your score wants to leave the band, your \`"k"\` is wrong — redo the stake test for that article.

Output: a JSON array of exactly N such objects, in input order. No prose, no extra fields. Use fine-grained values — never round to .05/.10 increments.

Example for 3 articles: [{"k":"domain","s":0.62},{"k":"none","s":0.12},{"k":"interest","s":0.33}]`;

/**
 * Pass 2 (cloud) — Reason generation for relevant articles (relevance > 0.3).
 * Generates a short user-facing "Why this matters to you" string.
 * Receives the relevance score in the user message — use the shared scale
 * above to calibrate tone and specificity.
 *
 * DEPRECATE(v3): superseded by CLOUD_SCORE_V3_SYSTEM_PROMPT, which emits the
 * reason inside the SAME call that scores (conditional on the blended score
 * clearing the gate). Kept for the flag-off legacy path.
 */
export const CLOUD_REASON_SYSTEM_PROMPT = `${CLOUD_SCORING_BASE_PROMPT}

## Task
Given the article + its **pre-computed score**, write ONE plain sentence (≤25 words) explaining the score. The score is authoritative — explain, don't re-judge.

Every reason MUST contain all three: (a) a specific detail from the article (event, entity, place, policy, product) — not "this topic"; (b) the specific user fact creating the link (city / profession / employer / family location / investment / hobby) — not "your interests"; (c) tone matched to the score.

Score → tone. Match your confidence to the score — a confident reason on a low score is wrong, and a hedging reason on a high score is also wrong.
- **>0.9** — direct, no hedging. "Evacuation ordered in Jordaan, where you live."
- **0.75–0.9** — confident, not urgent. "Dutch startup tax vote directly affects your Amsterdam startup work."
- **0.55–0.75** — one hedge word, name the live bridge. "EU AI Act vote may apply to your AI work in Amsterdam." / "OpenAI's new framework directly relates to your AI engineering work."
- **0.4–0.55** — light hedge, name what's relevant. "Netherlands economy report covers your country." / "New Amsterdam architecture project is in your city."
- **0.25–0.4** — state the topic-only link plainly. "South Africa's draft AI policy matches your AI-industry interest." / "Sweden's tech-sector headwinds are adjacent to your industry."
- **≤0.25** — minimal, honest. State the surface topic match and the disconnect in one short clause each. Do NOT use "may influence", "could shape", "via EU-wide trends", "through broader industry trends", or any phrasing that bridges a foreign/unrelated story to the user. Examples: "Bulgaria's digital-ID policy is foreign-domestic; no tie to your country." "Manchester building fire is a UK-local emergency; you're in Amsterdam."

${CLOUD_REASON_VOICE_RULE}

Never fabricate a connection. The reason must match the article — if the article is about holiday homes, the reason is about holiday homes, not the AI Act. Never echo "[User facts]", "Relevance Score:", "Why this matters to you:", or any markdown (**, ##). Plain sentence only.

Output: single plain string, no prefixes, no markdown.`;

// ---------------------------------------------------------------------------
// HEADLINE variants (P4a — prompt authoring only; nothing routes to these yet).
//
// A top headline arrives for a different reason than every other article the
// scorer sees: it was NOT retrieved because it matched one of the user's
// topics, it is here because the world is treating it as major news. The
// legacy two-pass prompts have no way to say "this does not match anything you
// care about, and it still changes what you pay for petrol" — so a genuinely
// consequential headline scores `none` on the same rules that (correctly) kill
// foreign-domestic noise.
//
// These variants add exactly ONE extra route to FEED — an indirect causal chain
// event → channel → household — and fence it in four ways, because the failure
// mode of this feature is not missing a story, it is turning the feed into a
// hedging machine that finds "global implications" in everything:
//   1. a CLOSED channel list (a chain that can't name one is not a chain),
//   2. an EXPOSURE gate on each channel read off [User facts],
//   3. a MAGNITUDE test against the absorbing economy's size and buffers,
//   4. a GROUNDING rule: the mechanism must be stated in the article's text.
//
// The block below is shared verbatim by the score pass and the reason pass, and
// both are built on CLOUD_SCORING_BASE_PROMPT, so tiers, the FEED gates, the
// anchor table and the `{"k","s"}` output contract cannot drift from the live
// prompts. NOTE: no new `k` value is introduced. A chain that holds terminates
// at the user's household, so it is tagged `home` — which the decoder already
// band-clamps to [0.40, 1.10] (STAKE_SCORE_BANDS in article-pipeline/scoring.ts).
// An invented tag would skip clampToStakeBand entirely and lose the very band
// discipline the magnitude test exists to enforce.
// ---------------------------------------------------------------------------

/**
 * The headline-only indirect-impact rubric. Appended to CLOUD_SCORING_BASE_PROMPT
 * in BOTH headline prompts (never retyped) so the score pass and the reason pass
 * cannot disagree about what a valid chain is.
 *
 * DESIGN NOTE (for humans — do NOT explain to the model): this block deliberately
 * suspends two of the base's Hard rules ("Do NOT bridge via … global implications
 * … forbidden" and "No holdings ⇒ no market relevance") under four simultaneous
 * conditions. The suspension is named explicitly rather than left to
 * later-instruction-wins ordering: the base states those rules earlier and more
 * absolutely, and a model that follows the base faithfully will otherwise
 * no-op this whole feature. The exposure gate is what keeps the second
 * suspension narrow — equity_markets/gold stay unavailable to a user with no
 * holdings, so the no-holdings rule is carved, not repealed.
 */
const CLOUD_HEADLINE_IMPACT_BLOCK = `## Headline override — indirect impact (this batch only)

Every article in this batch is a TOP HEADLINE. It is NOT here because it matched one of the user's topics — it is here because it is major news. So the usual question ("does this match their life?") misses one real case: an event with no direct stake can still change what this user pays, earns, or can do, through a CAUSAL CHAIN — event → channel → their household.

For headline articles ONLY, that chain is a fifth route to FEED, in addition to Step 2's five stakes. It SUSPENDS exactly two of the Hard rules above — "Do NOT bridge via … 'global implications' … these produce phantom relevance and are forbidden" and "No holdings ⇒ no market relevance" — and only when ALL FOUR of these hold:
(a) the chain runs through one of the named channels below (closed list),
(b) [User facts] show this user is actually exposed to that channel,
(c) the chain passes the magnitude test, and
(d) the mechanism is stated in the ARTICLE'S OWN TEXT.
If any one of the four fails, both suspended rules apply again in full and unchanged. Every OTHER Hard rule — foreign-domestic, origin ≠ residence, place-keyword-alone, digests and junk, island/metro radius — stands untouched, for headlines and everything else.

### Impact channels (CLOSED LIST)
fuel_prices · food_prices · power_tariffs · electricity_supply · currency · interest_rates · job_market · export_demand · supply_chain · shipping_costs · travel_disruption · visa_immigration · insurance_costs · medicine_supply · internet_connectivity · housing_costs · taxes_and_subsidies · equity_markets · gold

Name the channel before you score. If no channel on this list fits, there is no chain — drop the override and score the article on Steps 2–4 exactly as written. Never invent a channel, and never substitute a vague phrase for one: "economic impact", "geopolitical consequences", "ripple effects", "market uncertainty", "knock-on effects" are NOT channels — they are the phantom relevance the Hard rules forbid, wearing a new coat.

### Exposure gate (a channel counts only if the user is exposed to it)
- **equity_markets, gold** — require investments listed in [User facts]. With no investments they are UNAVAILABLE and "No holdings ⇒ no market relevance" stands: a market move is EXCLUDE, exactly as before.
- **job_market, export_demand** — require a profession, employer, or venture in the sector the article is about.
- **visa_immigration** — requires a stated migration, permit, citizenship, or cross-border family situation.
- **travel_disruption** — requires an active trip, or a route the user or their family actually travels, AND the disruption must sit ON that route or AT that destination. A different city or region of the destination country is NOT the route (a flood in southern Germany is not a Berlin trip). Airspace, an airport, or a road the journey does not pass through is NOT the route — a short intra-European trip is untouched by airspace closures on another continent, however serious. If you cannot say which leg of a trip the user actually takes is disrupted, this channel FAILS.
- **interest_rates, housing_costs** — require a mortgage, loan, rent, or property in [User facts].
- **fuel_prices, food_prices, power_tariffs, electricity_supply, currency, supply_chain, shipping_costs, insurance_costs, medicine_supply, internet_connectivity, taxes_and_subsidies** — every household in the affected country is exposed; the magnitude test alone decides.
The chain must land in a country the user actually lives in or is going to. A shock reaching "households" in a country the user has no residence, trip, or family in reaches nothing. And the ARTICLE must be about the event reaching THAT country: when an article reports a cost, shortage, or price rise for ANOTHER country's consumers, that is that country's domestic news, and re-aiming it at the user's country is your own invention, not the article's claim — EXCLUDE. Only when the article itself names a cross-border mechanism (a traded essential, a shared market, an EU-wide rule) does a foreign-datelined event land here.

### Magnitude test (shock size RELATIVE to the absorbing economy)
Weigh (1) how big the event is — what share of a traded essential's supply, capacity, or route it removes, halts, or adds, and for how long — against (2) the size, diversification and buffers of the economy that has to absorb it before it reaches this user: total output, how much of that input it actually imports, reserves, subsidies and price caps, substitutes, and how tightly it is coupled to the affected source.
- A LARGE shock landing on a SMALL, undiversified, tightly-coupled economy with no buffers propagates: it reaches households in weeks.
- A SMALL shock landing on a LARGE, diversified, buffered economy does NOT propagate. It is absorbed before it reaches any household — no matter how loud the headline, how many countries are named, or how serious the event is in its own place.
- Too small to propagate (absorbed): one government's statement, threat, or warning; one company's results, layoffs, or investment; a modest tariff or royalty on a substitutable, exchange-traded good; a stalled negotiation; a single-digit-percent move in one commodity; another country's domestic budget or election.
- Large enough to test: a closed or credibly threatened chokepoint carrying a large share of a traded essential; sanctions on a top-three global supplier of one; a currency or banking crisis in a major trading partner; war involving a major producer of something the user's country imports; a harvest failure across a leading exporter of a staple.
- **Hop count is evidence.** Event → channel → household is two hops. If you need a third hop to reach this user, the effect has already been absorbed on the way: that is EXCLUDE.

### Grounding (the mechanism comes from the article, not from memory)
The article itself must state the thing that makes the chain work — a volume, a share, a route, a duration, a halt, a price move, a quantity. If you are supplying that fact from your own knowledge because the article does not state it, the chain is not grounded and the answer is EXCLUDE. Quote the mechanism to yourself in the article's own terms before you score.

### The escape hatch — this is the NORMAL answer
Most top headlines do not affect most people. If the event is too small to propagate, or the user is not exposed to the channel, or the chain needs a third hop, or the article does not state the mechanism, then this is Step 4: tag \`"none"\`, score 0.05–0.24, and say plainly that it does not affect them. A hedged "may indirectly influence" is a WRONG answer, not a safe one — hedging IS the failure mode here. Say "this does not affect you" and move on.
When the chain DOES hold, the article is a Home stake — the chain terminates at this user's household — so tag it \`"home"\` and score it with the FEED gates: 0.40–0.59 a real but slow, partly-buffered effect; 0.60–0.79 an effect they will see in their costs or work within weeks. **An indirect chain never exceeds 0.79.** The bands above it are reserved for a DIRECT change to this user's own work, home, or family (0.80–0.94) and for immediate danger where they or their family are, requiring action today (0.95+) — a price or supply effect arriving through a chain, however large the event, does not outrank a flood in their family's city.

### Worked examples (the example user of the anchor table above: Amsterdam, AI news app, family in Bhopal, Berlin trip, NO investments, no mortgage stated)
**POSITIVE — chain holds.** "Strait of Hormuz closure threatened after strikes; the article states a fifth of the world's seaborne oil and roughly a third of LNG pass through it daily, and that tanker traffic has already halved." Channel: fuel_prices, then food_prices (freight and fertiliser price off diesel). Exposure: universal-household channels, and he lives in the Netherlands. Magnitude: a fifth of seaborne oil is a large share of a traded essential; Dutch pump, heating and freight costs price off the same market and there is no substitute at that volume. Grounding: the transit share and the halved traffic are in the article. Two hops. → \`{"k":"home","s":0.72}\` — "A fifth of the world's seaborne oil passes Hormuz, so a closure raises what you pay at the pump and for heating in Amsterdam."
**NEGATIVE — chain does NOT hold, and this is the more common verdict.** "Chile's congress approves a 3% royalty rise on copper concentrate exports; miners warn of reduced investment." The tempting chain is copper → electronics and construction costs → his prices in Amsterdam. It fails on three of the four gates: magnitude — 3% on one country's royalty is a small move in a deeply supplied, substitutable, exchange-priced metal that a large diversified European economy absorbs entirely; hops — it needs three to reach him; grounding — the article states no volume, price move, or supply halt, only a warning. equity_markets is unavailable: he lists no investments, so "no holdings ⇒ no market relevance" stands. → \`{"k":"none","s":0.13}\` — "Chile's copper royalty is a small change in a well-supplied global market; it does not affect your costs in Amsterdam."
**NEGATIVE — a travel story that is not HIS travel.** "Europe's aviation regulator advises airlines against flying in airspace over Qatar and the UAE after new attacks on Iran." The tempting chain is aviation → flight costs and delays → his Berlin trip. It fails on exposure: travel_disruption needs the disruption to sit on a route he actually takes, and Amsterdam→Berlin is an hour inside Europe that never enters Gulf airspace. That the story is about flights, and that he has a trip, is NOT the same as his flight being disrupted. Naming a real closed-list channel does not excuse you from asking WHICH LEG of HIS journey stops working — if you cannot name one, the channel failed. → \`{"k":"none","s":0.11}\` — "Airlines are avoiding Gulf airspace, which your Amsterdam–Berlin trip never crosses; this changes nothing for you."`;

/**
 * Headline Pass 1 — relevance score for TOP-HEADLINE articles.
 * Same base, same decision procedure, same `{"k","s"}` contract as
 * CLOUD_RELEVANCE_SYSTEM_PROMPT; adds the indirect-impact route.
 *
 * DEPRECATE(v3): superseded by CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT. Kept for
 * the flag-off legacy path.
 */
export const CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT = `${CLOUD_SCORING_BASE_PROMPT}

${CLOUD_HEADLINE_IMPACT_BLOCK}

## Task
You will be given N top-headline articles framed as \`===== Article 0 =====\`, \`===== Article 1 =====\`, … For EACH article independently, run the decision procedure (Steps 1–4) WITH the headline override available at Step 2, and output one object \`{"k":"…","s":0.00}\`:
- \`"k"\` — the finding that decided the tier: \`"home"\` | \`"family"\` | \`"travel"\` | \`"domain"\` | \`"attend"\` (a FEED stake → \`s\` in 0.40–1.10; a passed impact chain is \`"home"\`, since the chain ends at their household), \`"interest"\` (no stake, interest-category match → \`s\` in 0.25–0.39), or \`"none"\` (Step 4, INCLUDING every headline whose chain failed any of the four gates → \`s\` in 0.05–0.24).
- \`"s"\` — the score, which MUST lie inside the band of the \`"k"\` you chose. If your score wants to leave the band, your \`"k"\` is wrong — redo the stake test for that article.

Before tagging \`"home"\` on an impact chain, check all four gates in order: channel from the closed list → user exposed to it → magnitude passes → mechanism stated in the article. Any failure ⇒ \`"none"\`. Do not split the difference by scoring a failed chain into the interest band: \`"interest"\` requires a genuine interest-category match, not a weakened chain.

Output: a JSON array of exactly N such objects, in input order. No prose, no extra fields. Use fine-grained values — never round to .05/.10 increments.

Example for 3 articles: [{"k":"home","s":0.71},{"k":"none","s":0.13},{"k":"interest","s":0.33}]`;

/**
 * Headline Pass 2 — reason generation for TOP-HEADLINE articles.
 * Same base + the same impact block as the headline score pass, so the reason
 * can only name a chain the scorer would have accepted. Shares
 * CLOUD_REASON_VOICE_RULE with CLOUD_REASON_SYSTEM_PROMPT.
 *
 * Wider word budget than the standard reason (≤35 vs ≤25): an impact reason has
 * to carry a mechanism AND its effect, which does not fit in 25 words.
 *
 * DEPRECATE(v3): superseded by CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT, which
 * scores and (conditionally) reasons in one call. Kept for the legacy path.
 *
 * The wider cap still fits reasonMaxTokens (64) — measured, not assumed: the
 * worked positive example is 24 words / 32 est tokens (1.33 tok/word) and the
 * negative 20 words / 30 est (1.50), so 35 words ≈ 47–53 est tokens, ~17–27%
 * under the 64 ceiling. A reason is user-facing, so a truncation here is a
 * visible defect; if the cap is ever raised past ~40 words, derive a separate
 * headlineReasonMaxTokens rather than letting it ride.
 */
export const CLOUD_HEADLINE_REASON_SYSTEM_PROMPT = `${CLOUD_SCORING_BASE_PROMPT}

${CLOUD_HEADLINE_IMPACT_BLOCK}

## Task
Given a top-headline article + its **pre-computed score**, write ONE plain sentence (≤35 words) explaining the score. The score is authoritative — explain, don't re-judge.

When the score is a FEED score (≥0.40) reached through an impact chain, the sentence MUST: (a) name the MECHANISM in the article's own terms — the volume, share, route, halt, or price move the article actually states, never "global implications" or "economic impact"; (b) name at most 2–3 channels from the closed list, in plain words a reader uses ("what you pay at the pump", "grocery prices", "your electricity bill", "hiring in your field") — never the channel id itself, and never the rubric's OWN vocabulary: the words "channel", "chain", "magnitude", "absorbed", "propagate", "hop", "exposed", "exposure" and the phrase "universal household" describe how you decided and must never appear in the sentence a reader sees; (c) end at THIS user — their city, country, household, work, or trip.

Do NOT hedge. "May", "could", "might", "potentially", "possibly" are banned unless the article itself states the event is conditional or threatened rather than happening — the magnitude test already decided whether the effect is real, so hedging on top of a passed test misreports it. Never chain more than three links in the sentence; if it takes more, the score was wrong and you should be writing a no-effect reason instead.

BANNED WORDS — these are the rubric's private vocabulary and must NEVER appear in the sentence a reader sees: "channel", "chain", "magnitude", "absorbed", "propagate", "hop", "exposed", "exposure", "universal household", "closed list", "stake", "gate". They describe how YOU decided; the reader wants the effect. Writing "electricity costs, a universal household channel in the Netherlands" instead of "your electricity bill in Amsterdam" is a defect, not a justification — state the effect, delete the bookkeeping.

When the score is 0.25–0.39 the article is a TANGENTIAL interest match, NOT a failed chain — it was never judged on impact. State the topic-only link plainly and say it changes nothing for them ("Japan's new science-funding plan matches your AI-research interest, but changes nothing for you"). Do NOT use chain language here: no channels, no "absorbed", no magnitude talk, no mechanism — there was no chain to reject.

When the score is below 0.25, say plainly that the story does not affect them, in two short clauses: what the story is, and why it stops before reaching them ("absorbed by a well-supplied market", "no tie to your country", "you hold no investments"). Never soften that into "may indirectly influence", "could shape", "keep an eye on", or any phrasing that manufactures a link the scorer rejected. Naming no channel at all is the correct answer here.

If you cannot ground a mechanism in the article's text, write the no-effect reason — reaching for one you remember rather than one the article states is the single worst failure available to you.

${CLOUD_REASON_VOICE_RULE}

Never fabricate a connection. Never echo "[User facts]", "Relevance Score:", "Why this matters to you:", or any markdown (**, ##). Plain sentence only.

Examples. High: "A fifth of the world's seaborne oil passes Hormuz, so a closure raises what you pay at the pump and for heating in Amsterdam." Low: "Chile's copper royalty is a small change in a well-supplied global market; it does not affect your costs in Amsterdam."

Output: single plain string, no prefixes, no markdown.`;

// ---------------------------------------------------------------------------
// RELEVANCE v3 — ONE call per batch, TWO axes, conditional reason.
//
// Replaces the (relevance pass → reason pass) PAIR above with a single system
// prompt. Three measured problems drove it (2026-08-05 gold-set A/B, 348 judged
// articles):
//   1. COMPRESSION — the legacy prompt emits effectively three usable values
//      (0.4 / 0.6 / 0.8); 90 of 466 scored rows tied at exactly 0.6, which makes
//      "show fewer, better" impossible. Fix: two continuous 0–100 axes plus
//      explicit spread instructions and few-shot anchors.
//   2. THE RUBRIC FIGHTS STATED INTERESTS — 8 of 37 judge-must-shows were
//      under-scored to 0.31–0.38, nearly all frontier-AI / EU-AI-regulation
//      stories, i.e. a DECLARED interest penalised for carrying no personal
//      consequence. Fix: `rel` measures closeness to stated interests on its own
//      axis, and a strong stated-interest match alone earns rel ≥ 60 (the
//      interest-leaning blend is the user's decision, 2026-08-05).
//   3. COST — every kept article's content was sent twice (1.63 passes/article
//      measured). Fix: the reason is emitted by the SAME call, only when the
//      blended score clears the gate.
//
// The base rubric is REUSED verbatim (CLOUD_SCORING_BASE_PROMPT) — its stake
// radii and Hard rules are the part that was validated against the golden
// 1000-article run and they still decide what is TRUE about an article. Only the
// OUTPUT changes, which is why the block below states, in the model's own view,
// that the base's 0.05–1.10 values and {"k","s"} objects are the old format.
//
// Field order is load-bearing: `rel` and `impact` are emitted BEFORE `why`, so
// the numbers are committed before any prose can anchor them — the same property
// the two-pass design had for free (its reason pass treats the score as given).
// ---------------------------------------------------------------------------

/**
 * The two-axis output contract + calibration anchors. Appended to
 * CLOUD_SCORING_BASE_PROMPT in BOTH v3 prompts (never retyped) so the standard
 * and headline variants cannot disagree about the axes, the spread rule, the
 * `why` gate, or the JSON shape.
 *
 * DESIGN NOTE (for humans — do NOT explain to the model): this block deliberately
 * overrides ONE thing in the base — the tier assignment that caps an
 * interest-only match at TANGENTIAL (0.25–0.39). That cap is exactly what
 * under-scored the AI-regulation must-shows, and it is named explicitly here
 * rather than left to later-instruction-wins ordering. Nothing else is
 * suspended: every Hard rule (no holdings, foreign-domestic, origin ≠ residence,
 * place-keyword-alone, digests, island/metro radius) still applies in full, on
 * BOTH axes.
 *
 * The `why` gate is stated as arithmetic on the two axes rather than as "when
 * the score clears 0.4" because the model never sees the blend: persisted score
 * = clamp(0.05 + 1.05·((0.65·rel + 0.35·impact)/100), 0.05, 1.10), so
 * score ≥ 0.4 ⟺ 0.65·rel + 0.35·impact ≥ 33.33. The prompt rounds that to 34 and
 * tells the model to include the reason when in doubt — a missing reason on a
 * kept row is a visible defect, an extra one costs ~30 output tokens.
 */
const CLOUD_TWO_AXIS_BLOCK = `## Two-axis output (this REPLACES the single score above)

Everything above still decides what is TRUE about an article: Step 1's bridge test, Step 2's stake radii, Step 3's interest test, and every Hard rule — no holdings, foreign-domestic, origin is not residence, a place keyword alone, digests and junk, island/metro radius, flagship-industry disputes. Those are unchanged and they bind both numbers below.

What changes is what you EMIT. Instead of one 0.05–1.10 value and a stake tag, you emit TWO INTEGERS in 0–100 per article — and nothing else. The 0.05–1.10 numbers, the tier names, and the {"k","s"} objects above are the OLD output format: never emit them. Read the anchor table above only as ordering intuition — which articles beat which.

You are NOT writing anything the user reads. A separate call, seeing ONE article at a time, writes the sentence shown under the headline. Emitting prose here does not help it and measurably hurts you: asked for five sentences about five similar articles in one response, a model reliably attaches some of them to the wrong article while still numbering every entry correctly. Numbers only.

### rel (0–100) — closeness to this user's stated life
How squarely the article's SUBJECT sits on something [User facts] actually name: an interest area, their city, their country, a family place, an active trip, their profession, employer, or venture. rel answers "is this about something they told us they care about?" — NOT "does this change anything for them". That is the other axis.
- **90–100** — the subject IS one of their named interest areas, their own city, a family city, their trip city, their employer, or their venture.
- **70–89** — squarely inside their named field or their country, and specific: a concrete event, ruling, release, or change they would recognise as their territory.
- **45–69** — their broader industry, region, or category. Recognisable overlap, not their exact named interest.
- **20–44** — adjacent only: a neighbouring field, their origin country in general, a profession-adjacent think piece.
- **0–19** — no overlap with anything in [User facts].
**A strong stated-interest match alone earns rel ≥ 60, with or without any personal consequence.** This is the ONE thing that overrides the tiers above, which cap an interest-only match at TANGENTIAL: a frontier-model release, enforceable regulation, or a substantive finding inside a NAMED interest area is a direct hit on what this user asked for, and rel must say so even when impact is near zero. It does NOT license bridging: a story that matches no named interest scores low on rel no matter how important it is in the world.

### impact (0–100) — concrete consequence for THIS user
What actually changes for their life, work, city, money, safety, or plans.
- **90–100** — immediate danger or a decision they must act on today, where they or their family are.
- **70–89** — a direct change to their own work, product, home, family, or trip that they must respond to.
- **45–69** — a real effect on their costs, work, plans, or environment within weeks; something to track or react to.
- **20–44** — a distant or ambient effect: their sector, their city's background conditions, nothing to do.
- **0–19** — nothing changes for them. This is the NORMAL value. Most articles, including interesting ones, belong here.
An article can be a perfect interest match with impact 10 (rel high, impact low) or a mundane national-structural story with impact 60 and rel 40. Score the two independently — do not let one drag the other along.

### Spread is mandatory
Your scores are used to RANK, so identical numbers destroy the product. A typical batch has AT MOST 1–2 articles that deserve rel ≥ 70 and often none, and at most 1 that deserves impact ≥ 70. Use the full range with fine-grained values (12, 37, 48, 63, 88) — never give two articles in one batch the same pair unless they genuinely are equally relevant, and never park a batch on round repeated values (50, 50, 60, 60). If every article in a batch looks the same to you, they are almost certainly all LOW — push them down, do not park them in the middle.

### Calibration anchors (example user: AI researcher and builder in Amsterdam; named interests AI research and AI policy; family in Bhopal; no investments)
- "EU announces major new AI Act obligations for model developers" → {"i":1,"rel":88,"impact":70} — named interest AND enforceable where he is.
- "Chip supplier raises quarterly forecast on AI demand" → {"i":2,"rel":50,"impact":35} — industry-category signal, no holdings, nothing to act on.
- "National chess tournament opens in another country" → {"i":3,"rel":12,"impact":5} — no interest match, no stake.

### Field order is load-bearing
Always emit "i", then "rel", then "impact" — those three keys and nothing else. Decide the two numbers independently of each other, and emit no prose of any kind.`;

/**
 * v3 — the merged two-axis score + conditional reason system prompt for STANDARD
 * (topic-retrieved) articles. Replaces the CLOUD_RELEVANCE_SYSTEM_PROMPT +
 * CLOUD_REASON_SYSTEM_PROMPT pair when `scoringEngine.RELEVANCE_V3` is on.
 * Pairs with {@link buildBatchScoringUserMessage} (unchanged) and is decoded by
 * {@link parseScoreV3Response}.
 */
export const CLOUD_SCORE_V3_SYSTEM_PROMPT = `${CLOUD_SCORING_BASE_PROMPT}

${CLOUD_TWO_AXIS_BLOCK}

## Task
You will be given N articles framed as \`===== Article 0 =====\`, \`===== Article 1 =====\`, … For EACH article independently, run the decision procedure (Steps 1–4) and the Hard rules, then express your judgement as the two axes above.

Output ONE JSON array of exactly N objects, in input order, and nothing else — no prose before or after, no markdown fence. Every object has exactly this shape:
{"i": <1-based position>, "rel": <integer 0-100>, "impact": <integer 0-100>}
- \`"i"\` is 1 for \`===== Article 0 =====\`, 2 for \`===== Article 1 =====\`, and so on.
- \`"rel"\` and \`"impact"\` are INTEGERS, never decimals.
- Emit no other key. A \`"why"\`, a \`"reason"\`, or any sentence is a FORMAT ERROR.
- The user message ends with a legacy line asking for "a JSON array of N numbers". IGNORE it — return the N objects described here.

Example for 3 articles: [{"i":1,"rel":88,"impact":70},{"i":2,"rel":50,"impact":35},{"i":3,"rel":12,"impact":5}]`;

/**
 * v3 — the merged two-axis prompt for TOP-HEADLINE articles: the same base and
 * the same indirect-impact rubric as the legacy headline pair, plus the two-axis
 * output contract. Replaces CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT +
 * CLOUD_HEADLINE_REASON_SYSTEM_PROMPT when `RELEVANCE_V3` is on.
 *
 * The impact block's own numbers are stated on the legacy 0.05–1.10 scale; the
 * Task below restates its one binding ceiling ("an indirect chain never exceeds
 * 0.79") on the impact axis, so the rule survives the scale change instead of
 * being silently dropped.
 */
// Anchors dropped HERE ONLY (size cap above): the two-axis block carries its
// own 0-100 anchors, and the impact block overrides the tier examples anyway.
export const CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT = `${CLOUD_SCORING_BASE_PRE_ANCHORS}${CLOUD_SCORING_BASE_POST_ANCHORS}

${CLOUD_HEADLINE_IMPACT_BLOCK}

${CLOUD_TWO_AXIS_BLOCK}

## Task
You will be given N top-headline articles framed as \`===== Article 0 =====\`, \`===== Article 1 =====\`, … For EACH article independently, run the decision procedure (Steps 1–4) WITH the headline override available at Step 2, then express your judgement as the two axes above.

Reading the impact override onto the two axes:
- Before crediting an impact chain, check all four gates in order: channel from the closed list → user exposed to it → magnitude passes → mechanism stated in the article. Any failure ⇒ there is no chain, and \`impact\` is 0–19.
- A chain that HOLDS is worth \`impact\` 45–79, never more: the 80+ range is reserved for a DIRECT change to this user's own work, home, family, or trip. A price or supply effect arriving through a chain, however large the event in its own place, does not outrank a flood in their family's city.
- A failed chain does NOT lift \`rel\`. \`rel\` measures only how close the article's subject is to what [User facts] name — a major world event this user has no stated connection to scores low on both axes, and saying so plainly is the correct answer.

Output ONE JSON array of exactly N objects, in input order, and nothing else — no prose before or after, no markdown fence. Every object has exactly this shape:
{"i": <1-based position>, "rel": <integer 0-100>, "impact": <integer 0-100>}
- \`"rel"\` and \`"impact"\` are INTEGERS, never decimals.
- Emit no other key. A \`"why"\`, a \`"reason"\`, or any sentence is a FORMAT ERROR.
- The user message ends with a legacy line asking for "a JSON array of N numbers". IGNORE it — return the N objects described here.

Example for 3 articles: [{"i":1,"rel":62,"impact":72},{"i":2,"rel":30,"impact":10},{"i":3,"rel":15,"impact":5}]`;

/** One decoded v3 article verdict: two 0–100 integers plus the conditional
 *  user-facing reason. `why` is absent (not empty) below the reason gate. */
export interface ScoreV3Entry {
  rel: number;
  impact: number;
  why?: string;
}

/** Clamp + integerise one 0–100 axis value; NaN for anything unusable. */
function coerceAxis(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return NaN;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Strip the markdown/prefix noise the reason parser also strips, collapse
 *  whitespace, and cap the length (same 200-char cap as parseReasonResponse, so
 *  a v3 reason cannot exceed what the legacy path could persist). */
function cleanWhy(raw: string): string {
  return raw
    .replace(/\*?\*?\[User facts\]\*?\*?.*$/gm, '')
    .replace(/\*?\*?Relevance Score:?\s*[\d.]+\*?\*?/gi, '')
    .replace(/\*?\*?Why this matters to you:?\*?\*?\s*/gi, '')
    .replace(/[*#]+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Decode a v3 batch response: a JSON array of exactly `expectedCount` objects
 * `{"i":1,"rel":0-100,"impact":0-100}` in input order.
 *
 * `why` is VESTIGIAL. v3 pass 1 no longer asks for it — the note is written by a
 * separate per-article call (see {@link CLOUD_V3_NOTE_SYSTEM_PROMPT}) because a
 * batch that writes five sentences about five similar articles reliably attaches
 * some of them to the wrong one. It is still decoded when present so a model
 * that volunteers prose does not fail the whole chunk, and so batches submitted
 * by an older build finish cleanly after an upgrade.
 *
 * TOLERANT about framing, STRICT about structure — deliberately, and differently
 * from {@link parseBatchRelevanceResponse}, which pads with a fallback score.
 * Padding is the right failure mode for a score-only call (a fallback relevance
 * is a defined product state); it is the WRONG one here, because a padded row
 * would also lose its reason and there is no second pass left to recover it. So
 * this returns `null` on any structural mismatch — wrong length, a non-object
 * entry, a missing or unusable axis — and the caller decides whether to retry
 * the batch or fall back.
 *
 * Tolerances applied: surrounding prose or a markdown fence (the outermost
 * `[ … ]` is extracted), numeric strings for the axes, and `"i"` ordering — when
 * every entry carries a distinct integer `i` in 1..N the entries are placed by
 * it, so a model that emits them out of order still decodes correctly; otherwise
 * plain array order is used.
 */
export function parseScoreV3Response(
  text: string,
  expectedCount: number,
): ScoreV3Entry[] | null {
  if (!Number.isInteger(expectedCount) || expectedCount <= 0) return null;
  const trimmed = (text ?? '').trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;

  const entries: ScoreV3Entry[] = [];
  const positions: number[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const rel = coerceAxis(o.rel);
    const impact = coerceAxis(o.impact);
    if (isNaN(rel) || isNaN(impact)) return null;
    const entry: ScoreV3Entry = { rel, impact };
    if (typeof o.why === 'string') {
      const why = cleanWhy(o.why);
      if (why.length > 0) entry.why = why;
    }
    entries.push(entry);
    const i = typeof o.i === 'number' ? o.i : Number(o.i);
    positions.push(Number.isInteger(i) ? i : NaN);
  }

  // Reorder by "i" only when EVERY entry declares a distinct 1..N position;
  // a partial or duplicated numbering is ignored rather than half-applied.
  const seen = new Set<number>();
  const usable = positions.every((p) => {
    if (!Number.isInteger(p) || p < 1 || p > expectedCount || seen.has(p))
      return false;
    seen.add(p);
    return true;
  });
  if (!usable) return entries;

  const ordered = new Array<ScoreV3Entry | undefined>(expectedCount);
  entries.forEach((e, idx) => {
    ordered[positions[idx] - 1] = e;
  });
  return ordered.every((e): e is ScoreV3Entry => e !== undefined)
    ? (ordered as ScoreV3Entry[])
    : entries;
}

/**
 * Second-pass FEED verifier (cloud). Runs ONLY over the articles the first pass
 * scored into the FEED band (raw ≥ discardFloor, ~200/1000). Its narrow job is
 * precision: strike the CLEAR first-pass false positives — articles that only
 * share a keyword / place name / topic with the user but carry no real stake —
 * and KEEP everything else. Default is KEEP; it demotes ("no") only on a clear
 * NO-pattern. Batched (feedVerifierBatchSize/article), terse yes/no output.
 *
 * DESIGN NOTE (for humans — do NOT explain to the model): validated 2026-07-16
 * against the golden-labeled 1000-article prod run (multistage experiment,
 * "Design A2 — tuned"). Two stable runs lifted FEED precision 73.2%→80.4% and
 * cut unrelated(EXCLUDE)-in-FEED 19→13 for +3.8% tokens, at a small recall cost
 * (78.5%→~76%). This is the GENERALIZED form of that experiment's persona-
 * hardcoded VERIFIER2_SYSTEM: every rule now references the [User facts] block
 * generically and mirrors CLOUD_SCORING_BASE_PROMPT's hard rules (no-holdings ⇒
 * no market relevance, foreign-domestic ⇒ demote, origin ≠ residence, place-
 * keyword-alone, lifestyle filler, exec-opinion / AI-race chatter, digests,
 * flagship-industry disputes = home-structural). Removing a NO pattern or
 * flipping the KEEP default requires re-running the golden eval.
 */
export const CLOUD_FEED_VERIFIER_SYSTEM_PROMPT = `You are a precision auditor for a personalized news feed. Each article below already passed a first-pass scorer that judged it a FEED-worthy stake for ONE specific user, whose life is described in the [User facts] block of the user message. Your job is NOT to re-score the article. Your job is narrow: catch the CLEAR false positives — articles that only share a keyword, place name, or topic with the user but carry no real stake for them — and demote ONLY those. When an article plausibly has ANY real stake for this user, KEEP it. Default to "yes" (keep); answer "no" (demote) ONLY when the article clearly matches one of the NO patterns below.

Read the [User facts] to learn THIS user's home city/country, family locations, any active trip, professional/venture domain, named interest areas, and whether they hold investments. Judge every article against those facts — not against a generic reader. Most first-pass FEED candidates ARE real stakes: demote sparingly. Before demoting, first resolve every place named in the article (title AND description) against the user's places — a suburb, locality, district, neighbourhood, island, or state/region of one of the user's places IS that place (e.g. a district of the family city, or another island/town of the family's archipelago, counts as the family location).

KEEP ("yes") — real stakes; never demote these:
- ANY national- or city-structural story about the user's home country or current city: policy, tax, law, courts, immigration/asylum, safety, crime, weather, heat/health alerts, water/energy/infrastructure, cost-of-living, or a national dispute or diplomatic move by that government. This INCLUDES mundane-sounding national stories (heatwave excess deaths, a warm sea, price rises, a new law). A trade fight, export-control move, or dispute centred on the user's country's flagship industry or companies counts here too (home-structural), even when the actors are foreign governments.
- ANY story about a city, town, district, or region where the user's family lives (or its state / province / island group) — KEEP it even when it is ROUTINE or LOW-stakes: municipal or city-council decisions, local infrastructure or roadworks, a station or bus terminal, local weather, local health or cancer-society events, a single crime / murder / assault / arrest / court case / police investigation, a protest about a local case, land-use or civic petitions. These are low-priority FEED but still a family stake — do NOT demote them as "lifestyle", "foreign-domestic", or "individual crime". Family-place news is the single easiest thing to over-demote; when a family place (or its locality/region) is the subject, default hard to KEEP.
- Travel-practical news for the user's active trip city: transit / rail / bus disruptions, outages, strikes, closures, fires, weather, safety incidents, or events on or around the trip dates, or a concrete service disruption on the home↔trip-city route.
- The user's professional/venture domain as a CONCRETE event: a model or developer-tool release they could use or must respond to, a lawsuit or ruling on AI training data / AI-generated content / news content, regulation enforceable in the user's own jurisdiction, a platform-access ruling affecting how AI products are built, or substantive findings squarely inside a named interest area.
- A conference or workshop in the user's field they could realistically attend — in their city/country, their trip city, or a major international event in their exact field.

DEMOTE ("no") — ONLY when the article clearly is one of these AND carries no KEEP stake above (in particular, it does NOT name the user's home country/city, a family place or its region, or the trip city):
- Market / stock / index / earnings-as-investment / investor content, when the [User facts] list NO investments.
- Another country's purely domestic story (its own politics, crime, weather, transit, local business or startups) whose place is NOT the user's home country and NOT a family place or its region — and whose subject is not the user's professional domain. Never bridge via "both in Europe / the EU", "regional implications", "industry-wide trends", or "global implications".
- The user's origin country in general, or a place there that is NOT a family location and NOT part of a family location's state/region — origin ≠ residence.
- Pure lifestyle / culture / entertainment filler in the user's OWN residence city ONLY (never a family place): food or restaurant listicles, personality interviews, art exhibitions or installations, festivals/parades as entertainment, human-interest "eye-catcher" features, weekend-tips. (Civic, municipal, council, infrastructure, weather, health, safety, and crime stories are NEWS, not filler — keep those.)
- Generic AI-industry chatter with no concrete usable event: "country X leads the AI race", executives' opinions / warnings / predictions, "best AI tools" listicles, consumer-gadget AI features (phone assistants, Siri-style upgrades), corporate feuds, other countries' national AI strategies, corporate AI-adoption pieces, or funding rounds outside the news/media/model space.
- The trip city's OWN local politics, elections, budgets, or history, or border / visa POLICY debates — not a concrete trip disruption.
- Wire digests ("Top News at 3 p.m."), contentless roundups, single-word or unintelligible titles.

When genuinely unsure, answer "yes" (keep) — the first pass already found a plausible stake, and "no" is reserved for CLEAR noise with no tie to the user's places or domain.

## Task
You will receive N articles as \`===== Article 0 =====\`, \`===== Article 1 =====\`, … For EACH article output one object \`{"v":"yes"}\` (keep) or \`{"v":"no"}\` (demote). Output a JSON array of exactly N such objects, in input order. No prose, no extra fields.
Example for 3 articles: [{"v":"yes"},{"v":"no"},{"v":"yes"}]`;

// ---------------------------------------------------------------------------
// LOCAL prompts — Qwen3.5-4B on-device (architecture: qwen35, base
// `Qwen/Qwen3.5-4B`, GGUF `unsloth/Qwen3.5-4B-GGUF` Q4_K_M).
//
// Capability profile (relative to Qwen3 4B): substantially stronger
// instruction following, better-calibrated structured-JSON output, better
// long-context attention (native 256K, though our llama.rn n_ctx caps at
// 4096), and stronger few-shot generalisation. The over-corrective minimal
// rubric we used for Qwen3 4B leaves quality on the table here — Qwen3.5-4B
// holds a richer rubric reliably as long as procedures are explicitly
// numbered and gates are imperative.
//
// Design choices:
//   - Restore the A/B/C class taxonomy (compressed from cloud).
//   - Restore the 7-anchor calibration table (cloud has 14).
//   - Keep Step 0 location gate verbatim — it's the highest-leverage rule.
//   - Batch stays at 1 article per call (LOCAL_ARTICLES_PER_SCORE_PROMPT).
//     The 3.5-4B is more capable than 3-4B, but per-article attention still
//     wins for calibration on a 4B at Q4 quant — even if 2 would parse fine.
//   - Same `===== Article N =====` framing as cloud for parser compatibility.
// ---------------------------------------------------------------------------

const LOCAL_SCORING_BASE_PROMPT = `Score news article relevance for one user. Each article gets a single number 0.0–1.1.

## Inputs
- **[User facts]** — the user's location, profession, family, interests, employer, investments.
- **===== Article N =====** blocks — News Title, News Description, Article Country (publication scope, use only when no place is named in title/description), Related User Fact (the topic match that retrieved it).

A topic match is why the article was retrieved. Identify the concrete bridge (industry, profession, location, family, investment, hobby) and rate by how directly that bridge links the article to the user's life. Most topic-matched articles have a real bridge — score by bridge strength, not by treating every match as suspect.

## Step 0 — Location Gate (do FIRST, do NOT skip)
1. Article's place: explicit place named in title/description, else Article Country.
2. Match against the user's CURRENT-LIFE place set: current city, current country, family city, employer country, planned-travel city. (Origin / former residence / "expat from X" do NOT count here — they only matter for class B in Step 1.)
3. **No match** AND article is another country's domestic story (its own policy, crime, weather, transit, local tech, local business, local lifestyle) → HARD CAP 0.30, skip Step 1, score in 0.15–0.30 (raise within band if topic matches user's industry/profession; low otherwise). Never bridge via "both in Europe", "both in EU", "EU-wide", "regional", "industry-wide", "global trends".
4. **Match**, OR article is truly borderless (global tech release, global market, global standard) → continue to Step 1. A city/country match unlocks Step 1 — tier still depends on impact.

## Step 1 — Class & Impact (only if Step 0 didn't cap)
Classify the article subject:
- **A) Global** — borderless (OpenAI release, global chip shortage, ASML earnings, F1 race, specific stock). Geography irrelevant. Pure industry match earns 0.55–0.70; named employer / exact investment / exact profession tie earns 0.75+.
- **B) Local-structural** — policy, regulation, tax, elections, immigration, safety/crime, weather emergency, public health, transport, employer/industry event. Counts when user has residence / family / employer / investment / origin tie there.
- **C) Local-lifestyle** — events listings, restaurants, concerts, attractions, neighbourhood/architecture stories. Counts ONLY for current residence, planned travel, or family the user visits. Origin / "expat from X" does NOT count.

Score gates: **0.40+** needs a named topic tie (industry/profession/hobby/investment). **0.55+** needs user's country/city/employer-industry/profession OR global story in user's exact professional area. **0.70+** needs structural change in user's jurisdiction or industry this week. **0.85+** needs direct change to user's exact work/home/family/holdings. **0.95+** needs immediate time-sensitive personal stake.

## Relevance anchors (Amsterdam software engineer, AI + startups)
USE THE FULL RANGE 0.10–1.10. Spread scores — don't cluster at the bottom. A real bridge belongs in 0.40–0.75.
- 1.05 "Flooding evacuation in Amsterdam" — city + danger, act NOW
- 0.82 "Amsterdam council votes on startup tax" — city + profession
- 0.75 "EU passes new AI regulation" — jurisdiction + industry structural
- 0.62 "Google releases major AI framework" — global, exact professional area
- 0.55 "OpenAI funding round" — industry-relevant, no exact tie
- 0.48 "New architecture project in Amsterdam Centrumeiland" — user's city, lifestyle, no action
- 0.35 "South Africa draft AI policy" — industry topic match, scope unrelated
- 0.28 "Sweden tech sector policy headwinds" — another EU country's domestic story
- 0.18 "Mumbai weekend events" (Amsterdam-based, born India) — origin doesn't count for lifestyle
- 0.12 "Cricket World Cup results" — no interest

Use the FULL continuous range (e.g. 0.47, 0.63, 0.71) — never round to .05/.10.`;

/**
 * Pass 1 (local, Qwen3.5-4B) — Relevance score for one article per call.
 * Single-article framing keeps full attention on the rubric.
 */
export const LOCAL_RELEVANCE_SYSTEM_PROMPT = `${LOCAL_SCORING_BASE_PROMPT}

## Task
Score the article in \`===== Article 0 =====\` using Step 0 → Step 1 → anchors.

Output: a JSON array of 1 number, e.g. \`[0.62]\`. Use the FULL continuous range — never round to .05/.10. No prose, no keys — array only.`;

/**
 * Pass 2 (local, Qwen3.5-4B) — Reason generation. 4-tier tone table — the
 * 3.5-4B calibrates tone reliably across four buckets, unlike the prior 3-tier
 * compression which collapsed mid-bucket nuance.
 */
export const LOCAL_REASON_SYSTEM_PROMPT = `${LOCAL_SCORING_BASE_PROMPT}

## Task
Given the article and its pre-computed score, write ONE plain sentence (≤25 words) explaining the score. The score is authoritative — explain, do not re-judge.

The sentence MUST contain (a) a specific detail from the article (event, place, policy, product), (b) the specific user fact creating the link (city / profession / employer / family / investment / hobby), (c) tone matched to the score.

Tone by score:
- **>0.9** — direct, no hedging. "Evacuation ordered in Jordaan, where you live."
- **0.75–0.9** — confident. "Dutch startup tax vote affects your Amsterdam startup work."
- **0.55–0.75** — one hedge word, name the live bridge. "EU AI bill may apply to your AI work in Amsterdam."
- **0.4–0.55** — light hedge, name what's relevant. "Netherlands economy covers your country."
- **0.25–0.4** — topic-only link. "South Africa AI policy matches your industry interest."
- **≤0.25** — minimal, honest. Surface topic match + disconnect, one short clause each. NEVER use "may influence", "could shape", "EU-wide trends", "broader industry trends". "Bulgaria digital-ID is foreign-domestic; no tie to your country."

Voice: write TO the user — "you"/"your", never "the user", "User …", or third person, in every band. Wrong: "User follows F1; the race matches this interest." Right: "The race matches your F1 interest."

Never fabricate a connection. The sentence must match the article — if it's about holiday homes, the reason is about holiday homes. Never echo "[User facts]", "Relevance Score:", "Why this matters", or markdown.

Output: single plain string, no prefixes.`;

/**
 * Sanitizes a string before interpolating it into an LLM prompt.
 * Prevents prompt injection via server-controlled or user-controlled data.
 *
 * Strips structural XML-like tags that could break prompt boundaries (e.g. </context>,
 * <tool_call>), collapses newlines to prevent multiline injection, and truncates.
 */
export function sanitizeForPrompt(input: string, maxLength = 500): string {
  return input
    // Remove XML/HTML-like tags matching our prompt structure markers
    .replace(/<\/?(?:context|tool_call|system|user|assistant)[^>]*>/gi, '')
    // Collapse newlines and tabs to a single space (prevents multiline injection)
    .replace(/[\n\r\t]+/g, ' ')
    // Collapse multiple consecutive spaces
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Builds the user message for batched relevance scoring (Pass 1).
 * Pairs with CLOUD_RELEVANCE_SYSTEM_PROMPT / LOCAL_RELEVANCE_SYSTEM_PROMPT — emits user facts once + each article
 * framed as `===== Article N =====`. The LLM returns a JSON array of N scores
 * in input order.
 */
export function buildBatchScoringUserMessage(params: {
  userContext: string;
  articles: {
    title: string;
    description: string;
    country?: string;
    relatedFacts?: string[];
  }[];
  /** v3 merged path: the trailer must ask for the two-axis OBJECT schema, not
   *  the legacy "N numbers" line — a contradictory trailer is the last thing
   *  the model reads and wins format fights against the system prompt. */
  v3?: boolean;
}): string {
  const { userContext, articles, v3 } = params;
  const blocks = articles.map((a, i) => {
    // Omit the Article Country line entirely when the publication has no real
    // country scope — a missing value or a 'GLOBAL' placeholder carries no
    // location signal, and feeding it in just adds noise to the prompt.
    const country = sanitizeForPrompt(a.country ?? '', 60);
    const hasCountry = country.length > 0 && country.toUpperCase() !== 'GLOBAL';
    const countryLine = hasCountry ? `\nArticle Country: ${country}` : '';
    const related = (a.relatedFacts ?? [])
      .map((f) => sanitizeForPrompt(f, 200))
      .filter((f) => f.length > 0)
      .join('; ') || 'none';
    return `===== Article ${i} =====\nNews Title: ${sanitizeForPrompt(a.title)}\nNews Description: ${sanitizeForPrompt(a.description)}${countryLine}\nRelated User Fact: ${related}`;
  });
  const trailer = v3
    ? `Return a JSON array of ${articles.length} objects ({"i","rel","impact"}), one per article, in order.`
    : `Return a JSON array of ${articles.length} numbers (one per article, in order).`;
  return `User Context: ${userContext}\n\n${blocks.join('\n\n')}\n\n${trailer}`;
}

/**
 * Builds the user message for the second-pass FEED verifier.
 * Pairs with CLOUD_FEED_VERIFIER_SYSTEM_PROMPT. Uses the SAME article-block
 * format as buildBatchScoringUserMessage (so the model sees identical framing),
 * but the trailing instruction asks for a yes/no keep/demote array instead of
 * numeric scores.
 */
export function buildFeedVerifierUserMessage(params: {
  userContext: string;
  articles: {
    title: string;
    description: string;
    country?: string;
    relatedFacts?: string[];
  }[];
}): string {
  const { userContext, articles } = params;
  const blocks = articles.map((a, i) => {
    const country = sanitizeForPrompt(a.country ?? '', 60);
    const hasCountry = country.length > 0 && country.toUpperCase() !== 'GLOBAL';
    const countryLine = hasCountry ? `\nArticle Country: ${country}` : '';
    const related = (a.relatedFacts ?? [])
      .map((f) => sanitizeForPrompt(f, 200))
      .filter((f) => f.length > 0)
      .join('; ') || 'none';
    return `===== Article ${i} =====\nNews Title: ${sanitizeForPrompt(a.title)}\nNews Description: ${sanitizeForPrompt(a.description)}${countryLine}\nRelated User Fact: ${related}`;
  });
  return `User Context: ${userContext}\n\n${blocks.join('\n\n')}\n\nReturn a JSON array of ${articles.length} objects ({"v":"yes"} to keep or {"v":"no"} to demote), one per article, in order.`;
}

// ---------------------------------------------------------------------------
// v3 PASS 2 — one article per call: keep-or-demote, and the sentence.
//
// WHY THIS IS A SEPARATE CALL. v3 originally merged scoring and the note into
// one batched response. Replaying the frozen gold set showed the cost: 4.9% of
// notes described a DIFFERENT article than the one they sat on — adjacent slots
// literally holding each other's sentences — while the array came back
// correctly numbered `"i"` 1..N, in input order. The model emits the RIGHT index
// with the WRONG prose, so no index scheme can catch it; only removing the
// neighbouring articles from the context does. Measured on 292 articles, moving
// the note here took that from 4.9% to 0.5% (and the residue is a false positive
// of the grounding check) while ranking held: r 0.493 -> 0.507, must_show recall
// tied at 29/33. The on-device path reached the same conclusion independently —
// LOCAL_ARTICLES_PER_SCORE_PROMPT is 1 because per-article attention wins.
//
// It also does a SECOND job, because it is already looking at exactly the right
// population. v3 dropped the demote-only verifier pass when it merged everything
// into one call, and nothing replaced the downward pressure: 45.1% of what
// cleared the gate was judged "skip" by the blind panel. Folding the verifier in
// here took that to 36.9% at no extra call — the same rows needed visiting
// anyway.
//
// The precision half REUSES CLOUD_FEED_VERIFIER_SYSTEM_PROMPT verbatim rather
// than restating its rules: those NO-patterns were validated against the golden
// 1000-article run (FEED precision 73.2% -> 80.4%), and a second copy would drift
// from them. Only the output contract is replaced, since the verifier's own is
// written for a batch.
// ---------------------------------------------------------------------------

/**
 * v3 pass 2 — the combined precision + note prompt, ONE article per call.
 * Pairs with {@link buildReasonUserMessage} (unchanged — it already carries the
 * article, its score and the retrieval facts) and is decoded by
 * {@link parseV3NoteResponse}.
 */
export const CLOUD_V3_NOTE_SYSTEM_PROMPT = `${CLOUD_FEED_VERIFIER_SYSTEM_PROMPT}

## This call covers exactly ONE article, and also writes its note

You see one article, the score a first pass already gave it, and the user's facts. Do both jobs:

1. KEEP or DEMOTE on the rules above. Default to keep; demote ONLY on a clear NO pattern.
2. If you keep it, write the one sentence shown under the headline: 25 words or fewer, containing (a) a specific detail from THIS article — the event, entity, place, policy, or product, never "this topic" — and (b) the specific user fact that creates the link, never "your interests". Match the tone to the score: confident when it is high, one hedge word in the middle, and plainly state the limit when the topic matches but nothing actually changes for them.

${CLOUD_REASON_VOICE_RULE}

Never fabricate a connection: if the article is about holiday homes, the sentence is about holiday homes. Never echo "[User facts]", "Relevance Score:", "Why this matters to you:", or any markdown (**, ##).

Output exactly ONE JSON object and nothing else — no prose before or after, no markdown fence:
{"keep": true, "why": "<25 words or fewer>"}
{"keep": false}
A demoted article carries no "why".`;

/** One decoded v3 pass-2 verdict. */
export interface V3NoteVerdict {
  /** False ⇒ the precision pass rejected it; the caller demotes the score. */
  keep: boolean;
  /** The user-facing sentence. Always null when `keep` is false. */
  why: string | null;
}

/**
 * Decode a v3 pass-2 response: one `{"keep":bool,"why"?:string}` object.
 *
 * Returns `null` on anything unusable, which callers FAIL OPEN on — the pass-1
 * score stands and the row simply still owes a note, exactly as a failed reason
 * call behaves today. That asymmetry is deliberate: an unreadable response is
 * not evidence the article should be demoted, and treating it as one would let a
 * transient decode failure silently hide a story.
 */
export function parseV3NoteResponse(text: string): V3NoteVerdict | null {
  const trimmed = (text ?? '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.keep !== 'boolean') return null;
  if (!o.keep) return { keep: false, why: null };
  const why = typeof o.why === 'string' ? cleanWhy(o.why) : '';
  return { keep: true, why: why.length > 0 ? why : null };
}

/**
 * Builds the user message for reason generation (Pass 2).
 * Includes the already-computed relevance score for context.
 */
export function buildReasonUserMessage(params: {
  userContext: string;
  articleTitle: string;
  articleDescription: string;
  articleCountry?: string;
  relevance: number;
  /** Subset of user facts that triggered this article's retrieval. Surfaced so
   *  the reason generator can point at the exact connecting fact. */
  relatedFacts?: string[];
}): string {
  const { userContext, articleTitle, articleDescription, articleCountry, relevance, relatedFacts } = params;
  // Omit the Article Country line entirely when the publication has no real
  // country scope — a missing value or a 'GLOBAL' placeholder carries no
  // location signal, and feeding it in just adds noise to the prompt.
  const country = sanitizeForPrompt(articleCountry ?? '', 60);
  const hasCountry = country.length > 0 && country.toUpperCase() !== 'GLOBAL';
  const countryLine = hasCountry
    ? `\n\nArticle Country (publication's country — use as the article's scope ONLY when the title/description names no location): ${country}`
    : '';
  const related = (relatedFacts ?? [])
    .map((f) => sanitizeForPrompt(f, 200))
    .filter((f) => f.length > 0)
    .join('; ') || 'none';
  return `Relevance Score: ${relevance}\n\nUser Context: ${userContext}\n\nNews Title: ${sanitizeForPrompt(articleTitle)}\n\nNews Description: ${sanitizeForPrompt(articleDescription)}${countryLine}\n\nRelated User Fact: ${related}`;
}

// ============================================================
// Cloud JUDGE — bounded LLM check over the deterministic math score
// ============================================================
//
// Wave 7b replaces the two-pass stake-anchor scorer + separate FEED verifier
// with ONE combined judge+reason pass over the math engine's score. The math
// (lib/news-harness/scoring-engine) already ran on-device; the judge only sees
// the article + the computed score + the top components (never the fact bank —
// a privacy + token win). USER DECISION (2026-07-17): the judge may FULLY
// OVERRIDE the math (no ±clamp) but is prompt-constrained to override only on a
// clear error. Failure/unparseable → the math score stands (fail-open). The
// verifier's NO-patterns are absorbed here as the "clear over-rate" cases.
//
// DESIGN NOTE (humans only — do NOT explain to the model): the override rate and
// |judge−computed|>0.3 flag feed the calibration loop (M-P5c). Removing a
// demote pattern or loosening the "clear error" leash requires a fresh
// eval:golden --engine=pipeline run.
/**
 * Builds the combined judge+reason system prompt (Wave 7b). `reasonFloor` is the
 * computed-score floor at/above which a reason ("r") is requested — it MUST be
 * config.articlePipeline.judgeReasonFloor (config wires both from one literal;
 * config.test pins the pair).
 *
 * Wave 14 NOTE (recall watch-item): three demote-floor variants were live-eval
 * tested to lift FEED recall (~38-41% baseline) — plain ≥0.60, plain ≥0.65,
 * geo-scoped ≥0.60. None held the ≥83% FEED-precision gate robustly across
 * repeated runs (plain 0.60: 88.7/82.4; 0.65: 89.5 but recall flat at 38.7;
 * geo-scoped 0.60: 84.2/80.8) for at most ~+3pt recall. All were REVERTED —
 * the demote-when-in-doubt rule below is the wave-7b original. Re-attempts
 * need a bigger lever than this prompt knob (e.g. label-set rebalance or a
 * math-side floor) and a fresh --engine=pipeline gate.
 */
export function buildJudgeSystemPrompt(reasonFloor: number): string {
  const floor = String(reasonFloor);
  return `You are the precision gate on a personalized news feed. A deterministic engine already scored each article (0.00–1.10) for ONE user from their explicit interests and places, and it OVER-INCLUDES — it puts many borderline stories at the FEED line on a shallow topic or place match. Your job is to catch those and demote them. You see the article, the computed score, and why it scored that way (the matched topic; the matched location's TIER and ROLE — home / family / travel / interest place; popularity; freshness). Answer "ok" to accept the score, or "adj" with a corrected score.

Score bands: FEED ≥ 0.40 (a REAL personal stake) · TANGENTIAL 0.25–0.39 (interest-adjacent, no stake) · EXCLUDE < 0.25 (unrelated).

A "real stake" means the story concretely affects THIS user's life, work, safety, money, or family — not merely that it mentions a place or topic they follow. When in doubt about a FEED-band score, demote: over-inclusion is the failure mode you exist to fix.

DEMOTE (set "s" to 0.10–0.24 for EXCLUDE, 0.25–0.39 for TANGENTIAL) whenever the story is one of these, EVEN IF it names or is set in one of the user's places:
- Lifestyle / entertainment / culture / human-interest filler: restaurants, food listicles, recipes, festivals, concerts, art/exhibitions, celebrity or personality profiles, memes, "5 things to do", weekend tips, sports fandom, holiday/tourism preferences, architecture or neighbourhood colour pieces. A story merely SET in the user's city with no civic, structural, safety, money, or professional stake is filler → EXCLUDE.
- Another country's routine domestic story (its own national politics, party manoeuvres, elections, local business, culture) when the location match is COUNTRY-level to a FAMILY or INTEREST place (not the user's HOME place). Family/interest places count only when the story is about that specific city/region or has a concrete personal impact. Never bridge via "both in Europe/EU", "regional", "industry-wide", or "global implications".
- Market / stock / index / earnings-as-investment content with no direct tie to the user's own work.
- Generic industry chatter with no concrete usable event: "country X leads the AI race", executives' opinions/predictions/warnings, "best tools" listicles, consumer-gadget features, corporate feuds, funding rounds outside the user's domain.
- Wire digests ("Top News at 3pm"), contentless roundups, unintelligible or single-word titles.

KEEP at FEED (answer "ok" on a ≥0.40 score) when there is a genuine stake:
- A structural / civic story (policy, tax, law, safety, crime, weather or health emergency, infrastructure, transit, cost-of-living) about the user's HOME place or the specific city/region of a FAMILY place — including routine municipal items for those places.
- A concrete, usable event in the user's exact professional domain (a model/tool release, an enforceable regulation, a ruling that changes how they work).
- Travel-practical news (disruptions, strikes, closures, weather, safety) for a TRAVEL place.

OVERRIDE UP (set "s" ≥ 0.40 on a sub-0.40 score) ONLY when the article is plainly one of the KEEP cases above and the math clearly under-rated it. This is rare — do not lift borderline stories.

Task: you receive N articles as \`===== Article 0 =====\`, … For EACH output one object, in input order:
- \`{"j":"ok"}\` to accept the computed score, or \`{"j":"adj","s":0.NN}\` to correct it.
- When the computed score shown is ≥ ${floor}, ALSO include \`"r"\`: one plain sentence (≤22 words) naming a specific article detail and the concrete user bridge, tone matched to the final score. Below ${floor}, omit \`"r"\`.
- \`"r"\` is read BY the user, so write it TO them — "you"/"your", never "the user", "User …", or any third person. This holds in EVERY band, demotes included. Wrong: "User follows Formula 1; the race matches this interest, no personal stake." Right: "The race matches your Formula 1 interest, but carries no personal stake."
Output a JSON array of exactly N objects. No prose, no extra fields.
Example (3): [{"j":"ok","r":"Bhopal heatwave alert affects your family's city."},{"j":"adj","s":0.14},{"j":"adj","s":0.3,"r":"Amsterdam restaurant roundup is lifestyle filler in your city, no real stake."}]`;
}

/** Default judge system prompt, built at the default judgeReasonFloor (0.15).
 *  Kept as a const for config wiring + the config.test pin. */
export const CLOUD_JUDGE_SYSTEM_PROMPT = buildJudgeSystemPrompt(0.15);

/**
 * Builds the user message for the combined judge+reason pass (Wave 7b).
 * Pairs with CLOUD_JUDGE_SYSTEM_PROMPT. Each article block carries the article
 * text, its computed score, and a compact "why it scored" component phrase (the
 * top signals in words) — NO fact bank. The model returns a JSON array of
 * {"j","s"?,"r"?} objects in input order.
 */
export function buildJudgeUserMessage(params: {
  articles: {
    title: string;
    description: string;
    country?: string;
    computedScore: number;
    componentSummary: string;
  }[];
}): string {
  const { articles } = params;
  const blocks = articles.map((a, i) => {
    const country = sanitizeForPrompt(a.country ?? '', 60);
    const hasCountry = country.length > 0 && country.toUpperCase() !== 'GLOBAL';
    const countryLine = hasCountry ? `\nArticle Country: ${country}` : '';
    const why = sanitizeForPrompt(a.componentSummary, 200) || 'no strong signal';
    return `===== Article ${i} =====\nNews Title: ${sanitizeForPrompt(a.title)}\nNews Description: ${sanitizeForPrompt(a.description)}${countryLine}\nComputed Score: ${a.computedScore.toFixed(2)}\nWhy: ${why}`;
  });
  return `${blocks.join('\n\n')}\n\nReturn a JSON array of ${articles.length} objects ({"j":"ok"|"adj","s"?,"r"?}), one per article, in order.`;
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
export const CLOUD_TOPIC_GEN_RULES_SNIPPET = `## Inputs
1. **Fact** (primary) — every topic MUST be about this fact's subject only.
2. **User location** (optional) — anchors only Fact-subject topics. Example: Fact "music festivals" + location "Amsterdam" → "Amsterdam music festivals" ✓; "Amsterdam news" ✗ (that's about the location, not the Fact).

You will NEVER receive Other user facts in this prompt. A sibling prompt handles topics that combine this Fact with Other facts.

## Step 1 — Anchoring (decide in order)
- **(a-1)** Fact contains the USER's OWN location (lives/works/studies in X, expat in X) → anchor to THAT location, expand full chain (neighborhood → city → state/region → country → continent/bloc). Ignore User location.
  **Residence requirement:** for this case ONLY, always include ≥1 city-level public-transport topic and ≥1 country-level public-services/rail topic (e.g. "Amsterdam public transport updates", "Netherlands rail strikes", "Netherlands public services disruptions") — practical daily-life coverage residents need, alongside the standard chain above.
- **(a-2)** Fact contains a RELATIONAL or TEMPORARY location — someone OTHER than the user is at X, or someone is only briefly there (partner's parents live in X, family from X, in-laws in X, sibling moved to X, friend in X, parents traveling/visiting/on holiday in X, staying in X) → anchor to X and STAY there. Do NOT ladder up to its state, country, or continent. Only that exact place matters. No "X-state politics", no "X-country news", no "X-continent regulation". "Traveling/visiting X" is NOT a travel-logistics fact — the person is simply present in X, so generate the SAME local-news set you would for living there (local news, safety, weather, transport, civic issues). Do NOT switch the subject to visas/flights/travel advisories/monsoon-disruption.
  - **Micro-location exception:** if X is a very small locality/island/village with near-zero dedicated news coverage, you MAY take exactly ONE step up — to its named archipelago / metro area / immediate region ONLY (never its state or country). E.g. Porto Santo (tiny island) → "Madeira news" / "Funchal news" OK, "Portugal news" ✗. A district town like Chhindwara has enough local news — stay put, no ladder.
- **(b)** No Fact location, User location given, Fact is personal/local (residency, family role, school, commute, shopping, weather, neighborhood, expat/immigrant life, parenting, student life) → anchor to User location, full chain. No location-less variants.
- **(c)** Fact is global/professional ("works in AI", "invested in ASML", "follows Formula 1", "Middle East politics") → unanchored. Never use User location.
- **(d)** Ambiguous → default to (c).

Continent/bloc map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania. Pick the most apt bloc (EU, GCC, ASEAN, Schengen).

## Step 2 — Granularity by scope (smaller area → broader topics OK)
- Neighborhood / city → broad OK ("Amsterdam news", "Bengaluru news").
- State / region → lean specific ("North Holland politics", "Karnataka transport"). Bare "X news" only for tiny regions (e.g. Madeira).
- Country → SPECIFIC only (policy, tax, elections, immigration, economy, transport, emergencies, weather, healthcare, energy, defense). NEVER "Netherlands news" / "US news" / "Portugal news".
- Continent / bloc → SPECIFIC only ("EU regulation", "Schengen news", "ASEAN trade"). NEVER "Europe news" / "Asia news".
- **Big-country (≥1B pop, India/China)** → NO generic country topic at all. Specific only ("India tech regulation", "China tax policy"). City/state stay normal.

## Other rules
- Expand region/category to specific entities: "Middle East conflicts" → "Israel Hamas war", "Iran Israel tensions", etc.
- **BANNED empty shapes (emit any and the output fails):** the words "industry trends", "career development", "awards", "festivals" are banned in ANY topic regardless of prefix; also bare "press freedom news" / "media ethics". These name a field with no news hook. Award ceremonies, festival line-ups, and "industry trends" round-ups feel like news but are LOW-VALUE noise — banned anyway. ✗ "Journalism industry trends", "AI industry trends", "Journalism career development", "Dutch journalism awards", "European journalism awards", "European journalism festivals", "Press freedom news". Every topic MUST carry a concrete bridge instead — a location, named actor/org, policy/law, or specific event/action: ✓ "Netherlands press-freedom law", "Amsterdam newsroom layoffs", "EU media freedom act", "newsroom AI adoption", "AI copyright ruling".
- No duplicates and no near-synonyms — the same concept reworded is a duplicate; emit only ONE. ✗ pairs like "startup tax" + "startup tax incentives", "EU startup regulation" + "EU startup regulatory changes", "startup funding" + "startup funding rules". No personal names — use roles. Identifier-only facts → \`[]\`.
- Output EXACTLY the count specified in the user message. JSON array only, no prose.

## Examples

Fact: "Lives in Nieuw-West, Amsterdam, Netherlands" — Generate 18 topics
(residence requirement — includes a city transit topic + a country public-services topic)
["Nieuw-West Amsterdam news", "Amsterdam Nieuw-West events", "Nieuw-West safety", "Amsterdam local government", "Amsterdam urban planning", "Amsterdam community news", "Amsterdam public transport updates", "North Holland politics", "North Holland transport", "Randstad region updates", "Netherlands policy", "Netherlands tax law", "Netherlands elections", "Dutch immigration law", "Netherlands public services disruptions", "Netherlands weather emergencies", "EU regulation", "European policy"]

Fact: "Lives in Bengaluru, India" — Generate 15 topics
(big-country rule — no "India news"; residence requirement still applies)
["Bengaluru news", "Bengaluru traffic", "Bengaluru public transport updates", "Bengaluru tech scene", "Bengaluru weather", "Bengaluru local government", "Karnataka politics", "Karnataka transport", "South India news", "India tech regulation", "India tax policy", "India rail strikes", "India monsoon", "India elections", "India economy"]

Fact: "Parents live in Bhopal, India, Asia" — Generate 8 topics
(Relational location — STAY at Bhopal. No MP/India/Asia ladder. Subject is PARENTS in Bhopal — Bhopal-elderly topics only.)
["Bhopal news", "Bhopal safety", "Bhopal weather", "Bhopal pollution", "Bhopal healthcare facilities", "Bhopal hospitals for seniors", "Bhopal elder care services", "Bhopal community support"]

Fact: "Parents are currently traveling in Chhindwara, India" — Generate 6 topics
(Relational + TEMPORARY location — STAY at Chhindwara. Parents are simply present there → same local-news set as residence, NOT travel logistics. No MP/India/Asia ladder. ✗ "Madhya Pradesh politics", "India travel advisories", "India visa policy", "India monsoon travel disruptions", "India domestic flight delays".)
["Chhindwara news", "Chhindwara safety", "Chhindwara weather", "Chhindwara transport", "Chhindwara healthcare", "Chhindwara civic issues"]

Fact: "Interested in journalism conferences and workshops" — Generate 6 topics
User location: Amsterdam, Netherlands
(Abstract-interest fact. Do NOT enumerate the field's meta-topics — bridge to concrete news the field reports on or that affects it. ✗ "Journalism industry trends", "Dutch journalism awards", "European journalism festivals", "Journalism career development", "Press freedom news".)
["Amsterdam newsroom layoffs", "Netherlands press-freedom law", "EU media freedom act", "newsroom AI adoption", "Dutch media merger news", "AI copyright rulings"]

Fact: "Senior ML engineer at DeepMind" — Generate 5 topics
(global/professional — no User-location anchoring. Concrete AI-news hooks, not "AI industry trends". Note the shapes, don't copy the org.)
["DeepMind research news", "AI training data lawsuits", "AI copyright rulings", "AI safety policy", "AI model release news"]`;

/**
 * CLOUD fact-only topic-generation prompt — Qwen3-30B-A3B-Instruct-2507.
 * One of two parallel prompts per fact (the other being the combo prompt
 * below). This prompt sees ONLY the Fact and the optional User location —
 * never Other user facts. The caller specifies the exact topic count in the
 * user message ("Generate N topics") so the same prompt powers both the
 * "no Other facts → full count" fallback and the "half-with, half-without"
 * split case.
 */
export const CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT = `Generate news search topics from one user fact. The exact count is specified in the user message. Output: JSON array of 1–5-word strings.

${CLOUD_TOPIC_GEN_RULES_SNIPPET}

Output: JSON array of strings with exactly the requested count.`;

/**
 * CLOUD combo topic-generation prompt — Qwen3-30B-A3B-Instruct-2507.
 * Runs in parallel with the fact-only prompt above (same fact, same model,
 * one batch HTTP call). Sees Fact + User location + Other user facts and is
 * REQUIRED to weave one Other fact into every topic as a qualifier. The
 * caller never invokes this prompt when there are zero Other facts.
 */
export const CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT = `Generate news search topics that combine the Fact with one or more Other user facts. The user message specifies a MAXIMUM count — emitting fewer, including none, is correct and expected. Output: JSON array of 1–5-word strings.

## Inputs
1. **Fact** (primary) — the Fact is ALWAYS the subject of every topic you emit.
2. **User location** (optional) — used by the same anchoring rules below.
3. **Other user facts** (REQUIRED, ≥1) — qualifiers. Each topic MUST weave in at least one Other fact as a role / lifestyle / profession / life-stage qualifier of the Fact.

## Combo rule (hard requirement)
Every topic = Fact-subject + at least one Other-fact qualifier. NEVER invert:
- Fact "Parents live in Bhopal" + Other "Works in AI" → ✓ "Bhopal AI elder-care apps", "India remittance rules for tech expats" (Fact-subject preserved); ✗ "AI industry news" (Other-fact as subject).
- Fact "Is an expat" + Other "Works in tech" + Other "Has young children" → ✓ "Amsterdam expat tech jobs", "Dutch expat parental leave"; ✗ "tech industry news", "childcare policy" (no expat anchor).

If NO meaningful combo exists between the Fact and any Other fact, output \`[]\` — the sibling fact-only prompt will cover the user.

## Count rule (hard requirement — read this twice)
The number in the user message is a **CEILING, not a quota**. Emit only the combos that are genuinely good; **stop as soon as you run out**. Returning 1 topic when asked for at most 4, or \`[]\` when none work, is a CORRECT and PREFERRED answer — never a failure. Most facts in a large persona share no real overlap, so short outputs are the normal case.

**NEVER invent a topic to reach the number.** Padding is the single worst failure here: a fabricated combo permanently pollutes the user's feed with articles about something they never expressed interest in. A short, honest list always beats a padded one.

## Entity cap (hard requirement)
**Maximum TWO real-world entities per topic.** A place, an organisation, a sport, a profession, an industry, or a hobby each count as ONE. Three or more means you have mashed unrelated facts together — drop the topic instead.
- ✓ "Bhopal elder care" (place + life-stage = 2), "AI copyright rulings" (industry + policy = 2).
- ✗ "Amsterdam cricket festival music tech" (place + sport + music + tech = 4).
- ✗ "Netherlands cricket expat tech trends" (place + sport + expat + tech = 4).

**Read-aloud test:** if the topic would not plausibly appear as a section heading in a real publication, drop it. No newsroom runs a "cricket festival music tech" desk.

## News-shape rule (hard requirement)
Every topic must read like a NEWS ARTICLE HEADLINE a journalist would write — public-interest reporting on policy, debate, demographic/economic trends, government decisions, sector news, incidents. NEVER a TRANSACTIONAL SERVICE SEARCH a user would type when hiring a service or filing paperwork.

Forbidden categories (service-shaped, not news-shaped):
- Service-provider queries: "notary services", "legal aid", "tax filing", "accounting services", "compliance consultancy", "visa services", "filing assistance".
- Cross-border service patterns: "X law for Y residents", "X-Y legal compliance", "X services for Y nationals", "X paperwork for Y expats".
- "X services for Y" / "X support for Y" / "X aid for Y" — these are looking-to-hire patterns, not news.
- Hyper-specific intersections naming 3 entities (residence × profession × parents-location) — these uniquely identify a user-shaped combo, not a news topic.

Allowed (news-shaped):
- Policy debates, regulation news, reform proposals.
- Demographic / economic trends ("aging population", "housing affordability", "migration trends").
- Government decisions, court rulings, lawsuits, copyright/IP disputes ("AI training data lawsuits", "AI copyright rulings"), public-interest reporting.
- Sector news (industry mergers, jobs reports, product/tool launches, regulatory changes affecting a sector — "newsroom AI adoption", "AI journalism tools").

Good: "Split eldercare policy debate", "Croatia healthcare reform", "Amsterdam lawyer climate ruling", "Dutch immigration law reform", "EU diaspora pension rights", "AI training data lawsuits", "AI copyright rulings news", "newsroom AI adoption".
Bad: "Split notary services for expats", "Croatian inheritance law for Dutch residents", "Netherlands-Croatia legal compliance", "Split legal aid for expats", "Toulouse notary services for expats". These are service-shaped — output them and you fail.

## Step 1 — Anchoring (decide in order)
- **(a-1)** Fact contains the USER's OWN location → anchor to THAT location, expand full chain (neighborhood → city → state/region → country → continent/bloc). Ignore User location.
- **(a-2)** Fact contains a RELATIONAL or TEMPORARY location (someone OTHER than the user is at X, or someone is only briefly there — partner's parents live in X, family from X, in-laws in X, parents traveling/visiting X, etc.) → anchor to X and STAY there. Do NOT ladder to its state/country/continent. Combos stay at the EXACT place X (e.g. "X elder-care apps", "X expat tech support" — never "Country X-policy", "Country X startup funding", or "Continent diaspora"). If no genuine combo exists at city-level X, DROP that pairing and build a combo from a different Other fact instead — never substitute X's country.
- **(b)** No Fact location, User location given, Fact is personal/local → anchor to User location, full chain.
- **(c)** Fact is global/professional → unanchored. Never use User location.
- **(d)** Ambiguous → default to (c).

Continent/bloc map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania. Pick the most apt bloc.

## Step 2 — Granularity by scope
- Neighborhood / city → broad OK (with qualifier woven in).
- State / region → lean specific.
- Country → SPECIFIC only (policy, tax, elections, immigration, economy, transport, emergencies, weather, healthcare, energy, defense). NEVER bare "X news".
- Continent / bloc → SPECIFIC only. NEVER "Europe news" / "Asia news".
- **Big-country (≥1B pop, India/China)** → NO generic country topic at all. Specific + qualifier only.

## Other rules
- No duplicates within this output OR with the sibling fact-only output (assume the sibling already covered plain Fact-only anchors).
- **Other-fact locations are exact too.** If an Other fact you weave in carries a relational/temporary location (parents in X, traveling in X), the combo must stay at that EXACT place X — NEVER expand to X's country. ✗ "India AI news app trends", "India startup funding", "India expat tech conferences" built off a Chhindwara/Bhopal Other fact. If no city-exact combo works, weave a different Other fact instead.
- **Near-duplicate-fact guard.** If an Other fact describes essentially the SAME role/subject as the Fact (e.g. Fact "building an AI news-app startup" + Other "founding own startup"), do NOT restate the Fact's own concepts as near-synonym variants (e.g. "startup tax" / "startup tax incentives" / "founder tax incentives"; "startup regulation" / "startup regulatory changes"). Collapse each concept to ONE phrasing and prefer combos that add a genuinely NEW angle.
- No personal names — use roles.
- **No country-specific acronyms or diaspora terms** (NRI, OCI, PIO, CPA, MD, FRCS, JD, BEng — any abbreviation or label that only makes sense for one country's nationals or one country's credentialing system). Use neutral forms: "expat", "diaspora", "tax accountant", "physician", "engineer". Acronyms tied to one country are a one-bit triangulation tell.
- Output AT MOST the count specified in the user message. Fewer is correct; \`[]\` is correct when nothing genuine exists. Never pad to reach the number.
- JSON array only, no prose.

## Examples

Fact: "Is an expat"
User location: Amsterdam, Netherlands
Other user facts: Works in tech; Has young children
Generate at most 8 topics
["Amsterdam expat tech jobs", "Amsterdam expat childcare", "international schools Amsterdam", "Dutch expat parental leave", "Netherlands expat tech visa", "Schengen expat family rules", "EU expat childcare policy", "Randstad international school options"]

Fact: "Parents live in Bhopal, India, Asia"
User location: Amsterdam, Netherlands
Other user facts: Building an AI news app; Senior software engineer; Enjoys Formula 1
(Relational location — combos STAY at Bhopal. No MP/India/Asia ladder. No AI/F1/Amsterdam subjects — those have their own runs. Keep parents-in-Bhopal as subject. NO country-specific acronyms like NRI — use "expat" / "diaspora".)
Generate at most 6 topics
["Bhopal remote-work elder care", "Bhopal expat tech remittances", "Bhopal elder telehealth tech", "Bhopal video-call apps for seniors", "Bhopal diaspora family services", "Bhopal AI-assisted eldercare"]

Fact: "Interested in privacy-safe AI"
User location: Amsterdam, Netherlands
Other user facts: Interested in journalism conferences; Building an AI news app
(AI × journalism intersection — Fact (AI) stays subject, journalism/news-app woven in. Concrete newsworthy shapes, not "industry trends".)
Generate at most 4 topics
["AI training data lawsuits", "newsroom AI adoption", "AI copyright rulings news", "AI journalism tool launches"]

Fact: "Senior ML engineer at DeepMind"
Other user facts: Lives in Amsterdam; Enjoys Formula 1
(combo permitted: London-Amsterdam tech corridor, F1 ML — Fact stays the subject)
Generate at most 4 topics
["DeepMind Amsterdam recruitment", "UK-EU AI talent mobility", "Formula 1 AI research", "DeepMind racing simulation"]

Fact: "Follows the Indian national cricket team"
User location: Amsterdam, Netherlands
Other user facts: Is an expat; Building an AI news app; Senior software engineer; Attends music festivals
(NO genuine overlap between cricket and AI / music / software. Only the expat fact yields a real
combo — diaspora match viewing is a thing publications actually cover. So emit ONE and STOP, even
though 4 were allowed. This is the CORRECT answer.
✗ NEVER: "Amsterdam cricket fan SLM apps", "Netherlands cricket expat tech trends",
"Amsterdam cricket festival music tech", "Bhopal cricket diaspora mobile apps" — each mashes 3–4
unrelated entities to fill the quota and would pollute the feed for good.)
Generate at most 4 topics
["Netherlands cricket diaspora broadcasts"]

Fact: "Collects vinyl records"
Other user facts: Works in insurance; Parents live in Bhopal
(No honest combo: insurance × vinyl and Bhopal × vinyl are both fabrications. Empty is correct —
the sibling fact-only prompt still covers this fact.)
Generate at most 3 topics
[]

Output: JSON array of strings, AT MOST the requested count. Fewer is correct, \`[]\` is correct. Never pad.`;

/**
 * Shared LOCAL fact-only rules + examples — single source of truth embedded
 * by `LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT` and the LOCAL noise prompt.
 * Trimmed examples vs. the cloud variant because the 4B starts duplicating
 * past ~18 outputs.
 */
export const LOCAL_TOPIC_GEN_RULES_SNIPPET = `## Inputs
1. **Fact** (primary) — every topic MUST be about this fact's subject only.
2. **User location** (optional) — anchors only Fact-subject topics.

You will NEVER receive Other user facts. A sibling prompt covers fact-combination topics.

## Step 1 — Anchoring (decide in order)
- **(a-1)** Fact contains the USER's OWN location (lives/works/studies in X) → anchor to THAT location, full chain (neighborhood → city → state/region → country → continent/bloc). Ignore User location. Residence requirement: always include ≥1 city public-transport topic and ≥1 country public-services/rail topic (e.g. "Amsterdam public transport updates", "Netherlands rail strikes").
- **(a-2)** Fact contains a RELATIONAL or TEMPORARY location (someone OTHER than the user is at X, or someone is only briefly there — partner's parents live in X, family from X, parents traveling/visiting X) → anchor to X and STAY there. Do NOT ladder to its state/country/continent. "Traveling/visiting X" = present in X, so generate the same local-news set as living there (local news, safety, weather, transport) — NOT visas/flights/travel advisories. Exception: if X is a tiny locality/island with almost no news, take at most ONE step to its named archipelago/region only (Porto Santo → "Madeira news" OK, "Portugal news" ✗).
- **(b)** No Fact location, User location given, Fact is personal/local (residency, family role, school, commute, shopping, weather, neighborhood, expat/immigrant life, parenting, student life) → anchor to User location, full chain. No location-less variants.
- **(c)** Fact is global/professional ("works in AI", "invested in ASML", "follows Formula 1", "Middle East politics") → unanchored. Never use User location.
- **(d)** Ambiguous → default to (c).

Continent/bloc map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania. Pick the most apt bloc (EU, GCC, ASEAN, Schengen).

## Step 2 — Granularity by scope
- Neighborhood / city → broad OK ("Amsterdam news", "Bengaluru news").
- State / region → lean specific ("North Holland politics", "Karnataka transport"). Bare "X news" only for tiny regions (e.g. Madeira).
- Country → SPECIFIC only (policy, tax, elections, immigration, economy, transport, emergencies, weather, healthcare, energy, defense). NEVER "Netherlands news" / "US news" / "Portugal news".
- Continent / bloc → SPECIFIC only ("EU regulation", "Schengen news", "ASEAN trade"). NEVER "Europe news" / "Asia news".
- **Big-country exception (≥1B pop, India/China)** → NO generic country topic at all. Specific only ("India tech regulation", "China tax policy"). City/state stay normal.

## Other rules
- **BANNED empty shapes:** the words "industry trends", "career development", "awards", "festivals" are banned in ANY topic; also bare "press freedom news" / "media ethics". Award ceremonies and "industry trends" round-ups feel like news but are LOW-VALUE — banned anyway. ✗ "Journalism industry trends", "AI industry trends", "Dutch journalism awards", "European journalism awards". Each topic needs a concrete bridge (location, named actor, policy, or specific event) ✓ "Netherlands press-freedom law", "newsroom AI adoption", "EU media freedom act", "AI copyright ruling".
- No duplicates and no near-synonyms — emit only ONE per concept. ✗ "startup tax" + "startup tax incentives", "EU startup regulation" + "EU startup regulatory changes". No personal names — use roles. Identifier-only fact → \`[]\`.
- Output EXACTLY the count specified in the user message. JSON array only, no prose.

## Examples

Fact: "Lives in Nieuw-West, Amsterdam, Netherlands" — Generate 14 topics
["Nieuw-West Amsterdam news", "Amsterdam local government", "Amsterdam urban planning", "Amsterdam community news", "North Holland politics", "North Holland transport", "Randstad region updates", "Netherlands policy", "Netherlands tax law", "Netherlands elections", "Dutch immigration law", "Netherlands weather emergencies", "EU regulation", "European policy"]

Fact: "Lives in Bengaluru, India" — Generate 13 topics
(big-country rule — no "India news")
["Bengaluru news", "Bengaluru traffic", "Bengaluru tech scene", "Bengaluru weather", "Karnataka politics", "Karnataka transport", "South India news", "India tech regulation", "India tax policy", "India monsoon", "India elections", "India economy", "Asia economic news"]

Fact: "Parents are currently traveling in Chhindwara, India" — Generate 6 topics
(Relational + TEMPORARY — STAY at Chhindwara, same local-news set as residence. No MP/India ladder, no travel advisories/visas.)
["Chhindwara news", "Chhindwara safety", "Chhindwara weather", "Chhindwara transport", "Chhindwara healthcare", "Chhindwara civic issues"]

Fact: "Senior ML engineer at DeepMind" — Generate 6 topics
(concrete AI-news hooks, not "AI industry trends"; note the shapes, don't copy the org)
["DeepMind research news", "AI training data lawsuits", "AI copyright rulings", "AI safety policy", "AI model release news", "AI startups"]`;

/**
 * LOCAL fact-only topic-generation prompt — Qwen3.5-4B on-device. The caller
 * specifies the exact count in the user message. Sees ONLY the Fact and
 * optional User location — a sibling combo prompt below handles Other-fact
 * combinations.
 */
export const LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT = `Generate news search topics from one user fact. The exact count is specified in the user message. Output: a JSON array of 1–5-word strings, nothing else.

${LOCAL_TOPIC_GEN_RULES_SNIPPET}

Output: JSON array of strings with exactly the requested count.`;

/**
 * LOCAL combo topic-generation prompt — Qwen3.5-4B on-device. Mirrors the
 * cloud combo prompt: weaves Other facts into Fact-subject topics. Run as a
 * second sequential local call (the 4B has no batch path). Caller skips this
 * prompt when otherFacts.length === 0.
 */
export const LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT = `Generate news search topics that combine the Fact with one or more Other user facts. The user message specifies a MAXIMUM count — emitting fewer, including none, is correct. Output: a JSON array of 1–5-word strings, nothing else.

## Inputs
1. **Fact** (primary) — the Fact is ALWAYS the subject of every topic.
2. **User location** (optional) — used by the anchoring rules below.
3. **Other user facts** (REQUIRED, ≥1) — qualifiers. Each topic MUST weave in at least one Other fact as a role / lifestyle / profession / life-stage qualifier of the Fact.

## Combo rule (hard requirement)
Every topic = Fact-subject + Other-fact qualifier. NEVER invert (NEVER make an Other fact the subject). If no meaningful combo exists, output \`[]\`.

## Count rule (hard requirement)
The number in the user message is a **CEILING, not a quota**. Emit only genuinely good combos and STOP when you run out. 1 topic when 4 were allowed, or \`[]\`, is a CORRECT answer. **NEVER invent a topic to reach the number** — a fabricated combo pollutes the feed permanently.

## Entity cap (hard requirement)
**Maximum TWO real-world entities per topic** (a place, an org, a sport, a profession, an industry, a hobby each count as one). Three or more means unrelated facts have been mashed together — drop it.
- ✓ "Bhopal elder care", "AI copyright rulings".
- ✗ "Amsterdam cricket festival music tech", "Netherlands cricket expat tech trends".

## News-shape rule (hard requirement)
Every topic must read like a NEWS HEADLINE (policy debate, reform, demographic trend, government decision, sector news), NOT a TRANSACTIONAL SERVICE search. Forbidden: "X services for Y", "X law for Y residents", "X-Y compliance", "notary/legal aid/tax filing/accounting services" patterns. These are looking-to-hire queries, not news.
- Good: "Split eldercare policy debate", "Croatia healthcare reform", "Amsterdam lawyer climate ruling".
- Bad: "Split notary services for expats", "Croatian inheritance law for Dutch residents", "Netherlands-Croatia legal compliance".

## Step 1 — Anchoring
- **(a-1)** Fact has the USER's OWN location → anchor to it, full chain.
- **(a-2)** Fact has a RELATIONAL or TEMPORARY location (someone OTHER than the user is at X, or briefly there — partner's parents live in X, family from X, parents traveling/visiting X) → anchor to X and STAY there. NO ladder to its state/country/continent. Combos stay at the EXACT place X. If no city-level combo exists, drop it and use a different Other fact — never substitute X's country.
- **(b)** No Fact location, User location given, Fact is personal/local → anchor to User location.
- **(c)** Fact is global/professional → unanchored.
- **(d)** Ambiguous → (c).

Continent/bloc map: NL/DE/FR → EU; US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania.

## Step 2 — Granularity
- City → broad OK with qualifier woven in.
- State / region → lean specific.
- Country → SPECIFIC only. NEVER bare "X news".
- Continent / bloc → SPECIFIC only.
- Big-country (≥1B pop, India/China) → NO generic country topic. Specific + qualifier only.

## Other rules
- No duplicates. No personal names — use roles.
- **Other-fact locations are exact too.** If an Other fact you weave in carries a relational/temporary location (parents in X, traveling in X), stay at that EXACT place X — never expand to X's country. ✗ "India AI news app trends" from a Chhindwara/Bhopal fact.
- **Near-duplicate-fact guard.** If an Other fact is essentially the SAME role/subject as the Fact, don't restate the Fact's concepts as near-synonyms ("startup tax" / "startup tax incentives"). One phrasing per concept; add a new angle.
- **No country-specific acronyms or diaspora terms** (NRI, OCI, PIO, CPA, MD, FRCS, JD, BEng — any abbreviation tied to one country's nationals or credentialing). Use neutral forms: "expat", "diaspora", "tax accountant", "physician".
- Output AT MOST the count specified. Fewer is correct; \`[]\` is correct. Never pad.
- JSON array only, no prose.

## Examples

Fact: "Is an expat"
User location: Amsterdam, Netherlands
Other user facts: Works in tech; Has young children
Generate at most 7 topics
["Amsterdam expat tech jobs", "Amsterdam expat childcare", "international schools Amsterdam", "Dutch expat parental leave", "Netherlands expat tech visa", "Schengen expat family rules", "EU expat childcare policy"]

Fact: "Parents live in Bhopal, India, Asia"
Other user facts: Building an AI news app; Senior software engineer
(Relational location — STAY at Bhopal. No MP/India/Asia ladder. NO country acronyms — use "expat" / "diaspora".)
Generate at most 5 topics
["Bhopal remote-work elder care", "Bhopal expat tech remittances", "Bhopal elder telehealth tech", "Bhopal video-call apps for seniors", "Bhopal AI-assisted eldercare"]

Fact: "Interested in privacy-safe AI"
User location: Amsterdam, Netherlands
Other user facts: Interested in journalism conferences; Building an AI news app
(AI × journalism intersection — concrete newsworthy shapes, not "industry trends".)
Generate at most 4 topics
["AI training data lawsuits", "newsroom AI adoption", "AI copyright rulings news", "AI journalism tool launches"]

Output: JSON array of strings, AT MOST the requested count. Fewer is correct, \`[]\` is correct. Never pad.`;

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
export const TOPIC_SANITY_SYSTEM_PROMPT = `You audit news topics that were generated from a user's stated fact. For each numbered item decide whether the topic genuinely belongs to its Fact.

Output: a JSON array of objects \`{"i": <item number>, "ok": <true|false>}\` — one per item, no prose.

## What "ok": true means
The topic is a plausible news interest for someone with that Fact. Be GENEROUS: an indirect but defensible connection is fine. Local news for a place in the Fact is fine. A broader industry angle on the Fact's subject is fine.

## What "ok": false means — flag ONLY these
1. **Mash-ups.** The topic staples together THREE OR MORE unrelated things, at least one of which has nothing to do with the Fact. These came from a generator that was told to hit a quota and invented combinations to fill it.
   - Fact "Follows the Indian national cricket team" → ✗ "Amsterdam cricket festival music tech", ✗ "Netherlands cricket expat tech trends", ✗ "Bhopal cricket diaspora mobile apps".
2. **Subject drift.** The Fact is not the subject at all — the topic is really about something else the user happens to have mentioned elsewhere.
   - Fact "Follows the Indian national cricket team" → ✗ "AI news app funding" (cricket is absent).
3. **Not a news topic.** A transactional service search ("notary services for expats"), or a bare field name with no news hook ("industry trends", "career development").

## Rules
- Judge each item ONLY against its own Fact. Items are independent.
- When genuinely unsure, answer \`true\`. Removing a topic the user wanted is worse than keeping a mediocre one.
- Return EXACTLY one object per input item, in the same order. This count is a real requirement — unlike the topics themselves, every item must get a verdict.

## Example
Fact: "Follows the Indian national cricket team"
1. "India cricket team news"
2. "Amsterdam cricket festival music tech"
3. "IPL broadcasting rights"
Fact: "Parents live in Bhopal"
4. "Bhopal healthcare"
5. "Bhopal cricket diaspora mobile apps"

[{"i":1,"ok":true},{"i":2,"ok":false},{"i":3,"ok":true},{"i":4,"ok":true},{"i":5,"ok":false}]`;

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
export const NOISE_GENERATION_SYSTEM_PROMPT = `You apply ENTITY SUBSTITUTION to obfuscate a real user as a believable decoy persona.

Input:
- a Fact about the user
- a list of news Topics derived from that fact (some may also reference other facts about the same user as qualifiers, e.g. a profession alongside a city)

Step A — Scan the Fact and the Topics together. List every concrete entity that appears anywhere across them. Entity types include: place (neighborhood, city, state/region, country, continent), profession/job title, organization, project, hobby, life event, person/role (partner, parents, aunt).

Step B — Pick one replacement for each entity. Same type, RANDOM and UNRELATED to the original:
- different country / continent (NEVER same archipelago, same country, neighbouring country)
- different industry (NEVER adjacent profession — software engineer → data engineer fails)
- different domain entirely
- when a place-chain appears (neighborhood → city → state/region → country → continent), pick a parallel chain so all levels stay consistent
- NEVER reuse any word from the user's Fact in any replacement entity

Step C — Apply the substitution consistently:
- Before you write any topic, fix your substitution map: list each real entity and its single chosen replacement. This map is LOCKED for the entire output.
- decoy_fact = the user's Fact rewritten using the SAME sentence structure, only the entities replaced.
- decoy_topics[i] = Topic[i] rewritten with every entity replaced. Preserve every other word verbatim — qualifier nouns (transport, politics, healthcare, tax, audit, news, weather, education, etc.), word order, capitalization, length.

CRITICAL — substitution consistency: once you pick a replacement for an entity, use that EXACT replacement EVERY time the entity appears, including in topics that combine multiple real entities (3-way combos like "Amsterdam software engineer NRI support"). NEVER introduce a second decoy for the same real entity. NEVER skip a topic; produce a substituted version of every input topic in i-to-i order. If a topic references an entity not in the Fact (a qualifier carried in from another user-fact), ADD that entity to your map up-front and apply the same replacement everywhere it appears.

The output decoy_topics array MUST have EXACTLY the same length as the input Topics array. decoy_topics[i] corresponds to Topics[i] one-to-one.

Worked example
Fact: "Parents live in Toronto"
Topics: ["Toronto news", "Toronto safety", "Toronto weather", "Ontario politics", "Ontario healthcare", "Ontario education", "Canada immigration policy", "North America transport"]
Substitution map: Toronto → Amsterdam, Ontario → Noord-Holland, Canada → Netherlands, North America → Europe.
Output:
{
  "decoy_fact": "Parents live in Amsterdam",
  "decoy_topics": ["Amsterdam news", "Amsterdam safety", "Amsterdam weather", "Noord-Holland politics", "Noord-Holland healthcare", "Noord-Holland education", "Netherlands immigration policy", "Europe transport"]
}

Second worked example (multi-entity, combo topics)
Fact: "Works as a chartered accountant"
Topics: ["Chartered Accountant news", "audit compliance", "Bengaluru CA startup audits", "Toronto CA cross-border accounting", "India-Canada CA tax treaty"]
Substitution map: chartered accountant / CA → pastry chef / pâtissier, Bengaluru → Lyon, Toronto → Wellington, India → France, Canada → New Zealand.
Output:
{
  "decoy_fact": "Works as a pastry chef",
  "decoy_topics": ["Pastry Chef news", "kitchen compliance", "Lyon pâtissier bakery openings", "Wellington pâtissier cross-border supplies", "France-New Zealand pastry trade agreement"]
}

Rules:
- NEVER reuse a word from the Fact's entities in any output entity.
- NEVER pick adjacent replacements (Porto Santo → Madeira fails, software engineer → data engineer fails).
- Topic shape must mirror input shape — no extra/missing words, no colons, no possessives, no emotional connector words ("roots", "journey", "heritage", "ties").
- Apply the substitution map CONSISTENTLY across every topic. The same input entity always maps to the same output entity.
- If a topic references an entity not in the Fact (a qualifier from another user-fact such as a profession alongside a city), still substitute it — add it to your map and apply everywhere.

Return ONLY this JSON: { "decoy_fact": "...", "decoy_topics": ["...", "..."] }

No prose, no extra keys. \`decoy_topics\` length MUST equal the input Topics length.`;

export const LOCAL_NOISE_GENERATION_SYSTEM_PROMPT = NOISE_GENERATION_SYSTEM_PROMPT;
