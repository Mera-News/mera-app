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
 * Words that point back at the conversation, in the app's 20 languages.
 * Spaced scripts match whole tokens; Japanese, Chinese, Thai and Korean write
 * without spaces (or attach particles), so their demonstratives match as
 * substrings. Articles that double as pronouns ("het", "die", "das", "lo",
 * "la") are left out: they would mark half of all messages in their language.
 * Used ONLY to widen what a forced offer may be grounded in; the model reads
 * the block whatever this says.
 */
const BACK_WORDS = new Set([
  // en
  'this', 'that', 'it', 'there', 'these', 'those', 'them', 'same',
  // nl
  'dit', 'dat', 'daar', 'deze', 'daarover', 'ervan',
  // de
  'dies', 'diese', 'dieser', 'dieses', 'dort', 'dorthin', 'darüber', 'davon', 'damit',
  // fr
  'ça', 'cela', 'ceci', 'là', 'celui-ci', 'celle-ci', 'y',
  // es
  'esto', 'eso', 'esa', 'ese', 'esta', 'este', 'allí', 'ahí', 'allá',
  // it
  'questo', 'questa', 'quello', 'quella', 'ciò', 'lì',
  // pt-BR
  'isso', 'isto', 'aquilo', 'lá', 'aí', 'esse', 'essa', 'nele', 'nela',
  // id
  'ini', 'itu', 'sana', 'situ', 'tersebut',
  // pl
  'to', 'tego', 'tym', 'tam', 'tamto', 'tę', 'tej',
  // tr
  'bu', 'bunu', 'bunun', 'şu', 'şunu', 'o', 'onu', 'orada', 'oraya',
  // ru
  'это', 'этот', 'эта', 'эти', 'этого', 'этом', 'там', 'туда', 'него',
  // uk
  'це', 'цей', 'ця', 'ці', 'цього', 'цьому', 'там', 'туди', 'нього',
  // vi
  'này', 'đó', 'kia', 'nó',
  // ar
  'هذا', 'هذه', 'ذلك', 'تلك', 'هناك', 'ذاك', 'عنه', 'عنها',
  // hi
  'यह', 'ये', 'इसे', 'इस', 'इसको', 'इसी', 'वह', 'वो', 'उसे', 'उस', 'उसको', 'वहाँ', 'वहां',
]);

/** Demonstratives in scripts written without spaces between words. */
const BACK_SUBSTRINGS = [
  // ja
  'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'そこ', 'あそこ',
  // zh-CN, zh-TW
  '这个', '那个', '这些', '那些', '这件', '那件', '这条', '那条', '那里', '那儿',
  '這個', '那個', '這些', '這件', '這條', '那裡', '那兒', '它',
  // th
  'นี้', 'นั่น', 'นั้น', 'มัน',
  // ko (particles attach, so the stem is matched)
  '이것', '그것', '저것', '이거', '그거', '거기', '그곳',
];

export function pointsBack(message: string): boolean {
  const text = (message ?? '').toLowerCase();
  return (
    text.split(/[\s,.!?;:"“”'’()。、！？「」]+/).some((w) => BACK_WORDS.has(w))
    || BACK_SUBSTRINGS.some((w) => text.includes(w))
  );
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
