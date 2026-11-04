// The turn that tells the reader a fact is gone. The app has already removed it
// (a topic run completed empty), so this is one tool-free leg: never routed,
// never a user message, and nothing it says can stage or change anything.
//
// The note is the system prompt, not a message, so it cannot reach `<recent>`.
// The reply is checked in code, and a bad one gives way to the caller's fixed
// line: prose emphasis is not a lever on this model.

import { withExchange } from './back-reference';
import { claimsChangeHappened, claimsSaveHappened, cleanProse, leaksInternals, trailingQuestion } from './prose';
import { voiceRules } from './router-prompt';
import { escapeUntrusted } from './state-line';
import type { AgentModelRequest, AgentModelResult, AgentTurnState } from './types';

const REPLY_MAX_TOKENS = 300;

export function factRemovedPrompt(statements: readonly string[], languageName?: string): string {
  const facts = statements.map((s) => `"${escapeUntrusted(s, 200)}"`).join(', ');
  return `You are Mera. You keep a news profile for the user.

The app has already removed from their profile: ${facts}. It could not make any news topics from it. That is done and nothing else changed.

Write one short message that does these three things, in this order:
1. Says you removed it, quoting it exactly as written above.
2. Says why: you could not turn it into news topics. If the fact itself shows a clear reason, add it in a few plain words, such as that it describes the person rather than a subject the news covers. If no reason is clear, say only the first part. Never invent a reason.
3. Asks what they would like you to save instead.

Do not apologise. Do not offer anything else. Never say you saved or added anything.

${voiceRules(languageName)}`;
}

const fold = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The prompt's own English phrases, in a reply that should not be English. Quoted facts stay English. */
const ENGLISH_REPLY = /\b(?:i removed|i have removed|news topics|would you like)\b/i;

/** Staging wrote Dutch in English and Hindi in Latin letters, 2 of 3 runs each, despite the rule. */
function inTheReaderLanguage(reply: string, languageName?: string): boolean {
  if (!languageName || languageName === 'English') return true;
  if (languageName === 'Hindi' && !/\p{Script=Devanagari}/u.test(reply)) return false;
  return !ENGLISH_REPLY.test(reply);
}

/** Names every fact, asks something, and carries no leak or false claim. */
export function factRemovedReplyOk(reply: string, statements: readonly string[], languageName?: string): boolean {
  const text = fold(reply);
  return (
    text.length > 0 &&
    inTheReaderLanguage(reply, languageName) &&
    /[?？؟]/.test(reply) &&
    statements.every((s) => text.includes(fold(s))) &&
    !leaksInternals(reply) &&
    !claimsSaveHappened(reply) &&
    !claimsChangeHappened(reply)
  );
}

/**
 * One leg. A stopped call resolves with an empty reply, a transport failure
 * throws to the caller's failed-turn path, and `turn` learns the reply as an
 * exchange with no user half, so the next message reads as its answer.
 */
export async function runFactRemovedTurn(params: {
  statements: readonly string[];
  languageName?: string;
  callModel(req: AgentModelRequest): Promise<AgentModelResult>;
  /** The fixed line, in the reader's language. */
  fallback: string;
  turn?: AgentTurnState | null;
}): Promise<{ reply: string; usedFallback: boolean; stopped: boolean }> {
  const called = await params.callModel({
    role: 'reply',
    model: 'BIG',
    systemPrompt: factRemovedPrompt(params.statements, params.languageName),
    messages: [{ role: 'user', content: `Write the message now${params.languageName ? `, in ${params.languageName}` : ''}.` }],
    tools: [],
    maxTokens: REPLY_MAX_TOKENS,
    enableThinking: false,
  });
  if (called.error) return { reply: '', usedFallback: false, stopped: true };

  const text = cleanProse(called.content);
  const usedFallback = called.truncated || !factRemovedReplyOk(text, params.statements, params.languageName);
  const reply = usedFallback ? params.fallback : text;
  if (params.turn) {
    params.turn.lastReply = reply;
    params.turn.lastQuestion = trailingQuestion(reply);
    params.turn.recentExchanges = withExchange(params.turn.recentExchanges, '', reply);
  }
  return { reply, usedFallback, stopped: false };
}
