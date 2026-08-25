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

import { ProcessingMode } from '../../generated/graphql-types';
import { handleSearchNews } from '../../chat-tools/news-search-handler';
import { handleWebSearch } from '../../chat-tools/web-search-handler';
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
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
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
  private lastCanSearch: boolean | null = null;
  private lastWebSearch: boolean | null = null;

  /**
   * The retrieval gates, read from the store and shared by `buildSystemPrompt`
   * and `getToolDefinitions` so the prompt and the tool payload for one turn
   * always agree.
   */
  private searchGates(): { mode: 'CLOUD' | 'LOCAL'; canSearch: boolean; webSearch: boolean } {
    const protocol = useMeraProtocolStore.getState();
    const mode: 'CLOUD' | 'LOCAL' =
      protocol.processingMode === ProcessingMode.OnDevice ? 'LOCAL' : 'CLOUD';
    return {
      mode,
      canSearch: mode === 'CLOUD',
      webSearch: mode === 'CLOUD' && protocol.webSearchInChat === true,
    };
  }

  async buildSystemPrompt(needsToolFormat: boolean): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';
    const { canSearch, webSearch } = this.searchGates();

    // canSearch and webSearch ARE PART OF THE CACHE KEY. Without them a prompt
    // built while the toggle was off keeps telling the model it cannot look
    // anything up after the user turns it on, while getToolDefinitions() hands
    // over the tool — the "toggle on, still refuses" bug ArticleFeedbackAgent
    // already had reported against it.
    if (
      this.cachedSystemPrompt
      && this.lastNeedsToolFormat === needsToolFormat
      && this.lastLanguageName === languageName
      && this.lastCanSearch === canSearch
      && this.lastWebSearch === webSearch
    ) {
      return this.cachedSystemPrompt;
    }

    this.cachedSystemPrompt = buildFollowStorySystemPrompt({
      needsToolFormat,
      languageName,
      canSearch,
      webSearch,
    });
    this.lastNeedsToolFormat = needsToolFormat;
    this.lastLanguageName = languageName;
    this.lastCanSearch = canSearch;
    this.lastWebSearch = webSearch;
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
    const { mode, webSearch } = this.searchGates();
    return getFollowStoryToolDefinitions(mode, webSearch);
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

      // The two grounding tools. Without them this agent had no article, no
      // index and a rule against inventing entities, so a user naming a story
      // from this week left it nothing to do but ask again or refuse.
      case 'searchNews':
        return { result: await handleSearchNews(args) };

      case 'webSearch':
        return { result: await handleWebSearch(args) };

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
