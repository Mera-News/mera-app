// ArticleFeedbackAgent — implements IAgent for the article-suggestion feedback
// chat surface. Explains WHY an article was suggested and handles "more/less of
// this" feedback by STAGING persona changes as a proposal the user confirms.
//
// It never mutates the persona directly: proposeChanges stages a StagedProposal
// (returned via sideEffects.proposal), and applyProposal / cancelProposal
// resolve the single in-flight proposal held on the floating-chat store. This
// keeps the confirm flow working on the one-shot local path (no re-inference) —
// the PENDING PROPOSAL block is re-injected into <context> every turn.
//
// This is the thin RN adapter: it reads facts / suggestion context / stores and
// delegates all prompt, context, tool-definition, and propose-decision
// construction to the RN-free brain in
// lib/news-harness/article-feedback/agent-core.ts.

import { getFacts } from '../../database/services/fact-service';
import { getSuggestionFeedbackContext } from '../../database/services/article-suggestion-service';
import { markFeedbackProcessedFor } from '../../database/services/article-feedback-service';
import { getActive as getActiveSuppressions } from '../../database/services/suppression-service';
import { ArticleService } from '../../article-service';
import { executeProposalActions } from '../../chat-tools/proposal-handlers';
import { ArticleSuggestionStatus } from '../../database/article-suggestion-status';
import logger from '../../logger';
import { useAppLanguageStore } from '../../stores/app-language-store';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import { SUPPORTED_LANGUAGES } from '../../translation-service';
import { isSubjectTracked } from '../../tracking/track-actions';
import { handleWebSearch } from '../../chat-tools/web-search-handler';
import {
  buildArticleFeedbackSystemPrompt,
  buildFeedbackContext,
  decideProposeChanges,
  decideProposeTrack,
  getArticleFeedbackToolDefinitions,
} from '../../news-harness/article-feedback/agent-core';
import {
  decideProposeFactCheck,
  makeFactCheckSubject,
} from '../../news-harness/fact-check';
import {
  chooseOneRefusal,
  proposalRequiresUserChoice,
  userTapOnlyRefusal,
} from '../../news-harness/core/proposals';
import i18n from '../../i18n';
import type {
  ActiveSuppressionView,
  FactCheckSubject,
  SuggestionFeedbackContext,
  TrackFeedbackSubject,
} from '../../news-harness/core/types';
import type { FeedbackSubject } from '../../../components/custom/cards/feedback-subject';
import type { IAgent, ToolDefinition, ToolExecutionResult } from '../types';

export class ArticleFeedbackAgent implements IAgent {
  readonly id: string;

  constructor(
    private readonly userId: string,
    private readonly target: { articleId?: string; suggestionId?: string },
    /** Origin snapshot for the "follow this story" (proposeTrack) tool. Present
     *  only when the chat was opened from a Track tap; absent for a plain
     *  thumbs-down feedback chat (then the tool falls back to a minimal subject
     *  built from the target + article title, or refuses if it can't). */
    private readonly trackSubject?: TrackFeedbackSubject | null,
  ) {
    this.id = `article-feedback-${target.suggestionId ?? target.articleId}`;
  }

  /** Related-coverage fetch, memoized for the agent instance (buildContext runs
   *  every turn). Only fetched when a track subject was passed explicitly (the
   *  follow-a-story flow) so plain thumbs-down chats make no extra network call.
   *  Failure → []. */
  private relatedCoveragePromise: Promise<string[]> | null = null;

  private getRelatedCoverage(): Promise<string[]> {
    if (this.relatedCoveragePromise) return this.relatedCoveragePromise;
    // Gate on the EXPLICIT trackSubject (not resolveTrackSubject's minimal
    // fallback) — sibling titles only ground the multi-option track proposal.
    const articleId = this.trackSubject?.articleId;
    if (!articleId) {
      this.relatedCoveragePromise = Promise.resolve([]);
      return this.relatedCoveragePromise;
    }
    const ownTitle = this.trackSubject?.title;
    this.relatedCoveragePromise = (async () => {
      try {
        const cluster = await ArticleService.getNewsClusterForArticle(articleId);
        const rows = cluster?.articles?.articles ?? [];
        const titles: string[] = [];
        for (const a of rows) {
          const title = a?.title_en_internal_only ?? a?.title ?? null;
          if (typeof title !== 'string') continue;
          const trimmed = title.trim();
          if (!trimmed || trimmed === ownTitle) continue;
          titles.push(trimmed);
          if (titles.length >= 5) break;
        }
        return titles;
      } catch {
        return [];
      }
    })();
    return this.relatedCoveragePromise;
  }

