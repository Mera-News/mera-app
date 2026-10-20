// What every "Kev decides, the built-in model writes" chat turn shares (D38):
// the ports, the thread read (a chip tap included), the unsure ask, and the
// writer call with its fixed fallback. Pure and RN-free: the app and the
// harness pass their own ports.

import type { DecisionChoiceAnswer } from 'llama.rn';
import type { JsonSchema } from '../../../mera-protocol-toolkit/core/structured-json';
import { renderPrompt, type ChatTurn, type OnDeviceToolCall, type OnDeviceTurnResult } from '../shared';
import { ASK_CHOICE_TOOL, buildAskChoice, readingFromTap, type AskChoiceInput } from './ask-choice';
import { isUnsure, type DecidePort, type WriterPort } from './decision';
import { negates } from './rules';

export interface KevPorts {
  decide: DecidePort;
  write: WriterPort;
  /** Tokens the writer's prompt may use once `system` and `schema` are paid for. */
  budget(system: string, schema: JsonSchema): Promise<number>;
  /** Localised UI copy by i18n key: chips, the ask question, the fallback replies. */
  t(key: string): string;
}

/** What the harness scores: the reading acted on (the top one when Mera asked) and the two steps' time. */
export interface KevTrace {
  intent: string;
  /** rule: consent words; tap: a chip; kev: Kev's answer. */
  source: 'rule' | 'tap' | 'kev';
  asked: boolean;
  /** False when the writer failed (or was never needed) and a fixed reply went out. */
  wrote: boolean;
  decideMs: number;
  writeMs: number;
}

export interface KevTurnResult extends OnDeviceTurnResult {
  trace: KevTrace;
}

/** The thread as the agent receives it: tool calls are read for a chip tap. */
export interface KevMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { name: string; input: unknown }[];
}

/** The ask_choice input Mera sends: chips plus the reading key behind each, so a tap maps back. */
export interface KevAskInput extends AskChoiceInput {
  readings: string[];
}

export interface KevChat {
  /** Every non-empty turn, for the writer. */
  history: ChatTurn[];
  /** The user message being read: the last one, or the one Mera asked about when this turn is a chip tap. */
  subject: string;
  /** Turns before `subject`, newest last. */
  earlier: ChatTurn[];
  /** The reading key of the chip the user tapped, if this turn is a tap. */
  tap: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : []);

/** Our own ask on an assistant turn (it carries `readings`); a cloud ask never does. */
function kevAskOf(message: KevMessage | undefined): KevAskInput | null {
  for (const call of message?.toolCalls ?? []) {
    if (call.name !== ASK_CHOICE_TOOL) continue;
    const input = asRecord(call.input);
    if (input && Array.isArray(input.readings)) {
      return { question: String(input.question ?? ''), options: strings(input.options), somethingElse: true, readings: strings(input.readings) };
    }
  }
  return null;
}

export function readChat(messages: readonly KevMessage[]): KevChat {
  const turns = messages.filter((m) => m.content.trim().length > 0);
  const history: ChatTurn[] = turns.map((m) => ({ role: m.role, content: m.content }));
  let last = turns.length - 1;
  while (last >= 0 && turns[last].role !== 'user') last--;
  if (last < 0) return { history, subject: '', earlier: [], tap: null };
  const message = turns[last].content.trim();
  // A tap answers the ask on the assistant turn right before it. The empty
  // filter above never drops it: the ask's bubble carries the question.
  const ask = turns[last - 1]?.role === 'assistant' ? kevAskOf(turns[last - 1]) : null;
  const labels: Record<string, string> = {};
  ask?.readings.forEach((key, i) => {
    if (key && ask.options[i]) labels[key] = ask.options[i];
  });
  const tap = ask ? readingFromTap(message, labels) : null;
  let subjectAt = last;
  if (tap) {
    subjectAt = last - 2;
    while (subjectAt >= 0 && turns[subjectAt].role !== 'user') subjectAt--;
  }
  if (subjectAt < 0) subjectAt = last;
  return {
    history,
    subject: turns[subjectAt].content.trim(),
    earlier: history.slice(0, subjectAt),
    tap,
  };
}

