// news-harness — persona-agent-core: pure system-prompt / context / tool-
// definition construction for the persona-update chat agent (onboarding +
// persona-config surfaces).
//
// Extracted from lib/llm/agents/PersonaUpdateAgent.ts so the RN class is a
// thin shell over store/DB reads that delegates all prompt-construction
// "brain" work here. RN-free: no lib/database, lib/stores, expo,
// react-native, lib/logger, or lib/config/endpoints imports.
//
// Seam note: the prompt-string builders (buildPersonaUpdateStaticPrompt,
// buildPersonaUpdateContext, buildToolDefinitions) are accepted as INJECTABLE
// parameters, defaulting to this harness's own canonical imports.
// PersonaUpdateAgent.ts passes its own imports from the (test-mockable)
// lib/mera-protocol/prompts shim explicitly, so the frozen
// PersonaUpdateAgent.test.ts — which mocks that shim module and asserts on the
// mock call args — keeps passing unmodified. Same pattern as
// lib/news-harness/persona-management/topic-generation.ts's `systemPrompts`
// injection and lib/mera-protocol/scoring-service.ts's mockable-seam notes.

// Pure JS, no RN/DB coupling — article-pipeline/scoring.ts already carries this
// dependency (and its `en` locale) in the shipped bundle for the inverse
// direction (code → name); here it is used for name → ISO alpha-3.
import countries from 'i18n-iso-countries';
import {
  formatTopicPlanNotesBlock,
  type TopicPlanNote,
} from './topic-plan-notes';
import en from 'i18n-iso-countries/langs/en.json';

import type {
  ActiveSuppressionView,
  Fact,
  ProposalAction,
  StagedProposal,
  ToolDefinition,
  ToolExecutionResult,
} from '../core/types';
import {
  buildPersonaUpdateStaticPrompt,
  buildPersonaUpdateContext,
  buildToolDefinitions,
  type FilterToolsVariant,
} from '../prompts/prompts';

countries.registerLocale(en);

export type PersonaSurface = 'ONBOARDING' | 'CONFIG';
export type PersonaMode = 'CLOUD' | 'LOCAL';

/** Caps facts injected into <context> to stay within the on-device 4096-token
 *  input budget. Mirrors PersonaUpdateAgent's original MAX_FACTS_IN_CONTEXT. */
export const MAX_FACTS_IN_CONTEXT = 22;

/**
 * Caps ACTIVE "not interested" filters injected into <context> (not-interested
 * P4a). MEASURED, not guessed: `persona-agent-core.test.ts` pins the marginal
 * cost of the rendered block at this cap against
 * FILTERS_BLOCK_TOKEN_CEILING, and asserts the whole worst-case prompt
 * (CONFIG + LOCAL + XML tool format + 22 maximum-length facts + this many
 * filters) still fits the ~3072-token on-device input budget. Newest-first, so
 * what this drops is what the user touched longest ago.
 */
export const MAX_FILTERS_IN_CONTEXT = 10;

/**
 * Hard ceiling on what the FILTERS block may ADD to <context>. Enforced by
 * construction (rows stop being emitted once the next one would cross it), so
 * the marginal cost is bounded whatever a pattern's length turns out to be —
 * `MAX_FILTERS_IN_CONTEXT` alone would not bound it.
 */
export const FILTERS_BLOCK_TOKEN_CEILING = 200;

/**
 * Mirror of `INPUT_TOKEN_BUDGET` in lib/llm/useLocalLLM.ts (4096 total − 1024
 * max output). Over it, the local path does NOT degrade — it hard-errors the
 * turn with "Context too long". Mirrored here so the harness stays free of the
 * lib/llm import graph; if that constant moves, move this one.
 */
export const PERSONA_INPUT_TOKEN_BUDGET = 3072;

/**
 * Headroom left for the user's own message, which is appended to <context> on
 * the same prompt (~500 characters of typing). Only affects how eagerly the
 * FILTERS feature yields — it can never make a turn cost more than the pre-P4a
 * prompt, because the last rung of the ladder reproduces that prompt exactly.
 */
export const PERSONA_TURN_RESERVE_TOKENS = 128;

/**
 * Hard cap on USER TURNS carried as chat history (see history-window.ts).
 *
 * Bounds two things at once: per-turn latency/cost, and how far back a stale
 * confirmation can reach. The second is load-bearing — an invitation the user
 * never answered must not still be honourable ten turns later, so an
 * invocation intent expires on exactly this constant.
 *
 * 6 comfortably spans the flow this wave exists to fix (invitation -> question
 * -> "Yes" -> follow-up) with slack, without letting a conversation from ten
 * minutes ago steer the current turn.
 */
export const MAX_HISTORY_USER_TURNS = 6;

