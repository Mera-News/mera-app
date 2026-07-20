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
    const ctx = await getSuggestionFeedbackContext(this.target);
    const facts = await getFacts(); // newest-first (sorted created_at desc)

    const storeContext = useFloatingChatStore.getState().context;
    const fallbackTitle =
      storeContext.kind === 'article-suggestion' ? storeContext.articleTitle : undefined;
    const proposal = useFloatingChatStore.getState().proposal;

    // Map the RN suggestion row into the harness's enum-free plain shape.
    const context: SuggestionFeedbackContext | null = ctx
      ? {
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
        }
      : null;

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

    return buildFeedbackContext({ facts, context, fallbackTitle, proposal, isTracked });
  }

  // --- IAgent: tool definitions (OpenAI JSON Schema for cloud chat) ---

  getToolDefinitions(): ToolDefinition[] {
    return getArticleFeedbackToolDefinitions();
  }

  // --- IAgent: tool execution ---

  async executeTool(name: string, input: unknown): Promise<ToolExecutionResult> {
    const args = (input as Record<string, unknown>) ?? {};

    switch (name) {
      case 'proposeChanges': {
        // Validate referenced fact ids in a single getFacts pass, then let the
        // pure brain decide the staged proposal / error.
        const facts = await getFacts();
        const factIds = new Set(facts.map((f) => f.id));
        return decideProposeChanges(args, factIds);
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
