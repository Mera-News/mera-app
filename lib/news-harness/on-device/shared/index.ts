// Shared pieces of the on-device chat flows (D27, D31): the identity line, the
// token budget and the conversation renderer. Pure and RN-free, so the harness
// builds exactly the prompts the phone sends.

import { proposalRequiresUserChoice } from '../../core/proposals';
import type { StagedProposal } from '../../core/types';
import { asUntrusted } from '../../prompts/untrusted-text';

/** Every on-device instruction opens with this. A built-in model otherwise names its maker. */
export const IDENTITY_LINE =
  'You are Mera, made by Mera. Never say another company made you or name the AI model.';

/** Output ceiling for one on-device chat turn: a short reply plus a few fields. */
export const ON_DEVICE_CHAT_MAX_TOKENS = 512;

/** Gemini Nano refuses input of 4,000 tokens or more; every engine is sized for it. */
const INPUT_TOKEN_CEILING = 4000;
/** contextSize() is null when the built-in model cannot say; assume the smallest window. */
const FALLBACK_CONTEXT_TOKENS = 4096;
/** Room for the structured retry's reminder line and chat-template overhead. */
const RESERVE_TOKENS = 96;

/**
 * A deliberately high token count: 3 ASCII characters per token, and one token
 * per other character. The app's estimateTokens assumes 4 characters per token
 * for everything but CJK, which undercounts Devanagari, Arabic or Cyrillic
 * badly against the built-in models' tokenizers.
 */
export function countTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other;
}

/** The largest n in 0..max with fits(n), for a `fits` that stays true below any n where it holds. */
export function largestFitting(max: number, fits: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Tokens left for the prompt (context plus conversation) once the system
 * instructions, the schema and the reply are paid for. `contextSize` is the
 * toolkit's value: the whole window for Apple and Qwen, the input limit for
 * Nano, so `contextSize - maxTokens` is safe on all three.
 */
export function promptBudgetTokens(params: {
  contextSize: number | null;
  maxTokens: number;
  system: string;
  schemaJson?: string;
}): number {
  const window = Math.min(INPUT_TOKEN_CEILING, (params.contextSize ?? FALLBACK_CONTEXT_TOKENS) - params.maxTokens);
  return window - RESERVE_TOKENS - countTokens(params.system) - countTokens(params.schemaJson ?? '');
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The prompt for one turn: the context block, then as much of the conversation
 * as fits in `budgetTokens`, dropping the oldest turns first. The last user turn
 * always stays, cut to fit when even it alone is too long.
 */
export function renderPrompt(context: string, history: readonly ChatTurn[], budgetTokens: number): string {
  const head = context ? `${context}\n\nConversation:` : 'Conversation:';
  let left = budgetTokens - countTokens(head) - 1;
  const lines: string[] = [];
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    let line = `${turn.role === 'user' ? 'User' : 'Mera'}: ${turn.content.trim()}`;
    const cost = countTokens(line) + 1;
    if (cost > left) {
      if (i !== lastUser) break;
      // Cut by characters until it fits: never more than the budget allows.
      while (line.length > 0 && countTokens(line) + 1 > left) line = line.slice(0, Math.floor(line.length * 0.9));
      if (line) lines.unshift(line);
      break;
    }
    lines.unshift(line);
    left -= cost;
  }
  return `${head}\n${lines.join('\n')}`;
}

/** The reply-language rule, plus the one punctuation rule for user-facing copy. */
export function languageLine(languageName?: string): string {
  const language = languageName
    ? `Always write your reply in ${languageName}, even if the user writes in another language.`
    : "Write your reply in the user's language.";
  return `${language} Never use a dash in your reply.`;
}

/** One executor tool an on-device turn asks the app to run, by its existing name and input shape. */
export interface OnDeviceToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** What a structured on-device turn resolves to: the reply for the bubble and the tools to run. */
export interface OnDeviceTurnResult {
  reply: string;
  calls: OnDeviceToolCall[];
}

/** Trimmed string or '' for anything that is not a string. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Whitespace-separated words, for the label and search word caps. */
export function capWords(value: string, max: number): string {
  return value.split(/\s+/).filter(Boolean).slice(0, max).join(' ');
}

/**
 * The card still waiting on the user, for the context block. A card of
 * alternatives (story options, choose-one) is picked by a tap only, so the
 * model is told its yes does nothing there.
 */
export function describePending(proposal: StagedProposal | null | undefined): string | null {
  if (!proposal || proposal.actions.length === 0) return null;
  const labels = proposal.actions.map((a) => (a.type === 'track_story' ? a.label : '')).filter(Boolean);
  const what = asUntrusted(labels.length > 0 ? labels.join('; ') : proposal.explanation, 400);
  return proposalRequiresUserChoice(proposal)
    ? `A card on screen offers: ${what}. The user picks one by tapping it; a typed yes cannot apply it.`
    : `A change is waiting for the user's yes or no: ${what}`;
}
