// FactCheckAgent — implements IAgent for the "fact-check this" chat opened from
// an article's fact-check tick.
//
// It is the CLAIM-PICKING sibling of FollowStoryAgent: same propose-then-confirm
// machinery (proposeFactCheck → StagedProposal of `fact_check_claim` actions →
// ProposalCard pills → executeProposalActions → enqueueFactCheck), but the pills
// are claims to check rather than scopes to follow. Every downstream consumer
// (ProposalCard, deriveThreadItems, the executor) gained one case and nothing
// else.
//
// This is the thin RN adapter: prompt/context/tool construction all live in the
// RN-free brain at lib/news-harness/fact-check.
//
// PAID-TIER GATE: there is none here, deliberately. Every entry point funnels
// through `useFloatingChatStore.openArticleFeedback`, which no-ops on
// `getAiAccess() === 'locked'` — that single chokepoint IS the spend decision,
// and a second gate here would be a second thing to keep in sync.

import logger from '../../logger';
import {
  buildFactCheckContext,
  buildFactCheckSystemPrompt,
  getFactCheckToolDefinitions,
  decideProposeFactCheck,
  makeFactCheckSubject,
  type FactCheckArticleInput,
} from '../../news-harness/fact-check';
import { useAppLanguageStore } from '../../stores/app-language-store';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { SUPPORTED_LANGUAGES } from '../../translation-service';
import type { IAgent, ToolDefinition, ToolExecutionResult } from '../types';

export class FactCheckAgent implements IAgent {
  readonly id: string;

  constructor(
    private readonly userId: string,
    private readonly article: FactCheckArticleInput,
  ) {
    this.id = `fact-check-${userId}-${article.articleId}`;
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

    this.cachedSystemPrompt = buildFactCheckSystemPrompt({ needsToolFormat, languageName });
    this.lastNeedsToolFormat = needsToolFormat;
    this.lastLanguageName = languageName;
    return this.cachedSystemPrompt;
  }

  // --- IAgent: dynamic context (rebuilt every turn) ---

  async buildContext(): Promise<string> {
    return buildFactCheckContext({
      // The real clock lives HERE (the adapter), never inside the pure builder.
      nowMs: Date.now(),
      article: this.article,
      proposal: useFloatingChatStore.getState().proposal,
    });
  }

  // --- IAgent: tool definitions ---

  getToolDefinitions(): ToolDefinition[] {
    return getFactCheckToolDefinitions();
  }

  /**
   * NO forced-extraction pass — same reasoning as FollowStoryAgent:
   * `tool_choice:'required'` would oblige a `proposeFactCheck` call on a purely
   * conversational turn ("what does this even mean?"), staging a card of claims
   * the user never asked to check.
   */
  getForcedExtractionTools(): ToolDefinition[] {
    return [];
  }

  // --- IAgent: tool execution ---

  async executeTool(name: string, input: unknown): Promise<ToolExecutionResult> {
    const args = (input as Record<string, unknown>) ?? {};

    switch (name) {
      case 'proposeFactCheck':
        // Stage the claim pills against this article's snapshot. No
        // already-checked guard here: per-claim identity means the same article
        // can legitimately carry several checks, and the queue's `claimKey`
        // dedupe (F2) is the one place that decision belongs.
        return decideProposeFactCheck(args, makeFactCheckSubject(this.article));

      case 'cancelProposal':
        return { result: { cancelled: true }, sideEffects: { proposalResolved: 'cancelled' } };

      case 'applyProposal':
        // NOT offered in getToolDefinitions, and refused here even if a model
        // invents the name. The staged card is single-select: only
        // ProposalCard.handleConfirm knows WHICH claim the user picked, so an
        // agent-side apply would enqueue every claim on one typed "yes" — four
        // background checks from one word. Consent is the tap.
        return {
          result: {
            error: 'the user must tap a claim on the card — this cannot be applied from chat',
          },
        };

      default:
        logger.warn('[FactCheckAgent] Unknown tool', { name });
        return { result: { error: `Unknown tool: ${name}` } };
    }
  }
}