/**
 * Chat-history token budget for the CLOUD path.
 *
 * NOT a correctness limit: the cloud path enforces no input budget of its own
 * (cloudChatStream posts what it is given, and both BIG_MODEL and its fallback
 * carry context windows far larger than this). It is a self-imposed
 * latency/cost cap, so the number is a policy choice rather than a measurement.
 *
 * MEASURED 2026-08-03 (estimateTokens over the real builders):
 *
 *   CLOUD system prompt, CONFIG, includeToolFormat=false ... 5,972 ch / ~1,493 tok
 *   CLOUD system prompt, ONBOARDING .......................  4,370 ch / ~1,093 tok
 *   <context>, 22 maximum-length facts ....................  4,623 ch / ~1,156 tok
 *   <context>, one typical fact ...........................     81 ch /    ~21 tok
 *
 * Worst realistic cloud turn is therefore ~1,493 + ~1,156 + 1,500 + 128 reserve
 * = ~4.3k input tokens, a small fraction of the smallest context window in the
 * fallback chain. 1,500 stands.
 *
 * The LOCAL path derives its own budget by subtraction against a hard 3,072
 * ceiling and does NOT use this constant — necessarily, because the same
 * measurement shows a local CONFIG turn (system prompt WITH the XML tool format,
 * ~1,769 tok) plus a full 22-fact <context> (~1,156 tok) already leaves only
 * ~19 tokens. A heavy on-device user gets roughly one turn of history and that
 * is correct: the alternative is the hard "Context too long" error that the
 * subtraction exists to make unreachable.
 */
export const CLOUD_HISTORY_BUDGET_TOKENS = 1500;

/** Headroom reserved for the user's own message when deriving the LOCAL
 *  history budget by subtraction. Mirrors PERSONA_TURN_RESERVE_TOKENS. */
export const HISTORY_RESERVE_TOKENS = 128;

/** Defensive trim on a rendered filter phrase (a pattern is user/LLM text). */
const FILTER_PATTERN_TRUNC = 60;

/** Mirrors lib/llm/tokens.ts::estimateTokens byte-for-byte — inlined so the
 *  harness stays free of the lib/llm import graph (same convention as
 *  article-feedback/agent-core.ts). */
function estimateTokens(text: string): number {
  const cjkPattern = /[一-鿿㐀-䶿豈-﫿]/g;
  const cjkMatches = text.match(cjkPattern);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkCount = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.2) + Math.ceil(nonCjkCount / 4);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export interface PersonaSystemPromptInput {
  surface: PersonaSurface;
  /** When false, omits XML tool format instructions (AI SDK handles tool calling natively). */
  includeToolFormat: boolean;
  /** Human-readable name of the user's app language (e.g. "Hindi", "Spanish"). */
  languageName: string;
  /** Inference path — CLOUD (large MoE) vs LOCAL (on-device). */
  mode: PersonaMode;
  /** not-interested P4a: how much of the FILTERS feature this turn can afford
   *  (planPersonaPrompt). Defaults to `full`. */
  filterTools?: FilterToolsVariant;
  /** item 17 — the user's "Deeper questions" toggle. Swaps the interview's
   *  question bank; the answers are ordinary LOCAL facts. */
  deepMode?: boolean;
  /** item 13 — the user's "Web search in chat" toggle. Adds one CLOUD-only
   *  prose line telling the model the tool exists. */
  webSearch?: boolean;
}

export type BuildStaticPromptFn = typeof buildPersonaUpdateStaticPrompt;

/**
 * Builds the STATIC persona-update system prompt over plain inputs. Mirrors
 * PersonaUpdateAgent.buildSystemPrompt's params-object assembly exactly
 * (session-constant; safe to cache per session).
 */