  /** The user's ACTIVE "not interested" filters, as the RN-free plain view the
   *  harness renders into <context> and validates `retire_suppression` against.
   *  Read fresh on every turn AND on every proposeChanges (the user may have
   *  just added one). Best-effort: a failure means no filters block and a
   *  rejected retire_suppression, never a broken chat. */
  private async loadActiveSuppressions(): Promise<ActiveSuppressionView[]> {
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

  /** The joined suggestion row mapped into the harness's enum-free plain shape.
   *  Shared by buildContext (renders it) and proposeChanges (corroborates a
   *  structured suppression value against it). */
  private async loadArticleContext(): Promise<SuggestionFeedbackContext | null> {
    const ctx = await getSuggestionFeedbackContext(this.target);
    if (!ctx) return null;
    return {
      suggestion: {
        title_en: ctx.suggestion.title_en,
        title_original: ctx.suggestion.title_original,
        publication_name: ctx.suggestion.publication_name,
        description_en: ctx.suggestion.description_en,
        isScored: ctx.suggestion.status === ArticleSuggestionStatus.Complete,
        relevance: ctx.suggestion.relevance,
        reason: ctx.suggestion.reason,
      },
      matchedTopicTexts: ctx.matchedTopicTexts,
      linkedFacts: ctx.linkedFacts,
      entities: ctx.entities,
      category: ctx.category,
    };
  }

  /**
   * The article snapshot `proposeFactCheck` stages against.
   *
   * Read from the SUGGESTION ROW rather than from the chat context, because the
   * chat may have been opened with a suggestionId alone and both halves of the
   * card need a real `articleId`: the quick path has nothing to do without one,
   * and the async path's whole payload IS the article id. A null return refuses
   * the tool rather than staging pills against an empty id.
   */
  private async resolveFactCheckSubject(): Promise<FactCheckSubject | null> {
    const ctx = await getSuggestionFeedbackContext(this.target).catch(() => null);
    const storeContext = useFloatingChatStore.getState().context;
    const storeTitle =
      storeContext.kind === 'article-suggestion' ? storeContext.articleTitle : undefined;
    const articleId = ctx?.suggestion.articleId ?? this.target.articleId ?? '';
    if (!articleId) return null;
    const title =
      ctx?.suggestion.title_en ?? ctx?.suggestion.title_original ?? storeTitle ?? '';
    return makeFactCheckSubject({
      articleId,
      title,
      description: ctx?.suggestion.description_en ?? null,
      url: ctx?.suggestion.article_url ?? null,
      publicationName: ctx?.suggestion.publication_name ?? null,
    });
  }

  /** Resolve the subject the follow tool tracks against: the explicit
   *  trackSubject, else a minimal one built from the target + store title. */
  private resolveTrackSubject(): TrackFeedbackSubject | null {
    if (this.trackSubject) return this.trackSubject;
    const articleId = this.target.articleId;
    if (!articleId) return null;
    const storeContext = useFloatingChatStore.getState().context;
    const title =
      storeContext.kind === 'article-suggestion' ? storeContext.articleTitle : undefined;
    return { origin: 'suggestion', surface: 'detail', articleId, title: title ?? '' };
  }

  // --- IAgent: system prompt (static — cacheable by KV cache) ---

  private cachedSystemPrompt: string | null = null;
  private lastNeedsToolFormat: boolean | null = null;
  private lastLanguageName: string | null = null;
  private lastMode: 'CLOUD' | 'LOCAL' | null = null;
  private lastWebSearch: boolean | null = null;

  async buildSystemPrompt(needsToolFormat: boolean): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';
    // Read ONCE, non-reactively, at turn-build time (same seam as
    // PersonaUpdateAgent.buildSystemPrompt) so the prompt and the tool payload
    // this turn agree with each other.
    const protocol = useMeraProtocolStore.getState();
    const mode: 'CLOUD' | 'LOCAL' =
      protocol.processingMode === ProcessingMode.OnDevice ? 'LOCAL' : 'CLOUD';
    // Gates the SAME prose getToolDefinitions gates the tool declaration with —
    // see agent-core's buildArticleFeedbackSystemPrompt. Must be part of the
    // cache key: without it, a prompt built while the toggle was off (or CLOUD
    // flipped to LOCAL) would keep serving stale text after the user flips the
    // toggle on, so getToolDefinitions() would declare `webSearch` while the
    // cached prompt still tells the model it has no way to look beyond the
    // metadata — reproducing the exact "toggle on, still refuses" bug reported.
    const webSearch = mode === 'CLOUD' && protocol.webSearchInChat === true;

    // Static content depends only on needsToolFormat + languageName + mode +
    // webSearch — all fixed per session unless the user changes app language,
    // processing mode, or the web-search toggle.
    if (
      this.cachedSystemPrompt
      && this.lastNeedsToolFormat === needsToolFormat
      && this.lastLanguageName === languageName
      && this.lastMode === mode
      && this.lastWebSearch === webSearch
    ) {
      return this.cachedSystemPrompt;
    }

    this.cachedSystemPrompt = buildArticleFeedbackSystemPrompt({
      needsToolFormat,
      languageName,
      webSearch,
      // Same gate as getToolDefinitions' `proposeFactCheck` declaration, and
      // part of the cache key below for the same reason webSearch is: a prompt
      // built in one mode must not keep serving after the user switches.
      factCheck: mode === 'CLOUD',
    });
    this.lastNeedsToolFormat = needsToolFormat;
    this.lastLanguageName = languageName;
    this.lastMode = mode;
    this.lastWebSearch = webSearch;
    return this.cachedSystemPrompt;
  }

