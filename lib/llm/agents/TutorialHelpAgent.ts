// TutorialHelpAgent — implements IAgent for the "Ask Mera" button on a tutorial
// slide. Product help, and nothing else.
//
// It is the thin RN adapter over lib/news-harness/tutorial-help: prompt and
// context construction live in that RN-free brain, and everything that touches
// Zustand or the logger lives here.
//
// ⚠️ THE POINT OF THIS CLASS IS WHAT IT DOES NOT HAVE.
// `agent-registry.ts` used to route `{ kind: 'generic' }` to
// `PersonaUpdateAgent`, which is told to redirect off-profile questions AND to
// emit at least one `saveExtractedFacts` per turn. A tutorial question would
// therefore be deflected and would silently write to the reader's profile — a
// failure that LOOKS like success (the popover morphs, a reply streams). So this
// agent returns an EMPTY tool list, an empty forced-extraction list, and refuses
// every tool name it is handed.

import {
  buildTutorialHelpContext,
  buildTutorialHelpPrompt,
} from '../../news-harness/tutorial-help';
import logger from '../../logger';
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

  async buildSystemPrompt(): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';

    if (this.cachedSystemPrompt && this.lastLanguageName === languageName) {
      return this.cachedSystemPrompt;
    }

    // `needsToolFormat` is deliberately ignored: there are no tools, so there is
    // no XML tool-call block to append. Teaching the model a call format it has
    // nothing to call with is the fastest way to get a hallucinated tool call.
    this.cachedSystemPrompt = buildTutorialHelpPrompt({ languageName });
    this.lastLanguageName = languageName;
    return this.cachedSystemPrompt;
  }

  // --- IAgent: dynamic context (rebuilt every turn) ---

  async buildContext(): Promise<string> {
    return buildTutorialHelpContext(this.route);
  }

  // --- IAgent: tools ---

  /** None. See the class comment — this is the whole design. */
  getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  /**
   * Empty ⇒ the cloud path SKIPS the forced-extraction repair pass entirely.
   * That pass reruns a turn with `tool_choice:'required'`, so anything listed
   * here WOULD be called on a purely conversational turn. For a help agent every
   * turn is conversational, which makes the correct list empty twice over.
   */
  getForcedExtractionTools(): ToolDefinition[] {
    return [];
  }

  async executeTool(name: string, _input: unknown): Promise<ToolExecutionResult> {
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