export function buildPersonaSystemPrompt(
  input: PersonaSystemPromptInput,
  buildStaticPrompt: BuildStaticPromptFn = buildPersonaUpdateStaticPrompt,
): string {
  return buildStaticPrompt({
    surface: input.surface,
    includeToolFormat: input.includeToolFormat,
    languageName: input.languageName,
    mode: input.mode,
    // Spread CONDITIONALLY so a caller that never plans keeps the exact
    // pre-P4a call-args shape the frozen PersonaUpdateAgent seam test observes.
    // The two toggles follow the same rule for the same reason: OFF (the
    // default) must leave the call args byte-identical to what they were before
    // this wave, so an untouched device's prompt is provably unchanged.
    ...(input.filterTools ? { filterTools: input.filterTools } : {}),
    ...(input.deepMode ? { deepMode: true } : {}),
    ...(input.webSearch ? { webSearch: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// Known-facts formatting
// ---------------------------------------------------------------------------

// `questionnaireAttribute` is typed as `string | undefined` on Fact, but the
// WatermelonDB-backed getFacts() has been observed to hand back explicit
// `null` too — accept both so callers don't need to coerce first.
export type ContextFact = Pick<Fact, 'statement'> & {
  questionnaireAttribute?: Fact['questionnaireAttribute'] | null;
};

/**
 * Formats facts into the "- 'attr': statement" bullet list used in <context>,
 * capping to the most-recent MAX_FACTS_IN_CONTEXT entries. Pure — mirrors the
 * inline logic that used to live in PersonaUpdateAgent.buildContext.
 */
export function formatKnownFactsList(facts: ContextFact[]): string {
  const displayFacts =
    facts.length > MAX_FACTS_IN_CONTEXT ? facts.slice(-MAX_FACTS_IN_CONTEXT) : facts;

  if (displayFacts.length === 0) return 'Nothing yet.';

  return displayFacts
    .map((f) => `- '${f.questionnaireAttribute ?? 'other'}': ${f.statement}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// "Not interested" filters — context rendering + staged-proposal decisions
// (not-interested P4a / D6: the same chat-first contract the
// ArticleFeedbackAgent has, so filters are manageable in PLAIN persona chat)
// ---------------------------------------------------------------------------

/** What of the FILTERS feature a single turn can afford. */
export interface PersonaPromptPlan {
  /** How much of the filter tool documentation the system prompt carries. */
  filterTools: FilterToolsVariant;
  /** Whether <context> carries the `## YOUR FILTERS` block. */
  includeFiltersBlock: boolean;
}

/**
 * Rungs in yield order — MOST of the feature first, least last. The order is
 * the product decision: our filter *context block* is the first thing to go
 * (the user can still ask Mera to hide something, they just don't get the list
 * read back), then the tool *documentation* degrades, and only then do the
 * tools themselves disappear. A turn where Mera cannot stage a filter proposal
 * is a far smaller failure than a turn that hard-errors.
 *
 * The LAST rung is load-bearing: `off` + no block reproduces the pre-P4a prompt
 * BYTE-IDENTICALLY, which is what guarantees this wave cannot lock out a user
 * who could hold a persona-chat turn before it.
 */
const PERSONA_PROMPT_LADDER: readonly PersonaPromptPlan[] = [
  { filterTools: 'full', includeFiltersBlock: true },
  { filterTools: 'full', includeFiltersBlock: false },
  { filterTools: 'compact', includeFiltersBlock: false },
  { filterTools: 'off', includeFiltersBlock: false },
];

/**
 * Picks the richest FILTERS variant that actually fits this turn — by
 * MEASURING the candidate prompts, not by comparing the facts against a
 * hardcoded threshold. `systemTokensFor` is a callback so only the rungs we
 * actually reach get built (the common case measures exactly one).
 *
 * Always returns a plan: when nothing fits, the `off` rung is returned anyway,
 * because there is nothing further this feature can yield — at that point the
 * turn costs exactly what it cost before this wave.
 */
export function planPersonaPrompt(params: {
  /** estimateTokens of the system prompt built at that variant. */
  systemTokensFor: (variant: FilterToolsVariant) => number;
  /** estimateTokens of <context> WITHOUT the filters block. */
  baseContextTokens: number;
  /** What the filters block would ADD. 0 when the user has no filters. */
  filtersBlockTokens: number;
  budgetTokens?: number;
  reserveTokens?: number;
}): PersonaPromptPlan {
  const budget =
    (params.budgetTokens ?? PERSONA_INPUT_TOKEN_BUDGET)
    - (params.reserveTokens ?? PERSONA_TURN_RESERVE_TOKENS);

  const systemCache = new Map<FilterToolsVariant, number>();
  const systemTokens = (v: FilterToolsVariant): number => {
    const hit = systemCache.get(v);
    if (hit !== undefined) return hit;
    const measured = params.systemTokensFor(v);
    systemCache.set(v, measured);
    return measured;
  };

  for (const rung of PERSONA_PROMPT_LADDER) {
    // Nothing to show ⇒ the two `full` rungs are the same prompt; skip the
    // block-bearing one so we don't measure it twice.
    if (rung.includeFiltersBlock && params.filtersBlockTokens <= 0) continue;
    const total =
      systemTokens(rung.filterTools)
      + params.baseContextTokens
      + (rung.includeFiltersBlock ? params.filtersBlockTokens : 0);
    if (total <= budget) return rung;
  }
  return PERSONA_PROMPT_LADDER[PERSONA_PROMPT_LADDER.length - 1];
}

function truncFilter(text: string): string {
  const t = (text ?? '').trim();
  return t.length > FILTER_PATTERN_TRUNC ? `${t.slice(0, FILTER_PATTERN_TRUNC - 1)}…` : t;
}

/**
 * Renders the user's ACTIVE filters as `- [id] "phrase"` rows for <context>,
 * capped at MAX_FILTERS_IN_CONTEXT (caller order — newest-first). Returns
 * undefined when there is nothing to show, so a user with no filters pays zero
 * prompt tokens for the feature. Pure.
 *
 * Only `id` + `pattern` (+ the kind, when it isn't the default `keyword`) are
 * exposed: the id is the sole handle retire_suppression takes, and the pattern
 * is what the user recognizes. Strength/keywords/values are deliberately left
 * out — the model has no decision that needs them, and they cost budget.
 */
export function formatActiveFiltersList(
  suppressions: ActiveSuppressionView[] | undefined,
): string | undefined {
  const rows = (suppressions ?? [])
    .filter((s) => s && typeof s.id === 'string' && s.id.length > 0)
    .slice(0, MAX_FILTERS_IN_CONTEXT);
  if (rows.length === 0) return undefined;

  const lines: string[] = [];
  let spent = 0;
  for (const s of rows) {
    const kind = s.kind ?? 'keyword';
    const kindSuffix = kind === 'keyword' ? '' : ` (${kind})`;
    const line = `- [${s.id}] "${truncFilter(s.pattern)}"${kindSuffix}`;
    const cost = estimateTokens(`${line}\n`);
    if (spent + cost > FILTERS_BLOCK_TOKEN_CEILING) break;
    lines.push(line);
    spent += cost;
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** One-line rendering of a staged filter action for the PENDING PROPOSAL block. */
function describeFilterAction(a: ProposalAction): string {
  switch (a.type) {
    case 'add_suppression':
      return `hide "${truncFilter(a.suppressionPattern)}"`;
    case 'retire_suppression':
      return `remove the filter "${truncFilter(a.pattern)}"`;
    default:
      // Unreachable from this surface (decidePersonaProposeChanges only ever
      // stages the two filter actions), but keeps the block honest if the
      // shared store ever hands us a proposal minted elsewhere.
      return a.type;
  }
}

/**
 * Renders the in-flight staged proposal for <context>. Re-injected EVERY turn
 * so the one-shot LOCAL path (no re-inference) can still resolve a confirm —
 * the same reason the article-feedback agent re-injects it.
 */
export function formatPendingProposal(
  proposal: StagedProposal | null | undefined,
): string | undefined {
  if (!proposal || proposal.actions.length === 0) return undefined;
  return `${proposal.explanation}\nActions: ${proposal.actions.map(describeFilterAction).join('; ')}`;
}

/** The one normalization every publication-name comparison in this feature
 *  uses — identical to `publication-preference-service.normalizePublicationName`
 *  and to `getDistinctSuggestionPublicationNames`, because a preference row
 *  only ever fires on exact normalized-name equality. */
export function normalizePublicationNameForMatch(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Resolves an English COUNTRY NAME to the render-time scope token (ISO
 * alpha-3) plus its canonical display label. `null` when the name is not a
 * country — the caller must then DROP the action rather than mint a
 * `scope_value` nothing will ever match (D5: the country vocabulary is closed,
 * so an unresolvable name is always a hallucination).
 *
 * Exported because the resume path (`deriveThreadItems`) has to reconstruct
 * the SAME action from the persisted raw tool args, and re-deriving the
 * mapping there would be the classic two-copies-one-rule drift.
 */
export function resolveCountryScope(
  countryName: string,
): { scopeValue: string; label: string } | null {
  const name = (countryName ?? '').trim();
  if (!name) return null;
  const alpha3 = countries.getAlpha3Code(name, 'en');
  if (!alpha3) return null;
  return {
    scopeValue: alpha3,
    // Canonical English name for the resolved code, so the row reads "India"
    // on the Source-preferences screen however the user typed it.
    label: countries.getName(alpha3, 'en', { select: 'alias' }) || name,
  };
}

/** The pref kinds a NAMED publication accepts. */
const PUBLICATION_PREFS = ['boost', 'deprioritize', 'mute'] as const;
/** The pref kinds a SOURCE SCOPE accepts — no `mute`, see the ProposalAction
 *  doc comment in core/types.ts (nothing implements a scope exclusion). */
const SCOPE_PREFS = ['boost', 'deprioritize'] as const;

/**
 * Pure propose/confirm decision for the PERSONA chat's `proposeChanges` tool.
 *
 * Deliberately NARROWER than the article agent's: the two filter actions plus
 * the two source-preference actions, and `add_suppression` is KEYWORD-ONLY.
 * This surface has no article in front of it, so there is no field to copy a
 * structured value from and nothing to validate one against — a structured
 * filter minted here could silently never fire (D9). Structured filters are
 * the article-feedback agent's job.
 *
 * `retire_suppression` resolves its id against the filters the agent was
 * actually shown, and stages the pattern from THAT row rather than from the
 * model, so a confirm card can't be made to misdescribe what it removes. No
 * filters in context ⇒ rejected outright.
 *
 * source-pref v47 (D5) — the two source actions get the same treatment for the
 * same reason, one tier apart:
 *
 * - `set_source_scope_pref` is a CLOSED vocabulary. The model emits an English
 *   country name; it is resolved here to an ISO alpha-3 token via
 *   `getAlpha3Code`. Unresolvable ⇒ the action is DROPPED. No corroboration is
 *   needed: every alpha-3 is a real render-time predicate.
 * - `set_publication_pref` is an OPEN vocabulary and `pubPref` matching is
 *   exact normalized-name equality, so an invented "Times of India Group"
 *   would mint a row that appears on the Source-preferences screen and can
 *   NEVER fire. It is therefore corroborated against names in the user's own
 *   data (`knownPublicationNames`) and DROPPED when absent. There is no
 *   keyword fallback for a preference the way there is for a filter, so a
 *   downgrade is not an option — dropping is.
 *
 * `knownPublicationNames` is INJECTED rather than read: this module is
 * contractually RN/DB-free and this function is pure (same seam as
 * `activeSuppressions`). It is optional so pre-source-pref call sites keep
 * compiling; an absent/empty set corroborates nothing, so every named
 * proposal drops — the safe direction.
 */
export function decidePersonaProposeChanges(
  args: Record<string, unknown>,
  activeSuppressions: ActiveSuppressionView[] | undefined,
  knownPublicationNames: ReadonlySet<string> = new Set<string>(),
): ToolExecutionResult {
  const explanation = typeof args.explanation === 'string' ? args.explanation.trim() : '';
  const expectedEffects = typeof args.expected_effects === 'string' ? args.expected_effects.trim() : '';
  const rawActions = args.actions;

  if (!explanation) return { result: { error: 'explanation is required' } };
  if (!expectedEffects) return { result: { error: 'expected_effects is required' } };
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return { result: { error: 'actions must be a non-empty array' } };
  }

  const byId = new Map<string, ActiveSuppressionView>(
    (activeSuppressions ?? [])
      .filter((s) => s && typeof s.id === 'string' && s.id.length > 0)
      .map((s) => [s.id, s]),
  );

  const actions: ProposalAction[] = [];
  for (const raw of rawActions) {
    if (raw == null || typeof raw !== 'object') {
      return { result: { error: 'action must be an object' } };
    }
    const o = raw as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : '';

    if (type === 'add_suppression') {
      const pattern = typeof o.suppressionPattern === 'string' ? o.suppressionPattern.trim() : '';
      if (pattern.length === 0) {
        return { result: { error: 'add_suppression requires a non-empty suppressionPattern' } };
      }
      const action: ProposalAction = { type: 'add_suppression', suppressionPattern: pattern };
      if (typeof o.suppressionStrength === 'number' && Number.isFinite(o.suppressionStrength)) {
        action.suppressionStrength = o.suppressionStrength;
      }
      // suppressionKind / suppressionValue are intentionally DROPPED here even
      // if the model sends them — see the doc comment above.
      actions.push(action);
      continue;
    }

    if (type === 'retire_suppression') {
      const suppressionId = typeof o.suppressionId === 'string' ? o.suppressionId.trim() : '';
      if (suppressionId.length === 0) {
        return { result: { error: 'retire_suppression requires a non-empty suppressionId' } };
      }
      const row = byId.get(suppressionId);
      if (!row) {
        return { result: { error: `retire_suppression references unknown suppressionId: ${suppressionId}` } };
      }
      actions.push({ type: 'retire_suppression', suppressionId: row.id, pattern: row.pattern });
      continue;
    }

    if (type === 'set_publication_pref') {
      const name = typeof o.publicationId === 'string' ? o.publicationId.trim() : '';
      if (name.length === 0) {
        return { result: { error: 'set_publication_pref requires a non-empty publicationId' } };
      }
      const pref = typeof o.publicationPref === 'string' ? o.publicationPref.trim() : '';
      if (!(PUBLICATION_PREFS as readonly string[]).includes(pref)) {
        return {
          result: { error: `set_publication_pref requires publicationPref ∈ ${PUBLICATION_PREFS.join('|')}` },
        };
      }
      // D5 corroboration. Silent DROP, not an error: an invented outlet is a
      // hallucination the model cannot fix by retrying, and erroring would
      // stall a turn whose other actions are fine.
      if (!knownPublicationNames.has(normalizePublicationNameForMatch(name))) continue;
      actions.push({
        type: 'set_publication_pref',
        publicationId: name,
        publicationPref: pref as 'boost' | 'deprioritize' | 'mute',
      });
      continue;
    }

    if (type === 'set_source_scope_pref') {
      const countryName = typeof o.scopeCountry === 'string' ? o.scopeCountry.trim() : '';
      if (countryName.length === 0) {
        return { result: { error: 'set_source_scope_pref requires a non-empty scopeCountry' } };
      }
      const pref = typeof o.publicationPref === 'string' ? o.publicationPref.trim() : '';
      if (!(SCOPE_PREFS as readonly string[]).includes(pref)) {
        // `mute` lands here deliberately — an ERROR rather than a silent drop,
        // because unlike a hallucinated outlet this IS correctable: the model
        // can restage the same intent as `deprioritize`.
        return {
          result: { error: `set_source_scope_pref requires publicationPref ∈ ${SCOPE_PREFS.join('|')} (a country cannot be muted)` },
        };
      }
      // Closed vocabulary: the ONLY thing that makes a scope row live is a
      // resolvable alpha-3. Unresolvable ⇒ drop, never mint a dead row.
      const resolved = resolveCountryScope(countryName);
      if (!resolved) continue;
      actions.push({
        type: 'set_source_scope_pref',
        scopeKind: 'country',
        scopeValue: resolved.scopeValue,
        label: resolved.label,
        publicationPref: pref as 'boost' | 'deprioritize',
      });
      continue;
    }

    return { result: { error: `invalid action type: ${type || String(o.type)}` } };
  }

  // Every action was dropped (D5). Staging here would render an EMPTY confirm
  // card — the same malformed-proposal case deriveThreadItems guards on the
  // resume path.
  if (actions.length === 0) {
    return { result: { error: 'no applicable actions — nothing was staged' } };
  }

  const proposal: StagedProposal = {
    id: `proposal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    explanation,
    expectedEffects,
    actions,
  };

  return {
    result: { staged: true, actionCount: actions.length, proposalId: proposal.id },
    sideEffects: { proposal },
  };
}

// ---------------------------------------------------------------------------
// Dynamic <context> block
// ---------------------------------------------------------------------------

export interface PersonaContextInput {
  facts: ContextFact[];
  /** not-interested P4a: the user's ACTIVE filters, newest-first. Capped at
   *  MAX_FILTERS_IN_CONTEXT. Absent/empty ⇒ no block and no prompt cost. */
  suppressions?: ActiveSuppressionView[];
  /** not-interested P4a: the single in-flight staged proposal, or null. */
  proposal?: StagedProposal | null;
  /** not-interested P4a: whether this turn can AFFORD the `## YOUR FILTERS`
   *  block — decided by measurement in planPersonaPrompt, never by a threshold
   *  hardcoded in here. Defaults to true (a caller with no plan renders it). */
  includeFiltersBlock?: boolean;
  /** What the user did with topic-plan cards this session. Absent/empty ⇒ no
   *  block and no prompt cost — see formatTopicPlanNotesBlock. */
  topicPlanNotes?: TopicPlanNote[];
}

export type BuildContextFn = typeof buildPersonaUpdateContext;

export interface PersonaContextDeps {
  buildContext?: BuildContextFn;
}

/**
 * Builds the DYNAMIC <context> block injected into user messages. Mirrors
 * PersonaUpdateAgent.buildContext exactly: caps + formats the known-facts list.
 *
 * `deps` lets the caller inject its own (test-mockable) prompt builder —
 * defaults to this harness's own canonical implementation.
 */
export function buildPersonaContext(
  input: PersonaContextInput,
  deps: PersonaContextDeps = {},
): string {
  const buildContextFn = deps.buildContext ?? buildPersonaUpdateContext;

  const knownFactsList = formatKnownFactsList(input.facts);

  // The pre-P4a call args, built first so the FILTERS block can be sized
  // against what the rest of <context> already costs.
  const base = { knownFactsList };

  // A pending proposal is NEVER dropped — without it the one-shot LOCAL path
  // cannot resolve a confirm at all, and it is a handful of tokens.
  const pendingProposal = formatPendingProposal(input.proposal);
  // Returns undefined when the user has answered no cards, which is what keeps
  // the call args below byte-identical for everyone else.
  const topicPlanNotesList = formatTopicPlanNotesBlock(input.topicPlanNotes);
  // The FILTERS block is the FIRST thing this feature yields when a turn can't
  // afford it (see PERSONA_PROMPT_LADDER); the caller's plan decides.
  const filtersList =
    input.includeFiltersBlock === false ? undefined : formatActiveFiltersList(input.suppressions);

  // Spread CONDITIONALLY: with no filters and no pending proposal the call args
  // stay byte-identical to the pre-P4a shape, so the exact-match seam tests
  // keep asserting the same object.
  return buildContextFn({
    ...base,
    ...(filtersList ? { filtersList } : {}),
    ...(topicPlanNotesList ? { topicPlanNotesList } : {}),
    ...(pendingProposal ? { pendingProposal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export type BuildToolDefinitionsFn = typeof buildToolDefinitions;

/** The three tools the not-interested P4a filter path adds (D6). Stripped
 *  together when a turn can't afford them — see FilterToolsVariant. */
const FILTER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'proposeChanges',
  'applyProposal',
  'cancelProposal',
]);

// ---------------------------------------------------------------------------
// explainMera — the KNOWLEDGE tool (CLOUD only)
// ---------------------------------------------------------------------------

/**
 * The section ids `explainMera` can return.
 *
 * Declared HERE, next to the tool definition, because they are part of the
 * tool's contract: the model reads them out of the tool description and the
 * handler validates against them. The prose itself lives in
 * `lib/chat-tools/mera-explainer-content.ts`, which types its record as
 * `Record<MeraExplainerTopicId, string>` — so a section added there without an
 * id here (or an id here with no section) is a compile error, and this file
 * still costs nothing at startup beyond the string array.
 */
export const MERA_EXPLAINER_TOPIC_IDS = [
  'what_is_mera',
  'privacy_what_leaves_device',
  'privacy_what_we_store',
  'encryption_and_inference',
  'how_news_works',
  'source_available',
  'plans_and_limits',
  'known_gaps',
] as const;

export type MeraExplainerTopicId = (typeof MERA_EXPLAINER_TOPIC_IDS)[number];

/**
 * Tools that return REFERENCE TEXT for the model to answer from, and change
 * nothing.
 *
 * Two turn-loop rules in useCloudPersonaChat key off this set, and both exist
 * because a knowledge tool is the first persona tool whose RESULT is the point:
 *
 *  1. A turn that called one must run the continuation pass even though it
 *     produced text, or the tool result is pushed to the wire and never read —
 *     the model would answer from memory, which is the exact failure the tool
 *     exists to prevent.
 *  2. Calling one is NOT extraction. Left uncounted, a bare `explainMera` call
 *     would flip `extractedSomething` true and silently disable the
 *     forced-extraction safety net for that turn.
 *
 * `searchNews` and `webSearch` join it for exactly the same reason: both are
 * READS whose RESULT is the point. Left out of this set, a turn whose only tool
 * call was a search would (1) skip the continuation pass, so the headlines the
 * model asked for are pushed to the wire and never read — it then answers from
 * memory, which for a news search means inventing articles — and (2) flip
 * `extractedSomething` true, disabling the forced-extraction net for a turn
 * where the user may well have stated a fact while asking their question.
 *
 * useCloudPersonaChat reads this set dynamically (`KNOWLEDGE_TOOL_NAMES.has`),
 * so adding a name here is the whole wiring.
 */
export const KNOWLEDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'explainMera',
  'searchNews',
  'webSearch',
]);

/**
 * CLOUD ONLY, and that is structural rather than a preference.
 *
 * The LOCAL path (lib/llm/useLocalLLM.ts) executes tool calls but never pushes a
 * `role:'tool'` message back to the model — the local turn is one-shot. A
 * knowledge tool the model calls but whose answer it can never read is strictly
 * worse than no tool at all: it spends output tokens and returns nothing.
 *
 * Appended at THIS seam rather than inside `buildToolDefinitions` for a second
 * reason: `buildToolFormatSection` derives the LOCAL XML tool block straight
 * from that builder, and the LOCAL path has a hard 3072-token input budget that
 * errors the turn when exceeded. Adding the tool here means the LOCAL prompt
 * gains exactly zero bytes, by construction.
 */
const EXPLAIN_MERA_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'explainMera',
    description:
      'Answer a user question about Mera itself — privacy, what data leaves the device, encryption, how news is found, the licence, plans, or known limitations. Returns Mera\'s own reference documentation. ALWAYS call this before answering such a question; never answer from memory.',
    parameters: {
      type: 'object',
      properties: {
        topics: {
          type: 'array',
          description: `1-3 of: ${MERA_EXPLAINER_TOPIC_IDS.join(', ')}`,
          items: { type: 'string' },
        },
      },
      required: ['topics'],
    },
  },
};

/**
 * `searchNews` — Mera's OWN article index (item 12b). CLOUD only, appended at
 * this seam for both of EXPLAIN_MERA_TOOL's reasons: the LOCAL turn is one-shot
 * (a search whose results the model can never read is strictly worse than no
 * search) and the LOCAL XML prompt derived from `buildToolDefinitions` has a
 * hard 3072-token budget that ERRORS the turn when exceeded. Appending here
 * means the LOCAL prompt gains exactly zero bytes, by construction.
 *
 * The description tells the model what it will NOT get back — no body text, no
 * link — because the failure mode of a headline-only search tool is a model
 * that narrates an article it never read.
 */
const SEARCH_NEWS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'searchNews',
    description:
      'Search Mera\'s own news index (last 48 hours) for real articles about a subject. Use it when the user asks what is happening with something, or to ground a claim about current events. Returns HEADLINES ONLY — no article text and no link — so summarise the headlines and never invent details.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, in English.' },
      },
      required: ['query'],
    },
  },
};

/**
 * `webSearch` — the OPTIONAL, off-by-default web search (item 13).
 *
 * Declared only when the user's "Web search in chat" toggle is on. That gate is
 * on the DECLARATION, not merely the handler, and the distinction is the whole
 * point: a handler-only check would leave an off-by-default tool sitting in the
 * prompt on every turn, paying tokens for a feature the user declined. The
 * handler re-checks the toggle anyway (a persisted conversation can replay a
 * call made while it was on) — both gates are load-bearing.
 *
 * CLOUD only, for EXPLAIN_MERA_TOOL's reasons.
 */
const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'webSearch',
    description:
      'Search the public web when the answer is not in Mera\'s news index and you would otherwise be guessing. Only the search words are sent — never the user\'s facts or feed. Prefer searchNews for anything about current events.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Up to 4 search queries, 2-200 characters each. Put EVERYTHING you need to look up in this ONE call: they are searched at the same time. Never search one thing, read the result, and then search the next.',
        },
      },
      required: ['queries'],
    },
  },
};