  // --- IAgent: dynamic context (rebuilt every turn) ---

  async buildContext(): Promise<string> {
    const context = await this.loadArticleContext();
    // Same CLOUD gate as the prompt section and the tool declaration — a fourth
    // place it must agree, because it decides how much of the article the claim
    // picker actually gets to read.
    const factCheck =
      useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice;
    const facts = await getFacts(); // newest-first (sorted created_at desc)

    const storeContext = useFloatingChatStore.getState().context;
    const fallbackTitle =
      storeContext.kind === 'article-suggestion' ? storeContext.articleTitle : undefined;
    // Feed-verdict handoff: the like/dislike + tapped-option label breadcrumb.
    const verdict =
      storeContext.kind === 'article-suggestion' ? storeContext.verdict : undefined;
    const tappedOptions =
      storeContext.kind === 'article-suggestion' ? storeContext.treePath : undefined;
    const proposal = useFloatingChatStore.getState().proposal;

    // Follow-state so the agent can decline a duplicate track (best-effort).
    let isTracked: boolean | undefined;
    const trackSubject = this.resolveTrackSubject();
    if (trackSubject) {
      try {
        isTracked = await isSubjectTracked(trackSubject as FeedbackSubject);
      } catch {
        /* non-fatal — leave undefined (no TRACK STATE line) */
      }
    }

    // Sibling titles (only when following a story) ground multi-option tracks.
    const relatedCoverage = await this.getRelatedCoverage();
    // Active filters so the agent can offer to REMOVE one (D6 chat-first parity).
    const activeSuppressions = await this.loadActiveSuppressions();

    return buildFeedbackContext({
      // The real clock lives HERE (the adapter), never inside the pure builder —
      // anchors proposeTrack scopes to the present instead of to whatever year
      // dominates the model's training data.
      nowMs: Date.now(),
      articlePubDate: trackSubject?.pubDate ?? null,
      facts,
      context,
      fallbackTitle,
      proposal,
      isTracked,
      relatedCoverage,
      verdict,
      tappedOptions,
      activeSuppressions,
      factCheck,
    });
  }

