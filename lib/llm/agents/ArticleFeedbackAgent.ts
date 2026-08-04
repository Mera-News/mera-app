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
import {
  buildArticleFeedbackSystemPrompt,
  buildFeedbackContext,
  decideProposeChanges,
  decideProposeTrack,
  getArticleFeedbackToolDefinitions,
} from '../../news-harness/article-feedback/agent-core';
import type {
  ActiveSuppressionView,
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

  async buildSystemPrompt(needsToolFormat: boolean): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';
    const mode: 'CLOUD' | 'LOCAL' =
      useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice
        ? 'LOCAL'
        : 'CLOUD';

    // Static content depends only on needsToolFormat + languageName + mode —
    // all fixed per session unless the user changes app language or processing.
    if (
      this.cachedSystemPrompt
      && this.lastNeedsToolFormat === needsToolFormat
      && this.lastLanguageName === languageName
      && this.lastMode === mode
    ) {
      return this.cachedSystemPrompt;
    }

    this.cachedSystemPrompt = buildArticleFeedbackSystemPrompt({ needsToolFormat, languageName });
    this.lastNeedsToolFormat = needsToolFormat;
    this.lastLanguageName = languageName;
    this.lastMode = mode;
    return this.cachedSystemPrompt;
  }

  // --- IAgent: dynamic context (rebuilt every turn) ---

  async buildContext(): Promise<string> {
    const context = await this.loadArticleContext();
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
    });
  }

  // --- IAgent: tool definitions (OpenAI JSON Schema for cloud chat) ---

  getToolDefinitions(): ToolDefinition[] {
    return getArticleFeedbackToolDefinitions();
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

      case 'applyProposal': {
        const proposal = useFloatingChatStore.getState().proposal;
        if (!proposal) return { result: { error: 'no pending proposal' } };
        const { applied, errors, summaries, changeLogIds } =
          await executeProposalActions(proposal.actions);
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
          result: { applied, errors, summaries, changeLogIds },
          sideEffects: { proposalResolved: 'applied' },
        };
      }

      case 'cancelProposal':
        return { result: { cancelled: true }, sideEffects: { proposalResolved: 'cancelled' } };

      default:
        logger.warn('[ArticleFeedbackAgent] Unknown tool', { name });
        return { result: { error: `Unknown tool: ${name}` } };
    }
  }
}