/** Tool definitions for the persona-update agent (OpenAI JSON Schema, cloud).
 *
 *  `filterTools` is applied by FILTERING the builder's output rather than by
 *  passing a second argument to `buildDefs` — that keeps the injected-seam call
 *  exactly `buildDefs(surface)`, which the frozen PersonaUpdateAgent.test.ts
 *  asserts on with an exact-arity toHaveBeenCalledWith.
 *
 *  `mode` is applied the same way, and for the same reason: `explainMera` is
 *  APPENDED to the builder's output rather than built by it. Defaults to
 *  'CLOUD' — the one production caller passes it explicitly, and tests that
 *  predate the parameter keep observing the cloud payload.
 *
 *  `webSearchEnabled` defaults to FALSE, and that default is the privacy
 *  guarantee in code: every caller that does not deliberately pass the user's
 *  toggle gets a payload with no web-search tool in it. The value is read
 *  non-reactively (`useMeraProtocolStore.getState()`) at turn-build time by
 *  PersonaUpdateAgent.getToolDefinitions — the store deliberately does NOT
 *  reach into this file, which is RN-free harness code. */
export function getPersonaToolDefinitions(
  surface: PersonaSurface,
  buildDefs: BuildToolDefinitionsFn = buildToolDefinitions,
  filterTools: FilterToolsVariant = 'full',
  mode: PersonaMode = 'CLOUD',
  webSearchEnabled: boolean = false,
): ToolDefinition[] {
  const built = buildDefs(surface).map(withStagedCalibrationDescription);
  // Both surfaces: "how do you handle my data?" gets asked in settings chat too.
  // searchNews rides along on both surfaces too — an onboarding user asking
  // "what's happening with X" should get real headlines, not a redirect.
  const defs =
    mode === 'CLOUD'
      ? [
          ...built,
          EXPLAIN_MERA_TOOL,
          SEARCH_NEWS_TOOL,
          ...(webSearchEnabled ? [WEB_SEARCH_TOOL] : []),
        ]
      : built;
  if (filterTools !== 'off') return defs;
  return defs.filter((d) => !FILTER_TOOL_NAMES.has(d.function.name));
}

/**
 * Restates `runCalibration` as a PROPOSE tool.
 *
 * The canonical definition still describes it as "Run the scoring
 * recalibration…", which was true when the tool executed on the spot. It now
 * stages a confirmation card that only a user tap can apply, and the
 * description is what the model actually reads — so it is corrected here rather
 * than left to imply the model's call is what performs the change.
 *
 * Rewritten at this seam (not in the shared prompt builder) because the builder
 * is shared with another workstream; the behaviour lives entirely on the
 * persona surface, so the override belongs to the persona surface.
 */
function withStagedCalibrationDescription(def: ToolDefinition): ToolDefinition {
  if (def.function.name !== 'runCalibration') return def;
  return {
    ...def,
    function: {
      ...def.function,
      description:
        'Offer to re-tune relevance scoring. This STAGES a confirmation card for the user to tap — it does NOT recalibrate. Call it when the user asks about recalibrating or accepts the invitation; then tell them the card is ready. Never claim the recalibration has happened.',
    },
  };
}
