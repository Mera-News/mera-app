// What every on-device chat agent shares: the app language, the history as the
// flows read it, and one structured call sized to the engine's window.

import { completeLocalStructured } from '../../completeLocal';
import { contextSize, decide } from '../../../mera-protocol-toolkit';
import type { JsonSchema } from '../../../mera-protocol-toolkit/core/structured-json';
import { getFacts } from '../../../database/services/fact-service';
import i18n from '../../../i18n';
import logger from '../../../logger';
import { resolveDeleteTargets } from '../../../mera-harness/core/fact-normalise';
import type { MoreOptionsRequest } from '../../../chat-session/engine';
import { runMoreTrackOptions } from '../../../news-harness/on-device/follow-story/more-options';
import { ASK_CHOICE_AWAITING, ASK_CHOICE_TOOL, type KevPorts } from '../../../news-harness/on-device/kev';
import {
  ON_DEVICE_CHAT_MAX_TOKENS,
  promptBudgetTokens,
  type ChatTurn,
} from '../../../news-harness/on-device/shared';
import { useAppLanguageStore } from '../../../stores/app-language-store';
import { SUPPORTED_LANGUAGES } from '../../../translation-service';
import type { ConversationMessage, ToolExecutionResult } from '../../types';
import { ON_DEVICE_CHAT_ROUTE, type OnDeviceChatFlow, type OnDeviceChatRoute } from './routes';

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

/** The app's Kev ports: the toolkit's decide (llama lock inside), the built-in model as writer, i18n. */
export function appKevPorts(): KevPorts {
  return {
    decide,
    write: (system, prompt, schema) =>
      completeLocalStructured({ systemPrompt: system, prompt, schema, maxTokens: ON_DEVICE_CHAT_MAX_TOKENS, temperature: 0.3 }),
    budget: (system, schema) => promptBudget(system, schema),
    t: (key) => (i18n.t as (k: string) => string)(key),
  };
}

/** Constructor options of the on-device chat agents: tests and the harness swap the route and the ports. */
export interface OnDeviceAgentOptions {
  route?: OnDeviceChatRoute;
  ports?: Partial<KevPorts>;
}

export function routeOf(flow: OnDeviceChatFlow, opts: OnDeviceAgentOptions): OnDeviceChatRoute {
  return opts.route ?? ON_DEVICE_CHAT_ROUTE[flow];
}

export function kevPorts(opts: OnDeviceAgentOptions): KevPorts {
  return { ...appKevPorts(), ...opts.ports };
}

/** "More options" for a follow card: the one writer call, on the app's ports. */
export function moreTrackOptions(req: MoreOptionsRequest, opts: OnDeviceAgentOptions, articleTitle?: string) {
  return runMoreTrackOptions(
    { today: today(), shown: req.shown, room: req.room, subject: req.subject, articleTitle },
    kevPorts(opts),
  );
}

/**
 * A Kev turn, or null when Kev itself failed (not downloaded, busy, an
 * unexpected answer): the agent then runs its single built-in call, so the user
 * never sees the failure. Writer failures never get here; the flow answers
 * them with its fixed reply.
 */
export async function tryKev<T>(tag: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    // The class only: the message can quote the user's facts.
    logger.warn(`[${tag}] Kev turn failed, single call instead`, { error: err instanceof Error ? err.name : typeof err });
    return null;
  }
}

/**
 * The tools an on-device agent answers itself, before the cloud executors:
 * - ask_choice is UI-only; the awaiting result is what makes the chips show.
 * - deleteUserFacts never deletes (D40). It stages the Remove / Keep card with
 *   the shape the cloud loop's gate writes, so the same card renders; only the
 *   card's Remove deletes.
 * Null for every other tool.
 */
export async function onDeviceTool(name: string, input: unknown): Promise<ToolExecutionResult | null> {
  if (name === ASK_CHOICE_TOOL) return { result: { ...ASK_CHOICE_AWAITING } };
  if (name !== 'deleteUserFacts') return null;
  const facts = await getFacts();
  const pending = resolveDeleteTargets(
    (input as Record<string, unknown>) ?? {},
    facts.map((f) => ({ id: f.id, statement: f.statement, attribute: f.questionnaireAttribute })),
  );
  return {
    result:
      pending.length > 0
        ? {
            error: 'The card asks the user to confirm this removal. Do not ask again.',
            pendingFactIds: pending.map((f) => f.id),
            pendingStatements: pending.map((f) => f.statement),
          }
        : { error: 'No fact on file matches.' },
  };
}