  // --- IAgent: tool definitions (OpenAI JSON Schema for cloud chat) ---

  getToolDefinitions(): ToolDefinition[] {
    // Read fresh (not the buildSystemPrompt cache) — this method is also called
    // standalone (executeTool's forced-extraction payload, tool-name
    // resolution) on a turn whose prompt was never rebuilt. Same gate as the
    // prompt's webSearchLine: CLOUD mode AND the user's toggle. The handler
    // (web-search-handler.ts) re-checks the toggle regardless — belt-and-braces
    // for a persisted conversation replaying a call made while it was on.
    const protocol = useMeraProtocolStore.getState();
    const mode: 'CLOUD' | 'LOCAL' =
      protocol.processingMode === ProcessingMode.OnDevice ? 'LOCAL' : 'CLOUD';
    return getArticleFeedbackToolDefinitions(mode, protocol.webSearchInChat === true);
  }

  /**
   * NO forced-extraction pass on this surface — returns empty, which the cloud
   * hook reads as "skip the pass entirely".
   *
   * The forced pass exists for ONE reason: PersonaUpdateAgent's prompt makes
   * `saveExtractedFacts` mandatory every turn ("ALWAYS at least
   * saveExtractedFacts, empty array if nothing new") and the model sometimes
   * skips it. THIS agent has no mandatory tool — every tool it exposes is a
   * propose/confirm action that must fire only on real user intent — so there
   * is nothing here for a repair pass to repair.
   *
   * Running it anyway is actively harmful, because tool_choice:'required'
   * forces one of the four to be called and executed:
   *   - proposeChanges / proposeTrack -> stages a confirm card the user never
   *     asked for (sideEffects.proposal -> setProposal);
   *   - applyProposal -> runs executeProposalActions, mutating the persona and
   *     writing change-log rows WITHOUT the user confirming;
   *   - cancelProposal -> silently discards a proposal the user was about to
   *     accept.
   *
   * Suppressing the pass whenever a proposal is already pending is NOT enough
   * on its own: with no proposal in flight, a forced proposeChanges/proposeTrack
   * still invents one. Only an empty payload closes it.
   */
  getForcedExtractionTools(): ToolDefinition[] {
    return [];
  }

  // --- IAgent: tool execution ---

