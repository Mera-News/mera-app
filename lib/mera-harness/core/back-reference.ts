// mera-harness/core: the recent conversation, and messages that point back at
// it. PURE, RN-free.
//
// "Okay, I want to follow this" after an answer, "add that to my interests",
// "my parents live there": the subject is in the previous exchange, and the
// loop used to send that exchange to `conversation/*` legs only, so the route
// leg and every fact leg read a message with no subject (owner report). The
// last two exchanges now ride on EVERY leg, with the rule for using them inside
// the block itself, so one copy of the rule reaches every skill.

import { escapeUntrusted } from './state-line';

export const MAX_RECENT_EXCHANGES = 2;
const RECENT_USER_CHARS = 500;
const RECENT_REPLY_CHARS = 900;
const MAX_SUBJECTS = 6;
const SUBJECT_CHARS = 120;

export interface RecentExchange {
  user: string;
  reply: string;
}

/**
 * Our own scaffolding tags, stripped to a fixpoint before escaping: a reply can
 * restate a web result, and a result is publisher text. Same shapes as
 * news-harness's STRUCTURAL_TAG (the harness cannot import it), plus the tags
 * only this loop writes.
 */
const STRUCTURAL_TAG =
  /<\/?(?:context|tool_call|system|user|assistant|surface|state|known_facts|filters|recent)\b[^>]*>|<function=[^>]*>|<parameter=[^>]*>|<\/(?:function|parameter)\s*>/gi;

export function escapeRecent(raw: string, maxLength: number): string {
  let current = raw ?? '';
  for (let pass = 0; pass < 8; pass++) {
    const next = current.replace(STRUCTURAL_TAG, '');
    if (next === current) return escapeUntrusted(current, maxLength);
    current = next;
  }
  return '';
}

/** The exchange the reader just saw, appended; only the last two are kept. */
export function withExchange(
  recent: readonly RecentExchange[],
  user: string,
  reply: string,
): RecentExchange[] {
  return [...recent, { user, reply }].slice(-MAX_RECENT_EXCHANGES);
}

/** What a turn was about, newest first, deduplicated and bounded. */
export function subjectsOf(items: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = (raw ?? '').trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s.slice(0, SUBJECT_CHARS));
    if (out.length >= MAX_SUBJECTS) break;
  }
  return out;
}

/**
 * Words that point back at the conversation, in the app's main languages.
 * Matched as whole tokens. Articles that double as pronouns ("het", "die",
 * "das") are left out: they would mark half of all Dutch and German messages.
 * Used ONLY to widen what a forced offer may be grounded in; the model reads
 * the block whatever this says.
 */
const BACK_WORDS = new Set([
  'this', 'that', 'it', 'there', 'these', 'those', 'them', 'same',
  'dit', 'dat', 'daar', 'deze',
  'dies', 'diese', 'dieser', 'dort', 'darüber', 'davon',
  'ça', 'cela', 'ceci', 'là',
  'esto', 'eso', 'esa', 'ese', 'allí', 'ahí', 'allá',
  'isso', 'isto', 'lá',
  'यह', 'ये', 'इसे', 'इस', 'इसको', 'इसी', 'वह', 'वो', 'उसे', 'उस', 'उसको', 'वहाँ', 'वहां',
]);

export function pointsBack(message: string): boolean {
  return (message ?? '')
    .toLowerCase()
    .split(/[\s,.!?;:"“”'’()]+/)
    .some((w) => BACK_WORDS.has(w));
}

/** The block every leg carries, or null when there is nothing earlier. */
export function renderRecentBlock(recent: readonly RecentExchange[], lastSubjects: readonly string[]): string | null {
  if (recent.length === 0) return null;
  const lines = recent.flatMap((x) => [
    `They said: ${escapeRecent(x.user, RECENT_USER_CHARS)}`,
    ...(x.reply.trim() ? [`You replied: ${escapeRecent(x.reply, RECENT_REPLY_CHARS)}`] : []),
  ]);
  const about = lastSubjects.length > 0
    ? `\nLast turn was about: ${lastSubjects.map((s) => escapeRecent(s, SUBJECT_CHARS)).join('; ')}`
    : '';
  return '<recent>\n'
    + 'The recent conversation, oldest first. Use it ONLY when the message below points back at it '
    + '("this", "that", "it", "there", "the story you mentioned", in any language). Then:\n'
    + '1. Take the subject from "Last turn was about"; if that is missing, from your last reply.\n'
    + '2. Do what the message asks with that subject, as if they had named it.\n'
    + 'If the message does not point back, never offer, save or follow anything from this block.\n'
    + `${lines.join('\n')}${about}\n</recent>`;
}
