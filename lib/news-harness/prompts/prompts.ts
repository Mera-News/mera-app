// Mera Protocol — System Prompts
// Static system prompt (cacheable by KV cache) + dynamic context (injected into user messages).

import type { ToolDefinition } from '../core/types';
import { buildExampleQuestionsText } from './questionnaire-data';

/**
 * Builds tool definitions in OpenAI JSON Schema format (sent to cloud backend).
 * Same tools as the XML format in buildToolFormatSection() — single source of truth.
 * When useLegacy is false, advanceQuestionnaireLevel is omitted.
 */
export function buildToolDefinitions(surface: 'ONBOARDING' | 'CONFIG', useLegacy = true): ToolDefinition[] {
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
                  questionnaire_level: { type: 'number', description: 'Level number (1, 2, 3...)' },
                  questionnaire_level_category: { type: 'string', description: 'Category name (e.g. "Core")' },
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

  if (useLegacy) {
    tools.push({
      type: 'function',
      function: {
        name: 'advanceQuestionnaireLevel',
        description: 'Move to next level after all current-level topics are covered or skipped.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    });
  }

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
export function buildToolFormatSection(surface: 'ONBOARDING' | 'CONFIG', useLegacy = true): string {
  const isOnboarding = surface === 'ONBOARDING';

  const tools = buildToolDefinitions(surface, useLegacy);
  const toolLines = tools
    .map((t) => `- ${t.function.name}: ${schemaToCompactSignature(t.function.parameters)}`)
    .join('\n');

  const saveFactsFields = useLegacy
    ? '- statement: English (translate if user wrote in another language); preserve specifics; <200 chars.\n- questionnaire_level / _category / _attribute: copy verbatim from the questionnaire entry the fact answers. If no entry fits, mint a new attribute as "key: description".'
    : '- statement: English (translate if user wrote in another language); preserve specifics; <200 chars.\n- questionnaire_attribute: a short category label for this fact (e.g. "location: residence", "profession: job", "background: origin"). Mint freely.';

  const examples = useLegacy
    ? `<examples>
<example>
<user_input>I live near Brixton in London</user_input>
<assistant_output>${isOnboarding ? "Brixton, nice area! What do you do for work?" : "Got it, updated your location. Anything else?"}
<tool_call>{"name": "saveExtractedFacts", "arguments": {"extracted_user_information": [{"statement": "Lives near Brixton, London, UK", "questionnaire_level": 1, "questionnaire_level_category": "Core", "questionnaire_attribute": "location: neighborhood/area, city, and country (preserve specifics)"}]}}</tool_call></assistant_output>
</example>
<example>
<user_input>I'm a senior ML engineer at DeepMind</user_input>
<assistant_output>${isOnboarding ? "DeepMind, exciting! Tracking any stocks?" : "Got it, updated your profession. Anything else?"}
<tool_call>{"name": "saveExtractedFacts", "arguments": {"extracted_user_information": [{"statement": "Senior ML engineer at DeepMind", "questionnaire_level": 1, "questionnaire_level_category": "Core", "questionnaire_attribute": "profession: job role and industry"}, {"statement": "Works in AI/Machine Learning industry", "questionnaire_level": 2, "questionnaire_level_category": "Professional", "questionnaire_attribute": "sub_industry: specific niche"}]}}</tool_call></assistant_output>
</example>
</examples>`
    : `<examples>
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
  /** When false (default), uses the new example-questions approach where the LLM
   *  autonomously picks questions based on Known Facts. When true, uses the legacy
   *  level-based questionnaire with [ASK]/[DONE] annotations. */
  useLegacy?: boolean;
}): string {
  const { surface, includeToolFormat = true, languageName, mode = 'CLOUD', useLegacy = false } = params;
  const isOnboarding = surface === 'ONBOARDING';

  if (mode === 'LOCAL') {
    return buildPersonaUpdateLocalPrompt({ surface, includeToolFormat, languageName, useLegacy });
  }

  const languageRule = languageName
    ? `- LANGUAGE: User's selected language is **${languageName}** — ALWAYS write conversational text in ${languageName}, with no exceptions. Do NOT switch languages even if the user writes in English, Chinese, or any other language; reply in ${languageName} regardless. Fact statements stay English (see Facts).`
    : `- LANGUAGE: Match the user's language for conversational text. Switch if they switch. Fact statements stay English (see Facts).`;

  const toolSection = includeToolFormat ? buildToolFormatSection(surface, useLegacy) : '';

  const deletingFactsSection = isOnboarding ? '' : `
- DELETE (deleteUserFacts) only when the user explicitly asks to remove info OR is correcting themselves about the SAME subject ("I moved to Berlin, not Paris"; "I work at Stripe now, not Google"). Adding a fact about a DIFFERENT subject is NEVER a correction — "parents live in Bhopal" does not replace "I live in Porto Santo". Match by attribute key (the text before ': ' in Known Facts). If unsure, ask first.
- RECALIBRATE (runCalibration): if the user was invited to recalibrate scoring and explicitly confirms, call runCalibration (no args); never call it unprompted.`;

  const conversationGuide = useLegacy
    ? `## Rules
${languageRule}
- The questionnaire is a **suggestion**, not a script. [ASK] items are prompts to use ONLY when the user has nothing to add on their own. The user's own input always wins.
- **If the user volunteers any new personal info — even when it doesn't match the current [ASK] — extract it FIRST** via saveExtractedFacts, acknowledge briefly, then either ask a follow-up about that info or move on to the next [ASK]. Mint a new attribute as "key: description" when no questionnaire entry fits ("expat from India" → questionnaire_attribute "background: origin / cultural identity"). NEVER repeat the same [ASK] question after the user has told you something new — that ignores their input.
- After all current-level [ASK]s are covered or skipped, call advanceQuestionnaireLevel.
${isOnboarding
        ? '- A welcome message was already shown — start with the first [ASK] question.'
        : '- Respond to user messages directly; for guided questions, target the gaps. After extracting, confirm briefly and ask if there\'s more.'}
- Stay on profile/news topics. Redirect off-topic politely.`
    : `## Rules
${languageRule}
- **Save first, then ask.** If the user volunteers any info, extract it via saveExtractedFacts before asking anything. Acknowledge briefly, then ask one follow-up or the next relevant question.
- **Read Known Facts before asking.** Never ask about a topic that is already present in Known Facts, even partially — if the city is known, don't ask for the city again.
${isOnboarding
        ? '- A welcome message was already shown — jump straight to asking the first unanswered question from the list below.'
        : '- Respond to user messages directly. After extracting, confirm briefly and ask if there\'s more.'}
- Stay on profile/news topics. Redirect off-topic politely.

## Questions to explore
Ask one at a time, only if not already answered in Known Facts. These are guides — follow the user's lead and ask natural follow-ups when their answer opens something new.
${buildExampleQuestionsText()}`;

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
  useLegacy?: boolean;
}): string {
  const { surface, includeToolFormat, languageName, useLegacy = false } = params;
  const isOnboarding = surface === 'ONBOARDING';

  const languageRule = languageName
    ? `ALWAYS reply in **${languageName}**. NEVER switch languages, even if the user writes in English or any other language — reply in ${languageName} regardless. Fact statements stay English.`
    : `Reply in the user's language (switch if they switch). Fact statements stay English.`;

  const toolSection = includeToolFormat ? buildToolFormatSection(surface, useLegacy) : '';

  const deletingLine = isOnboarding ? '' : '\n- deleteUserFacts: only on explicit removal OR same-subject correction ("Berlin, not Paris"; "Stripe now, not Google"). Adding info on a DIFFERENT subject is NEVER a correction. Match by attribute key. If unsure, ask first.\n- runCalibration: only when the user was invited to recalibrate scoring AND explicitly confirms (no args); never unprompted.';

  const rulesSection = useLegacy
    ? `## Rules
- ${languageRule}
- The questionnaire [ASK] items are **suggestions, not a script**. The user's own input always wins. If the user gives any new personal info — even off-topic for the current [ASK] — save it FIRST via saveExtractedFacts, acknowledge briefly, then either follow up on the new info or move to the next [ASK]. NEVER repeat the same [ASK] question after the user has told you something new — that ignores their input.
- If no [ASK] fits the new info, mint a new attribute "key: description" (e.g. "background: origin / cultural identity" for "expat").
- **Off-script example.** Asked "What do you do for work?", user says "I'm an expat" → save \`{"statement": "Expatriate / lives outside country of origin", "questionnaire_attribute": "background: origin / cultural identity"}\`, reply "Got it — where are you originally from, and what do you do for work?". Do NOT re-ask "What do you do for work?".
- After all current-level [ASK]s are covered or skipped, call advanceQuestionnaireLevel.
${isOnboarding
        ? '- A welcome message was already shown — start with the first [ASK] question.'
        : '- Respond directly; for guided questions, target the gaps. After extracting, confirm briefly and ask if there\'s more.'}
- Stay on profile/news topics; redirect off-topic politely.`
    : `## Rules
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
${buildExampleQuestionsText()}`;

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
 * Legacy path includes the questionnaire level + guide with [ASK]/[DONE] markers.
 * New path omits the questionnaire entirely — just Known Facts.
 */
export function buildPersonaUpdateContext(params: {
  knownFactsList: string;
  useLegacy?: boolean;
  // Legacy-only fields:
  questionnaireGuide?: string;
  currentLevel?: number;
  totalLevels?: number;
}): string {
  const { knownFactsList, useLegacy = false, questionnaireGuide, currentLevel, totalLevels } = params;

  if (useLegacy && questionnaireGuide !== undefined && currentLevel !== undefined && totalLevels !== undefined) {
    return `<context>
## Questionnaire: Level ${currentLevel}/${totalLevels}
${questionnaireGuide}

## Known Facts
${knownFactsList}
</context>`;
  }

  return `<context>
## Known Facts
${knownFactsList}
</context>`;
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
const CLOUD_SCORING_BASE_PROMPT = `Score news relevance for one user. Every article lands in exactly one of three product tiers; the score encodes the tier and the strength within it.

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

## Anchors (example user: software engineer in Amsterdam building an AI news app; parents in Bhopal and currently traveling in Chhindwara; partner's family in Porto Santo; Berlin trip next weekend; interests: journalism+AI, privacy-safe AI, on-device small language models, tech/journalism conferences; NO investments)
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

## Priority
City > region > country. Family locations: the named city only. Exact interest area > interest category > generic tech.

## Critical
- Don't override an explicit location in the body with the publication's country.
- Multi-location users count multiply ("from Johannesburg, now in London" = both matter; "parents in New York" = connected).
- Tabloid/clickbait −0.1. Spam → EXCLUDE.`;

/**
 * Pass 1 — Relevance score only.
 * Returns a single number 0.0-1.1. No reason text, minimal output tokens.
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
- **0.25–0.4** — state the topic-only link plainly. "South Africa's draft AI policy matches your AI-industry interest." / "Sweden's tech-sector headwinds are industry-adjacent."
- **≤0.25** — minimal, honest. State the surface topic match and the disconnect in one short clause each. Do NOT use "may influence", "could shape", "via EU-wide trends", "through broader industry trends", or any phrasing that bridges a foreign/unrelated story to the user. Examples: "Bulgaria's digital-ID policy is foreign-domestic; no Dutch tie." "Manchester building fire is a UK-local emergency; you're in Amsterdam."

Never fabricate a connection. The reason must match the article — if the article is about holiday homes, the reason is about holiday homes, not the AI Act. Never echo "[User facts]", "Relevance Score:", "Why this matters to you:", or any markdown (**, ##). Plain sentence only.

Output: single plain string, no prefixes, no markdown.`;

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
- **≤0.25** — minimal, honest. Surface topic match + disconnect, one short clause each. NEVER use "may influence", "could shape", "EU-wide trends", "broader industry trends". "Bulgaria digital-ID is foreign-domestic; no Dutch tie."

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
}): string {
  const { userContext, articles } = params;
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
  return `User Context: ${userContext}\n\n${blocks.join('\n\n')}\n\nReturn a JSON array of ${articles.length} numbers (one per article, in order).`;
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
Output a JSON array of exactly N objects. No prose, no extra fields.
Example (3): [{"j":"ok","r":"Bhopal heatwave alert affects your family's city."},{"j":"adj","s":0.14},{"j":"adj","s":0.3,"r":"Amsterdam restaurant roundup is local lifestyle filler, no real stake."}]`;
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
export const CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT = `Generate news search topics that combine the Fact with one or more Other user facts. The exact count is specified in the user message. Output: JSON array of 1–5-word strings.

## Inputs
1. **Fact** (primary) — the Fact is ALWAYS the subject of every topic you emit.
2. **User location** (optional) — used by the same anchoring rules below.
3. **Other user facts** (REQUIRED, ≥1) — qualifiers. Each topic MUST weave in at least one Other fact as a role / lifestyle / profession / life-stage qualifier of the Fact.

## Combo rule (hard requirement)
Every topic = Fact-subject + at least one Other-fact qualifier. NEVER invert:
- Fact "Parents live in Bhopal" + Other "Works in AI" → ✓ "Bhopal AI elder-care apps", "India remittance rules for tech expats" (Fact-subject preserved); ✗ "AI industry news" (Other-fact as subject).
- Fact "Is an expat" + Other "Works in tech" + Other "Has young children" → ✓ "Amsterdam expat tech jobs", "Dutch expat parental leave"; ✗ "tech industry news", "childcare policy" (no expat anchor).

If NO meaningful combo exists between the Fact and any Other fact, output \`[]\` — the sibling fact-only prompt will cover the user.

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
- Output EXACTLY the count specified in the user message, or \`[]\` if no meaningful combos exist.
- JSON array only, no prose.

## Examples

Fact: "Is an expat"
User location: Amsterdam, Netherlands
Other user facts: Works in tech; Has young children
Generate 8 topics
["Amsterdam expat tech jobs", "Amsterdam expat childcare", "international schools Amsterdam", "Dutch expat parental leave", "Netherlands expat tech visa", "Schengen expat family rules", "EU expat childcare policy", "Randstad international school options"]

Fact: "Parents live in Bhopal, India, Asia"
User location: Amsterdam, Netherlands
Other user facts: Building an AI news app; Senior software engineer; Enjoys Formula 1
(Relational location — combos STAY at Bhopal. No MP/India/Asia ladder. No AI/F1/Amsterdam subjects — those have their own runs. Keep parents-in-Bhopal as subject. NO country-specific acronyms like NRI — use "expat" / "diaspora".)
Generate 6 topics
["Bhopal remote-work elder care", "Bhopal expat tech remittances", "Bhopal elder telehealth tech", "Bhopal video-call apps for seniors", "Bhopal diaspora family services", "Bhopal AI-assisted eldercare"]

Fact: "Interested in privacy-safe AI"
User location: Amsterdam, Netherlands
Other user facts: Interested in journalism conferences; Building an AI news app
(AI × journalism intersection — Fact (AI) stays subject, journalism/news-app woven in. Concrete newsworthy shapes, not "industry trends".)
Generate 4 topics
["AI training data lawsuits", "newsroom AI adoption", "AI copyright rulings news", "AI journalism tool launches"]

Fact: "Senior ML engineer at DeepMind"
Other user facts: Lives in Amsterdam; Enjoys Formula 1
(combo permitted: London-Amsterdam tech corridor, F1 ML — Fact stays the subject)
Generate 4 topics
["DeepMind Amsterdam recruitment", "UK-EU AI talent mobility", "Formula 1 AI research", "DeepMind racing simulation"]

Output: JSON array of strings with exactly the requested count, or \`[]\` if no meaningful combos.`;

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
export const LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT = `Generate news search topics that combine the Fact with one or more Other user facts. The exact count is specified in the user message. Output: a JSON array of 1–5-word strings, nothing else.

## Inputs
1. **Fact** (primary) — the Fact is ALWAYS the subject of every topic.
2. **User location** (optional) — used by the anchoring rules below.
3. **Other user facts** (REQUIRED, ≥1) — qualifiers. Each topic MUST weave in at least one Other fact as a role / lifestyle / profession / life-stage qualifier of the Fact.

## Combo rule (hard requirement)
Every topic = Fact-subject + Other-fact qualifier. NEVER invert (NEVER make an Other fact the subject). If no meaningful combo exists, output \`[]\`.

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
- Output EXACTLY the count specified, or \`[]\` if no meaningful combos.
- JSON array only, no prose.

## Examples

Fact: "Is an expat"
User location: Amsterdam, Netherlands
Other user facts: Works in tech; Has young children
Generate 7 topics
["Amsterdam expat tech jobs", "Amsterdam expat childcare", "international schools Amsterdam", "Dutch expat parental leave", "Netherlands expat tech visa", "Schengen expat family rules", "EU expat childcare policy"]

Fact: "Parents live in Bhopal, India, Asia"
Other user facts: Building an AI news app; Senior software engineer
(Relational location — STAY at Bhopal. No MP/India/Asia ladder. NO country acronyms — use "expat" / "diaspora".)
Generate 5 topics
["Bhopal remote-work elder care", "Bhopal expat tech remittances", "Bhopal elder telehealth tech", "Bhopal video-call apps for seniors", "Bhopal AI-assisted eldercare"]

Fact: "Interested in privacy-safe AI"
User location: Amsterdam, Netherlands
Other user facts: Interested in journalism conferences; Building an AI news app
(AI × journalism intersection — concrete newsworthy shapes, not "industry trends".)
Generate 4 topics
["AI training data lawsuits", "newsroom AI adoption", "AI copyright rulings news", "AI journalism tool launches"]

Output: JSON array of strings with exactly the requested count, or \`[]\`.`;

/**
 * Back-compat alias. New code should import the explicit CLOUD_/LOCAL_ pair
 * and choose by mode at the call site (see topic-generation-service.ts and
 * topic-gen-handler.ts).
 */
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
