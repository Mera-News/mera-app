// FollowStoryAgent — implements IAgent for the "follow a story" chat opened from
// the Followed-stories screen's track FAB.
//
// It is the ARTICLE-LESS sibling of ArticleFeedbackAgent: same propose-then-
// confirm machinery (proposeTrack → StagedProposal of `track_story` actions →
// ProposalCard scope pills → executeProposalActions → trackStoryWithProposal),
// but scoped from FREE TEXT instead of from an article. It reuses
// `decideProposeTrack` verbatim, so the staged proposal is byte-identical in
// shape to the one the article surface stages and every downstream consumer
// (ProposalCard, deriveThreadItems, the executor) needs no change.
//
// This is the thin RN adapter: prompt/context/tool construction all live in the
// RN-free brain at lib/news-harness/follow-story.

import { decideProposeTrack } from '../../news-harness/article-feedback/agent-core';
import {
  buildFollowStoryContext,
  buildFollowStorySystemPrompt,
  getFollowStoryToolDefinitions,
  makeFollowStorySubject,
} from '../../news-harness/follow-story';
import logger from '../../logger';
import { useAppLanguageStore } from '../../stores/app-language-store';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { SUPPORTED_LANGUAGES } from '../../translation-service';
import type { IAgent, ToolDefinition, ToolExecutionResult } from '../types';

export class FollowStoryAgent implements IAgent {
  readonly id: string;

  constructor(private readonly userId: string) {
    this.id = `follow-story-${userId}`;
  }

  // --- IAgent: system prompt (static — cacheable by KV cache) ---

  private cachedSystemPrompt: string | null = null;
  private lastNeedsToolFormat: boolean | null = null;
  private lastLanguageName: string | null = null;

  async buildSystemPrompt(needsToolFormat: boolean): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';

    if (
      this.cachedSystemPrompt
      && this.lastNeedsToolFormat === needsToolFormat
      && this.lastLanguageName === languageName
    ) {
      return this.cachedSystemPrompt;
    }

    this.cachedSystemPrompt = buildFollowStorySystemPrompt({ needsToolFormat, languageName });
    this.lastNeedsToolFormat = needsToolFormat;
    this.lastLanguageName = languageName;
    return this.cachedSystemPrompt;
  }

  // --- IAgent: dynamic context (rebuilt every turn) ---

  async buildContext(): Promise<string> {
    return buildFollowStoryContext({
      // The real clock lives HERE (the adapter), never inside the pure builder —
      // it anchors scopes to the present instead of to whatever year dominates
      // the model's training data.
      nowMs: Date.now(),
      proposal: useFloatingChatStore.getState().proposal,
    });
  }

  // --- IAgent: tool definitions ---

  getToolDefinitions(): ToolDefinition[] {
    return getFollowStoryToolDefinitions();
  }

  /**
   * NO forced-extraction pass — same reasoning as ArticleFeedbackAgent, and
   * sharper here: `tool_choice:'required'` would oblige a `proposeTrack` call on
   * a purely conversational turn, staging a follow the user never asked for.
   */
  getForcedExtractionTools(): ToolDefinition[] {
    return [];
  }

  // --- IAgent: tool execution ---

  async executeTool(name: string, input: unknown): Promise<ToolExecutionResult> {
    const args = (input as Record<string, unknown>) ?? {};

    switch (name) {
      case 'proposeTrack':
        // Stage the scope pills against the article-less origin snapshot. No
        // already-following guard: a free-text follow has no article identity to
        // collide on, so there is nothing deterministic to check (see
        // makeFollowStorySubject).
        return decideProposeTrack(args, makeFollowStorySubject());

      case 'cancelProposal':
        return { result: { cancelled: true }, sideEffects: { proposalResolved: 'cancelled' } };

      case 'applyProposal':
        // NOT offered in getToolDefinitions, and refused here even if a model
        // invents the name. The staged card is single-select: only
        // ProposalCard.handleConfirm knows WHICH scope the user picked, so an
        // agent-side apply would run every action and mint three topics plus
        // three followed stories from one typed "yes". Consent is the tap.
        return {
          result: {
            error: 'the user must tap a scope on the card — this cannot be applied from chat',
          },
        };

      default:
        logger.warn('[FollowStoryAgent] Unknown tool', { name });
        return { result: { error: `Unknown tool: ${name}` } };
    }
  }
}
