// What every on-device chat agent shares: the app language, the history as the
// flows read it, and one structured call sized to the engine's window.

import { completeLocalStructured } from '../../completeLocal';
import { contextSize } from '../../../mera-protocol-toolkit';
import type { JsonSchema } from '../../../mera-protocol-toolkit/core/structured-json';
import {
  ON_DEVICE_CHAT_MAX_TOKENS,
  promptBudgetTokens,
  type ChatTurn,
} from '../../../news-harness/on-device/shared';
import { useAppLanguageStore } from '../../../stores/app-language-store';
import { SUPPORTED_LANGUAGES } from '../../../translation-service';
import type { ConversationMessage } from '../../types';

export function appLanguageName(): string {
  const code = useAppLanguageStore.getState().appLanguage;
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name ?? 'English';
}

/** The thread as plain turns. Hidden turns stay: the model must read them. */
export function chatTurns(messages: ConversationMessage[]): ChatTurn[] {
  return messages.filter((m) => m.content.trim().length > 0).map((m) => ({ role: m.role, content: m.content }));
}

/** Today as YYYY-MM-DD (UTC), the date anchor for story options. */
export function today(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Tokens the prompt may use on this engine, once instructions, schema and reply are paid for. */
export async function promptBudget(system: string, schema?: JsonSchema): Promise<number> {
  return promptBudgetTokens({
    contextSize: await contextSize(),
    maxTokens: ON_DEVICE_CHAT_MAX_TOKENS,
    system,
    schemaJson: schema ? JSON.stringify(schema) : undefined,
  });
}

/** One structured on-device turn: the value fitting `schema`, or StructuredOutputError. */
export async function respondStructured<T>(system: string, schema: JsonSchema, prompt: (budget: number) => string): Promise<T> {
  return completeLocalStructured<T>({
    systemPrompt: system,
    prompt: prompt(await promptBudget(system, schema)),
    schema,
    maxTokens: ON_DEVICE_CHAT_MAX_TOKENS,
    temperature: 0.3,
  });
}