  async executeTool(name: string, input: unknown): Promise<ToolExecutionResult> {
    const args = (input as Record<string, unknown>) ?? {};

    switch (name) {
      case 'proposeChanges': {
        // Validate referenced fact ids in a single getFacts pass, then let the
        // pure brain decide the staged proposal / error. The article context +
        // active filters let it corroborate a structured suppression value (D9)
        // and resolve a retire_suppression id against real rows.
        const facts = await getFacts();
        const factIds = new Set(facts.map((f) => f.id));
        const article = await this.loadArticleContext();
        const activeSuppressions = await this.loadActiveSuppressions();
        return decideProposeChanges(args, factIds, { article, activeSuppressions });
      }

      case 'proposeTrack': {
        // "Follow this story" — stage a track_story proposal. Guard against a
        // duplicate follow up front (deterministic, not left to the LLM).
        const subject = this.resolveTrackSubject();
        if (!subject) {
          return { result: { error: 'no article to follow in this context' } };
        }
        try {
          if (await isSubjectTracked(subject as FeedbackSubject)) {
            return {
              result: { alreadyTracked: true, message: 'Already following this story.' },
            };
          }
        } catch {
          /* non-fatal — proceed to propose */
        }
        return decideProposeTrack(args, subject);
      }

      case 'proposeFactCheck': {
        // Stage the claim pills against this article's snapshot, plus the
        // always-last whole-article option. No already-checked guard: per-claim
        // identity means one article can legitimately carry several checks.
        //
        // The article option's label is USER-FACING PROSE, not a search key, so
        // it is localized HERE — the pure layer never reads i18n — and it is
        // resolved at stage time so the persisted tool result carries the same
        // string the resumed card rebuilds from.
        const subject = await this.resolveFactCheckSubject();
        if (!subject) {
          return { result: { error: 'no article to fact-check in this context' } };
        }
        // `factCheck.optionWholeArticle` lands with the wave's `en.json` splice;
        // typed `t` is generated from that file, so the key is not in the union
        // yet. One cast, and deliberately no `defaultValue` — an inline English
        // default is how English has previously shipped into 19 locale files.
        return decideProposeFactCheck(
          args,
          subject,
          i18n.t('factCheck.optionWholeArticle' as 'factCheck.chatSeed'),
        );
      }

      case 'applyProposal': {
        const proposal = useFloatingChatStore.getState().proposal;
        if (!proposal) return { result: { error: 'no pending proposal' } };

        // SINGLE-SELECT cards are never applied from chat. The alternatives are
        // mutually exclusive and only ProposalCard.handleConfirm knows WHICH one
        // the user picked, so applying them all is not "what the user asked for":
        // a typed "yes" against a 3-pill proposeTrack card minted three topics
        // AND three followed stories. A model-chosen index would not fix it —
        // the model's reading of assent is exactly what is not trusted here
        // (same conclusion as run_calibration, and as FollowStoryAgent, which
        // refuses applyProposal outright). Consent is the tap.
        //
        // No `proposalResolved` side effect: the card must stay pending so the
        // pills remain tappable, and the message gives the model something true
        // to say instead of stranding the user in silence.
        if (proposalRequiresUserChoice(proposal)) {
          return { result: chooseOneRefusal() };
        }

        // UI-ONLY actions are stripped before the executor sees them (which
        // would silently drop them anyway, since they are user-confirmed-only).
        // Doing it here is what keeps the CARD alive: applying a
        // run_calibration-only proposal used to report applied:0 and still
        // resolve the card, putting the recalibration out of reach. Mirrors
        // PersonaUpdateAgent.applyProposal.
        const uiOnly = proposal.actions.filter((a) => a.type === 'run_calibration');
        const applicable = proposal.actions.filter((a) => a.type !== 'run_calibration');
        if (applicable.length === 0) return { result: userTapOnlyRefusal() };

        const { applied, errors, summaries, changeLogIds } =
          await executeProposalActions(applicable);
        // A Feed-verdict handoff whose proposals just APPLIED has folded that
        // verdict into the persona — stamp its feedback row processed so the
        // deferred daily-plan wave won't double-count it. Best-effort; gated on
        // the store context carrying a verdict + article id.
        const sc = useFloatingChatStore.getState().context;
        if (sc && sc.kind === 'article-suggestion' && sc.verdict) {
          const articleId = sc.articleId ?? this.target.articleId;
          if (articleId) {
            await markFeedbackProcessedFor(articleId, sc.verdict).catch(() => {
              /* non-fatal */
            });
          }
        }
        // summaries + changeLogIds surface what changed and power undo (revert_change).
        return {
          result: {
            applied,
            errors,
            summaries,
            changeLogIds,
            ...(uiOnly.length > 0 ? { awaitingUserConfirmation: true } : {}),
          },
          // Only resolve when nothing is still waiting on a tap — otherwise the
          // card would vanish before the user could confirm the rest.
          ...(uiOnly.length === 0
            ? { sideEffects: { proposalResolved: 'applied' as const } }
            : {}),
        };
      }

      case 'cancelProposal':
        return { result: { cancelled: true }, sideEffects: { proposalResolved: 'cancelled' } };

      // OPT-IN, off by default — see getToolDefinitions and agent-core's
      // WEB_SEARCH_TOOL. Declared only while the toggle is on, but an
      // UNDECLARED replayed call (persisted conversation, toggle now off)
      // still lands here: normalizeToolName finds no declared match, the raw
      // name falls through, and handleWebSearch re-checks the toggle as its
      // first statement before any await — same shape as PersonaUpdateAgent's
      // 'webSearch' case.
      case 'webSearch': {
        const result = await handleWebSearch(args);
        return { result };
      }

      default:
        logger.warn('[ArticleFeedbackAgent] Unknown tool', { name });
        return { result: { error: `Unknown tool: ${name}` } };
    }
  }
}
