// TutorialHelpAgent — implements IAgent for the "Ask Mera" button on a tutorial
// slide. Product help, and nothing else.
//
// It is the thin RN adapter over lib/news-harness/tutorial-help: prompt and
// context construction live in that RN-free brain, and everything that touches
// Zustand or the logger lives here.
//
// ⚠️ THE POINT OF THIS CLASS IS STILL WHAT IT DOES NOT HAVE.
// `agent-registry.ts` used to route `{ kind: 'generic' }` to
// `PersonaUpdateAgent`, which is told to redirect off-profile questions AND to
// emit at least one `saveExtractedFacts` per turn. A tutorial question would
// therefore be deflected and would silently write to the reader's profile — a
// failure that LOOKS like success (the popover morphs, a reply streams).
//
// `webSearch` — read-only, CLOUD-only, behind the user's toggle — is the ONE
// tool this agent now carries, so a reader who asks about something outside the
// app gets an answer instead of a shrug. Nothing about the original failure is
// reopened by it: `saveExtractedFacts` is still absent, so is every other
// mutating tool, and every name
// this class is not offering is still refused below.

import { handleWebSearch } from '../../chat-tools/web-search-handler';
import {
  buildTutorialHelpContext,
  buildTutorialHelpPrompt,
  getTutorialHelpToolDefinitions,
} from '../../news-harness/tutorial-help';
import logger from '../../logger';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { useAppLanguageStore } from '../../stores/app-language-store';
import { SUPPORTED_LANGUAGES } from '../../translation-service';
import type { IAgent, ToolDefinition, ToolExecutionResult } from '../types';

export class TutorialHelpAgent implements IAgent {
  readonly id: string;

  constructor(
    private readonly userId: string,
    /** `tutorials/<chapter>/<slide>` from the chat context. */
    private readonly route: string | null,
  ) {
    this.id = `tutorial-help-${userId}`;
  }

  // --- IAgent: system prompt (static — cacheable by KV cache) ---

  private cachedSystemPrompt: string | null = null;
  private lastLanguageName: string | null = null;
  private lastWebSearch: boolean | null = null;

  /** The user's toggle. Cloud-only: on-device runs TutorialHelpOnDeviceAgent,
   *  which has no tools at all. */
  private webSearchEnabled(): boolean {
    return useMeraProtocolStore.getState().webSearchInChat === true;
  }

  async buildSystemPrompt(): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';
    const webSearch = this.webSearchEnabled();

    // webSearch IS PART OF THE CACHE KEY. Without it the cached prompt keeps
    // saying "you have no tools at all" after the user turns the toggle on,
    // while getToolDefinitions() hands the model a tool — the "toggle on, still
    // refuses" shape already reported against ArticleFeedbackAgent.
    if (
      this.cachedSystemPrompt
      && this.lastLanguageName === languageName
      && this.lastWebSearch === webSearch
    ) {
      return this.cachedSystemPrompt;
    }

    this.cachedSystemPrompt = buildTutorialHelpPrompt({ languageName, webSearch });
    this.lastLanguageName = languageName;
    this.lastWebSearch = webSearch;
    return this.cachedSystemPrompt;
  }

  // --- IAgent: dynamic context (rebuilt every turn) ---

  async buildContext(): Promise<string> {
    return buildTutorialHelpContext(this.route);
  }

  // --- IAgent: tools ---

  /** `webSearch` and nothing else, and only with the toggle on. Every
   *  MUTATING tool stays absent — see the class comment. */
  getToolDefinitions(): ToolDefinition[] {
    return getTutorialHelpToolDefinitions(this.webSearchEnabled());
  }

  async executeTool(name: string, input: unknown): Promise<ToolExecutionResult> {
    if (name === 'webSearch') {
      // The handler re-checks the toggle before any await, so a call replayed
      // from a conversation held while it was on still cannot search.
      return { result: await handleWebSearch((input as Record<string, unknown>) ?? {}) };
    }

    // Reached only if a model invents a tool name it was never offered. Logged
    // rather than thrown: a fabricated call must degrade to an ordinary reply,
    // never take down a chat opened from a tutorial card.
    logger.warn('[TutorialHelpAgent] Refused a tool call — this agent has no tools', {
      name,
    });
    return {
      result: {
        error:
          'this assistant only explains how mera works and cannot change anything',
      },
    };
  }
}