/** The last few turns before the message, for Kev's state. Clipped: each question re-reads the whole state. */
export function conversationState(earlier: readonly ChatTurn[], max = 4): { role: 'user' | 'mera'; text: string }[] {
  return earlier.slice(-max).map((t) => ({ role: t.role === 'user' ? 'user' : 'mera', text: t.content.trim().slice(0, 300) }));
}

/**
 * The answer with readings that lead to the same act merged into one key, so
 * a close call between two of them is not a reason to ask. `groups` maps a
 * key to the key it merges into.
 */
export function collapse<K extends string>(
  answer: Pick<DecisionChoiceAnswer<K>, 'probabilities'>,
  groups: Partial<Record<K, K>>,
): Pick<DecisionChoiceAnswer<K>, 'probabilities'> {
  const probabilities = {} as Record<K, number>;
  for (const [key, p] of Object.entries(answer.probabilities) as [K, number][]) {
    const into = groups[key] ?? key;
    probabilities[into] = (probabilities[into] ?? 0) + p;
  }
  return { probabilities };
}

/**
 * D39: when the (collapsed) answer is unsure, the ask_choice call for its
 * likeliest labelled readings, else null. Null too when fewer than two
 * readings have a label: the flow then acts on its top reading.
 */
export function askIfUnsure<K extends string>(
  answer: Pick<DecisionChoiceAnswer<K>, 'probabilities'>,
  labels: Partial<Record<K, string>>,
  question: string,
): OnDeviceToolCall | null {
  if (!isUnsure(answer)) return null;
  return askCall(answer, labels, question);
}

/** The ask_choice call for the likeliest labelled readings, or null below two chips. */
export function askCall<K extends string>(
  answer: Pick<DecisionChoiceAnswer<K>, 'probabilities'>,
  labels: Partial<Record<K, string>>,
  question: string,
): OnDeviceToolCall | null {
  const ask = buildAskChoice(answer, labels, question);
  if (!ask) return null;
  const input: KevAskInput = { ...ask, readings: ask.options.map((o) => readingFromTap(o, labels) ?? '') };
  return { name: ASK_CHOICE_TOOL, input: input as unknown as Record<string, unknown> };
}

/**
 * Consent rule over Kev: an agree_to_card read from a message that says no
 * somewhere ("no wait, don't apply that yet") is never applied. Null when the
 * rule does not apply; otherwise the calls to send instead of applying: the
 * agree / decline chips, or nothing at all.
 */
export function vetoNegatedAgree(
  intent: string,
  message: string,
  answer: Pick<DecisionChoiceAnswer<string>, 'probabilities'>,
  labels: Partial<Record<string, string>>,
  question: string,
): OnDeviceToolCall[] | null {
  if (intent !== 'agree_to_card' || !negates(message)) return null;
  const ask = askCall(answer, { agree_to_card: labels.agree_to_card, decline_card: labels.decline_card }, question);
  return ask ? [ask] : [];
}

export function newTrace(): KevTrace {
  return { intent: '', source: 'kev', asked: false, wrote: false, decideMs: 0, writeMs: 0 };
}

/** One decide() call, timed into the trace. */
export async function timedDecide<T>(trace: KevTrace, run: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await run();
  } finally {
    trace.decideMs += Date.now() - start;
  }
}

/**
 * The built-in model's writing for this turn, or null when it refused, failed
 * or returned nothing usable. The caller then sends its fixed reply: the user
 * never sees an error from this step.
 */
export async function write<T extends Record<string, unknown>>(
  ports: KevPorts,
  trace: KevTrace,
  call: { system: string; schema: JsonSchema; context: string; history: readonly ChatTurn[] },
): Promise<T | null> {
  const start = Date.now();
  try {
    const prompt = renderPrompt(call.context, call.history, await ports.budget(call.system, call.schema));
    const value = await ports.write<T>(call.system, prompt, call.schema);
    if (!value || typeof value !== 'object') return null;
    trace.wrote = true;
    return value;
  } catch {
    return null;
  } finally {
    trace.writeMs += Date.now() - start;
  }
}

/** The writer's reply text, or the fixed reply. */
export function replyOr(value: { reply?: unknown } | null, fallback: string): string {
  const reply = typeof value?.reply === 'string' ? value.reply.trim() : '';
  return reply || fallback;
}

/** The decision block for the writer's prompt. */
export function decisionBlock(lines: string): string {
  return `How Mera read the message:\n${lines}`;
}
