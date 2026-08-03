// PersonaUpdateAgent — implements IAgent for the persona update chat surface.
// Responsible for system prompt construction, message formatting, and tool execution.
// Conversations are ephemeral (in-memory only, managed by useMeraLLM).

import {
  handleDeleteUserFacts,
  handleIssueWarning,
  handleSaveExtractedFacts,
  handleUpdateUserConfig,
} from '../../chat-tools/tool-handlers';
import { getFacts } from '../../database/services/fact-service';
import { runCalibration } from '../../database/services/calibration-service';
import { getActive as getActiveSuppressions } from '../../database/services/suppression-service';
import { executeProposalActions } from '../../chat-tools/proposal-handlers';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import logger from '../../logger';
import { buildPersonaUpdateStaticPrompt, buildPersonaUpdateContext, buildToolDefinitions } from '../../mera-protocol/prompts';
import { useAppLanguageStore } from '../../stores/app-language-store';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import { SUPPORTED_LANGUAGES } from '../../translation-service';
import {
  buildPersonaContext,
  buildPersonaSystemPrompt,
  decidePersonaProposeChanges,
  formatActiveFiltersList,
  formatKnownFactsList,
  getPersonaToolDefinitions,
  normalizePublicationNameForMatch,
  planPersonaPrompt,
  type PersonaMode,
  type PersonaPromptPlan,
} from '@/lib/news-harness/persona-management/persona-agent-core';
import { estimateTokens } from '../tokens';
import { normalizeToolName } from '@/lib/news-harness/persona-management/tool-names';
import type { ActiveSuppressionView } from '@/lib/news-harness/core/types';
import type {
  IAgent,
  ToolDefinition,
  ToolExecutionResult,
} from '../types';

export class PersonaUpdateAgent implements IAgent {
  readonly id: string;

  constructor(
    private readonly userId: string,
    private readonly surface: 'ONBOARDING' | 'CONFIG',
  ) {
    this.id = `persona-${userId}-${surface}`;
  }

  // --- IAgent: system prompt (static — cacheable by KV cache) ---

  private cachedSystemPrompt: string | null = null;
  private lastNeedsToolFormat: boolean | null = null;
  private lastLanguageName: string | null = null;
  private lastMode: 'CLOUD' | 'LOCAL' | null = null;
  private lastFilterTools: PersonaPromptPlan['filterTools'] | null = null;

  /**
   * This turn's FILTERS budget decision (not-interested P4a). Recomputed by
   * MEASUREMENT in buildSystemPrompt — which both chat hooks call immediately
   * before buildContext (useLocalLLM.ts:267/278, useCloudPersonaChat.ts:372/382)
   * — and read back in buildContext. Defaults to the full feature so an agent
   * whose buildSystemPrompt was never called still behaves.
   */
  private turnPlan: PersonaPromptPlan = { filterTools: 'full', includeFiltersBlock: true };

  async buildSystemPrompt(needsToolFormat: boolean): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';
    const mode: PersonaMode =
      useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice
        ? 'LOCAL'
        : 'CLOUD';

    // Pass our own (test-mockable) buildPersonaUpdateStaticPrompt import explicitly
    // so persona-agent-core calls THIS function reference rather than its own
    // default harness import — keeps the frozen unit-test mock seam intact.
    // Memoized per call so the variant we MEASURE is the string we return —
    // the common case builds exactly one prompt, as before.
    const built = new Map<PersonaPromptPlan['filterTools'], string>();
    const buildAt = (filterTools: PersonaPromptPlan['filterTools']): string => {
      const hit = built.get(filterTools);
      if (hit !== undefined) return hit;
      const prompt = buildPersonaSystemPrompt(
        {
          surface: this.surface,
          includeToolFormat: needsToolFormat,
          languageName,
          mode,
          // ONBOARDING carries no filter tools at all, so leave the pre-P4a
          // call-args shape untouched there.
          ...(this.surface === 'CONFIG' ? { filterTools } : {}),
        },
        buildPersonaUpdateStaticPrompt,
      );
      built.set(filterTools, prompt);
      return prompt;
    };

    this.turnPlan = await this.planTurn({ buildAt });

