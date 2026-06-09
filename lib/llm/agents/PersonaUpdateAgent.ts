// PersonaUpdateAgent — implements IAgent for the persona update chat surface.
// Responsible for system prompt construction, message formatting, and tool execution.
// Conversations are ephemeral (in-memory only, managed by useMeraLLM).

import {
  handleAdvanceQuestionnaireLevel,
  handleDeleteUserFacts,
  handleIssueWarning,
  handleSaveExtractedFacts,
  handleUpdateUserConfig,
} from '../../chat-tools/tool-handlers';
import { getCoveredAttributeKeys, getFacts, getQuestionnaireLevel, setQuestionnaireLevel } from '../../database/services/fact-service';
import logger from '../../logger';
import { buildPersonaUpdateStaticPrompt, buildPersonaUpdateContext, buildToolDefinitions } from '../../mera-protocol/prompts';
import {
  buildQuestionnaireGuide,
  getAttributeKeysForLevel,
  TOTAL_LEVELS,
} from '../../mera-protocol/questionnaire-data';
import { useAppLanguageStore } from '../../stores/app-language-store';
import { useMeraProtocolStore, useUseLegacyPersonaUpdate } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import { SUPPORTED_LANGUAGES } from '../../translation-service';
import type {
  ConversationMessage,
  IAgent,
  ToolDefinition,
  ToolExecutionResult,
} from '../types';

// Local copy — ProviderMessage removed from shared types.ts (engine-only concern, deleted in Phase 5)
type ProviderMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'tool'; toolCallId: string; toolName: string; input: unknown; result: unknown };

export const MAX_HISTORY_MESSAGES = 8; // wire history now includes tool_call/tool_result entries; allow more turns
const MAX_FACTS_IN_CONTEXT = 22; // Cap facts to stay within 4096-token context window

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
  private lastUseLegacy: boolean | null = null;

  async buildSystemPrompt(needsToolFormat: boolean): Promise<string> {
    const appLanguage = useAppLanguageStore.getState().appLanguage;
    const languageName =
      SUPPORTED_LANGUAGES.find((l) => l.code === appLanguage)?.name ?? 'English';
    const mode: 'CLOUD' | 'LOCAL' =
      useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice
        ? 'LOCAL'
        : 'CLOUD';
    const useLegacy = useMeraProtocolStore.getState().useLegacyPersonaUpdate;

    // Static prompt depends on surface + needsToolFormat + languageName + mode + useLegacy.
    // All are fixed per session unless the user changes their app language or
    // toggles on-device / cloud processing.
    if (
      this.cachedSystemPrompt
      && this.lastNeedsToolFormat === needsToolFormat
      && this.lastLanguageName === languageName
      && this.lastMode === mode
      && this.lastUseLegacy === useLegacy
    ) {
      return this.cachedSystemPrompt;
    }
    this.cachedSystemPrompt = buildPersonaUpdateStaticPrompt({
      surface: this.surface,
      includeToolFormat: needsToolFormat,
      languageName,
      mode,
      useLegacy,
    });
    this.lastNeedsToolFormat = needsToolFormat;
    this.lastLanguageName = languageName;
    this.lastMode = mode;
    this.lastUseLegacy = useLegacy;
    return this.cachedSystemPrompt;
  }

  // --- IAgent: dynamic context (injected into user messages each turn) ---

  async buildContext(): Promise<string> {
    const useLegacy = useMeraProtocolStore.getState().useLegacyPersonaUpdate;

    const facts = await getFacts();
    const displayFacts = facts.length > MAX_FACTS_IN_CONTEXT
      ? facts.slice(-MAX_FACTS_IN_CONTEXT)
      : facts;

    const knownFactsList =
      displayFacts.length > 0
        ? displayFacts.map((f) => {
            const attrText = f.questionnaireAttribute ?? 'other';
            return `- '${attrText}': ${f.statement}`;
          }).join('\n')
        : 'Nothing yet.';

    if (!useLegacy) {
      return buildPersonaUpdateContext({ knownFactsList, useLegacy: false });
    }

    // Legacy path: level-based questionnaire with [ASK]/[DONE] annotations
    const coveredAttributes = await getCoveredAttributeKeys();

    let currentLevel = await getQuestionnaireLevel();
    while (currentLevel > 1) {
      const prevLevelKeys = getAttributeKeysForLevel(currentLevel - 1);
      const allPrevCovered = prevLevelKeys.length > 0 && prevLevelKeys.every((key) => coveredAttributes.has(key));
      if (allPrevCovered) break;
      currentLevel--;
    }
    while (currentLevel < TOTAL_LEVELS) {
      const levelKeys = getAttributeKeysForLevel(currentLevel);
      if (levelKeys.length === 0) break;
      const allCovered = levelKeys.every((key) => coveredAttributes.has(key));
      if (!allCovered) break;
      currentLevel++;
    }
    await setQuestionnaireLevel(currentLevel);

    const questionnaireGuide = buildQuestionnaireGuide(currentLevel, coveredAttributes);

    return buildPersonaUpdateContext({
      knownFactsList,
      useLegacy: true,
      questionnaireGuide,
      currentLevel,
      totalLevels: TOTAL_LEVELS,
    });
  }

  // --- IAgent: tool definitions (OpenAI JSON Schema for cloud chat) ---

  getToolDefinitions(): ToolDefinition[] {
    const useLegacy = useMeraProtocolStore.getState().useLegacyPersonaUpdate;
    return buildToolDefinitions(this.surface, useLegacy);
  }

  // --- IAgent: message formatting ---

  formatMessages(messages: ConversationMessage[]): ProviderMessage[] {
    // Slice to limit history, but guarantee the result starts with a user message.
    // During re-inference loops (cloud tool-call loop) the naive slice drops the user
    // message once convoBuf grows beyond MAX_HISTORY_MESSAGES — LLM APIs require the
    // first message to be a user turn.
    let limited = messages.slice(-MAX_HISTORY_MESSAGES);
    if (limited[0]?.role !== 'user') {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser) limited = [lastUser, ...limited];
    }
    const result: ProviderMessage[] = [];

    for (const msg of limited) {
      result.push({ role: msg.role, content: msg.content });

      // Append tool results as separate tool messages (must come after assistant text)
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.result !== undefined) {
            result.push({
              role: 'tool',
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.input,
              result: tc.result,
            });
          }
        }
      }
    }

    return result;
  }

  // --- IAgent: tool execution ---

  async executeTool(
    name: string,
    input: unknown,
  ): Promise<ToolExecutionResult> {
    const args = (input as Record<string, unknown>) ?? {};

    // Normalize common LLM misspellings of tool names
    const normalizedName = name === 'saveExtractedsFacts' ? 'saveExtractedFacts' : name;

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

      case 'advanceQuestionnaireLevel': {
        const result = await handleAdvanceQuestionnaireLevel();
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

      default:
        logger.warn('[PersonaUpdateAgent] Unknown tool', { name });
        return { result: { error: `Unknown tool: ${name}` } };
    }
  }
}