    // Static prompt depends on surface + needsToolFormat + languageName + mode —
    // all fixed per session — PLUS this turn's filter variant, which is
    // data-dependent and so must be part of the cache key.
    if (
      this.cachedSystemPrompt
      && this.lastNeedsToolFormat === needsToolFormat
      && this.lastLanguageName === languageName
      && this.lastMode === mode
      && this.lastFilterTools === this.turnPlan.filterTools
    ) {
      return this.cachedSystemPrompt;
    }
    this.cachedSystemPrompt = buildAt(this.turnPlan.filterTools);
    this.lastNeedsToolFormat = needsToolFormat;
    this.lastLanguageName = languageName;
    this.lastMode = mode;
    this.lastFilterTools = this.turnPlan.filterTools;
    return this.cachedSystemPrompt;
  }

  /**
   * Chooses how much of the FILTERS feature this turn can afford, by measuring
   * the real candidate prompts against this turn's real data — never by
   * comparing the facts to a hardcoded threshold.
   *
   * ONBOARDING short-circuits: it never carries the filter tools, so every
   * variant renders the same prompt and there is nothing to yield.
   *
   * ── planTurn does NOT measure conversation history, and must not start ──
   *
   * The tempting inference — "widening the chat history window will push turns
   * over this budget and evict the tools" — is FALSE, and was verified false
   * before the history window was widened. planPersonaPrompt's only inputs are
   * the system prompt, the known-facts block, and the filters block (see its
   * signature); wire history is not among them and never reaches it. Widening
   * history therefore cannot move `filterTools` toward `off` and cannot strip
   * tools from the cloud payload.
   *
   * Do not "fix" this by adding history tokens to baseContextTokens. It would
   * couple the two, and the visible effect would be the ladder dropping the
   * user's own FILTERS block partway through a long conversation — a product
   * change, not a safety guard. History is budgeted separately and yields
   * BEFORE this ladder does; see lib/news-harness/persona-management/history-window.ts.
   */
  private async planTurn(params: {
    buildAt: (v: PersonaPromptPlan['filterTools']) => string;
  }): Promise<PersonaPromptPlan> {
    if (this.surface !== 'CONFIG') {
      return { filterTools: 'full', includeFiltersBlock: false };
    }

    const facts = await getFacts();
    const suppressions = await this.loadActiveSuppressions();
    const filtersBlock = formatActiveFiltersList(suppressions);

    return planPersonaPrompt({
      systemTokensFor: (variant) => estimateTokens(params.buildAt(variant)),
      baseContextTokens: estimateTokens(formatKnownFactsList(facts)),
      filtersBlockTokens: filtersBlock ? estimateTokens(filtersBlock) : 0,
    });
  }

  // --- IAgent: dynamic context (injected into user messages each turn) ---

  /** The user's ACTIVE "not interested" filters as the harness's plain view
   *  (not-interested P4a / D6). CONFIG only — onboarding has no feed yet, so it
   *  neither offers the filter tools nor pays the context tokens. Best-effort:
   *  a failure means no filters block and a rejected retire_suppression, never a
   *  broken chat. */
  private async loadActiveSuppressions(): Promise<ActiveSuppressionView[]> {
    if (this.surface !== 'CONFIG') return [];
    try {
      const rows = await getActiveSuppressions();
      return rows.map((s) => ({
        id: s.id,
        pattern: s.pattern,
        kind: s.kind,
        value: s.value,
        strength: s.strength,
      }));
    } catch {
      return [];
    }
  }

  /** source-pref v47 (D5) — the CORROBORATION set for a named-publication
   *  preference: every outlet name that provably exists in the USER'S OWN data
   *  (visit history ∪ the local suggestion cache), normalized exactly the way
   *  `pubPref` matching normalizes. A name the model invented is absent here and
   *  its proposal is dropped, so the Source-preferences screen can never show a
   *  row that looks live and does nothing.
   *
   *  Lazily `require`d, mirroring `persona-mutation-sweeps.runSweep`: a static
   *  import would drag two more WatermelonDB collection singletons into every
   *  consumer of this agent for a set that is only read on a `proposeChanges`
   *  turn. CONFIG only and best-effort, exactly like `loadActiveSuppressions` —
   *  a read failure yields an empty set, which drops every named proposal (the
   *  safe direction). Swallowed rather than logged for the same reason that one
   *  swallows: this is a prompt-input read, not a mutation. */
  private async loadKnownPublicationNames(): Promise<ReadonlySet<string>> {
    const names = new Set<string>();
    if (this.surface !== 'CONFIG') return names;
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const visits =
        require('../../database/services/publication-visit-service') as typeof import('../../database/services/publication-visit-service');
      const suggestions =
        require('../../database/services/article-suggestion-service') as typeof import('../../database/services/article-suggestion-service');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const [visited, suggested] = await Promise.all([
        visits.getTopVisitedPublications(),
        suggestions.getDistinctSuggestionPublicationNames(),
      ]);
      for (const v of visited) {
        const norm = normalizePublicationNameForMatch(v.publicationName ?? '');
        if (norm) names.add(norm);
      }
      // Already normalized by the service, but re-normalizing is idempotent and
      // keeps the two sources provably on one rule.
      for (const s of suggested) {
        const norm = normalizePublicationNameForMatch(s);
        if (norm) names.add(norm);
      }
    } catch {
      // Empty set ⇒ every named proposal drops. Safe direction.
    }
    return names;
  }

  async buildContext(): Promise<string> {
    const facts = await getFacts();
    const suppressions = await this.loadActiveSuppressions();
    // Re-injected every turn so the one-shot LOCAL path can resolve a confirm.
    const proposal = useFloatingChatStore.getState().proposal;

    return buildPersonaContext(
      {
        facts,
        suppressions,
        proposal,
        includeFiltersBlock: this.turnPlan.includeFiltersBlock,
      },
      { buildContext: buildPersonaUpdateContext },
    );
  }

  // --- IAgent: tool definitions (OpenAI JSON Schema for cloud chat) ---

  getToolDefinitions(): ToolDefinition[] {
    // The turn's plan also decides whether the cloud tool payload carries them.
    return getPersonaToolDefinitions(this.surface, buildToolDefinitions, this.turnPlan.filterTools);
  }

  /**
   * Forced-extraction payload: `saveExtractedFacts` and NOTHING ELSE.
   *
   * The forced pass runs with tool_choice:'required', so every tool listed here
   * can be called on a turn the user never asked anything of ("hi", "thanks").
   * `saveExtractedFacts` is the only persona tool that is safe under that
   * pressure: with no facts to extract the model emits an empty array and
   * `handleSaveExtractedFacts` returns { factsSaved: 0 } without touching the
   * database (lib/chat-tools/tool-handlers.ts).
   *
   * Everything else is deliberately excluded. `deleteUserFacts` is destructive;
   * `runCalibration` takes NO arguments, which makes it the cheapest possible
   * way for a model to satisfy 'required' — forcing it would fabricate exactly
   * the confirmation the calibration flow exists to require; and the proposal
   * tools stage or apply changes.
   */
  getForcedExtractionTools(): ToolDefinition[] {
    return this.getToolDefinitions().filter(
      (d) => d.function.name === 'saveExtractedFacts',
    );
  }

  // --- IAgent: tool execution ---

  async executeTool(
    name: string,
    input: unknown,
  ): Promise<ToolExecutionResult> {
    const args = (input as Record<string, unknown>) ?? {};

    // Normalize LLM misspellings against the REAL tool list rather than a
    // single hardcoded typo — casing, separators, and small edit distances all
    // resolve; genuine unknowns still fall to `default:` below.
    const normalizedName =
      normalizeToolName(name, this.getToolDefinitions().map((d) => d.function.name)) ?? name;

    switch (normalizedName) {
      case 'saveExtractedFacts': {
        const result = await handleSaveExtractedFacts(args);
        return { result };
      }

      case 'updateUserConfig': {
        const result = await handleUpdateUserConfig(args);
        return { result };
      }

      case 'deleteUserFacts': {
        const result = await handleDeleteUserFacts(args);
        return { result };
      }

      case 'issueWarning': {
        const result = await handleIssueWarning(args);
        return {
          result,
          sideEffects:
            result.blocked === true
              ? {
                  blocked: {
                    reason: (result.message as string) ?? 'Blocked due to repeated warnings',
                  },
                }
              : undefined,
        };
      }

      // --- not-interested P4a (D6): the SAME staged-proposal path the
      // ArticleFeedbackAgent has, so "Mera, stop showing me celebrity gossip"
      // works in plain chat. Nothing is written until the user confirms.
      case 'proposeChanges': {
        const [activeSuppressions, knownPublicationNames] = await Promise.all([
          this.loadActiveSuppressions(),
          this.loadKnownPublicationNames(),
        ]);
        return decidePersonaProposeChanges(args, activeSuppressions, knownPublicationNames);
      }

      case 'applyProposal': {
        const proposal = useFloatingChatStore.getState().proposal;
        if (!proposal) return { result: { error: 'no pending proposal' } };
        // Same executor as the article surface — one seam, one audit trail.
        const { applied, errors, summaries, changeLogIds } =
          await executeProposalActions(proposal.actions);
        return {
          result: { applied, errors, summaries, changeLogIds },
          sideEffects: { proposalResolved: 'applied' },
        };
      }

      case 'cancelProposal':
        return { result: { cancelled: true }, sideEffects: { proposalResolved: 'cancelled' } };

      case 'runCalibration': {
        // The user was invited to recalibrate scoring (calibration notification)
        // and confirmed in chat. Self-contained — makes ONE gateway round-trip and
        // persists the tuned overrides. Include a human summary so the agent can
        // report the outcome in its reply.
        const outcome = await runCalibration();
        const summary =
          outcome.status === 'applied'
            ? 'Recalibration applied — your scoring has been tuned.'
            : outcome.status === 'no_change'
              ? 'Recalibration ran, but no changes were needed.'
              : 'Recalibration could not be completed right now — please try again later.';
        return { result: { ...outcome, summary } };
      }

      default:
        logger.warn('[PersonaUpdateAgent] Unknown tool', { name });
        return { result: { error: `Unknown tool: ${name}` } };
    }
  }
}
