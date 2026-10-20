// harness-local — follow-story option quality, one turn at a time. Pure.
//
// A turn FAILS on any of:
//   copied-example  an option's label or search is a prompt example (cloud prompts'
//                   literal examples, plus any denylisted string), compared normalised
//   count           fewer than 3 or more than 4 options (the RAW count, before the
//                   schema reader cuts a fifth option)
//   no-entity       no option's label or search shares a content word with the source
//                   (article title and description, or the user's own message)
//   not-widening    option 1's search does not share the most source words: the
//                   options must run from the narrow event to the broad story
//   ended-season    an option names a year before today's, or a season span that has ended

export type OptionCheck = 'copied-example' | 'count' | 'no-entity' | 'not-widening' | 'ended-season';
export const OPTION_CHECKS: readonly OptionCheck[] = ['copied-example', 'count', 'no-entity', 'not-widening', 'ended-season'];

/** The literal option examples in the cloud follow-story and article prompts. */
export const PROMPT_EXAMPLES: readonly string[] = [
  'Attacks on Ukraine infrastructure',
  'Russia Ukraine civilian infrastructure attacks',
  'Russia–Ukraine war',
  'Russia Ukraine war',
  'European security crisis',
  'Europe Russia security military tensions',
];

export interface OptionTurn {
  /** What the options must be about: the article's title and description, or the user's message. */
  source: string;
  options: { label: string; search: string }[];
  /** Options the model returned before any cut. Defaults to options.length. */
  rawCount?: number;
  /** YYYY-MM-DD. */
  today: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with',
  'is', 'are', 'was', 'be', 'this', 'that', 'it', 'its', 'i', 'my', 'me', 'you', 'your', 'we', 'our',
  'want', 'follow', 'following', 'keep', 'up', 'story', 'stories', 'news', 'latest', 'about', 'new',
]);

/** Lowercase content words, a trailing plural s dropped (not ss). */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[‐-―-]/g, ' ').replace(/\s+/g, ' ').trim();

function overlap(text: string, source: Set<string>): number {
  let n = 0;
  for (const w of contentWords(text)) if (source.has(w)) n++;
  return n;
}

/**
 * A year before today's, or a season span (2025-26, 2025/2026) ending in today's
 * year or earlier.
 * ponytail: a span ending this year counts as ended (football and school seasons end
 * mid-year); a calendar-year competition still running in this year's span would be a
 * false fail. Add per-competition season ends if that shows up.
 */
export function namesEndedSeason(text: string, today: string): boolean {
  const year = Number(today.slice(0, 4));
  for (const m of text.matchAll(/\b((?:19|20)\d{2})\s*[-/–]\s*((?:19|20)?\d{2})\b/g)) {
    const end = m[2].length === 2 ? Math.floor(Number(m[1]) / 100) * 100 + Number(m[2]) : Number(m[2]);
    if (end <= year) return true;
  }
  const stripped = text.replace(/\b(?:19|20)\d{2}\s*[-/–]\s*(?:19|20)?\d{2}\b/g, ' ');
  for (const m of stripped.matchAll(/\b((?:19|20)\d{2})\b/g)) if (Number(m[1]) < year) return true;
  return false;
}

export function scoreOptions(turn: OptionTurn, denylist: readonly string[] = PROMPT_EXAMPLES): OptionCheck[] {
  const fails: OptionCheck[] = [];
  const banned = new Set(denylist.map(norm));
  const opts = turn.options;
  if (opts.some((o) => banned.has(norm(o.label)) || banned.has(norm(o.search)))) fails.push('copied-example');
  const count = turn.rawCount ?? opts.length;
  if (count < 3 || count > 4) fails.push('count');
  const source = contentWords(turn.source);
  const scores = opts.map((o) => overlap(`${o.label} ${o.search}`, source));
  if (!scores.some((s) => s > 0)) fails.push('no-entity');
  const searchScores = opts.map((o) => overlap(o.search, source));
  if (opts.length > 1 && searchScores.slice(1).some((s) => s > searchScores[0])) fails.push('not-widening');
  if (opts.some((o) => namesEndedSeason(`${o.label} ${o.search}`, turn.today))) fails.push('ended-season');
  return fails;
}

export interface OptionSummary {
  turns: number;
  passed: number;
  byCheck: Record<OptionCheck, number>;
}

export function summarise(verdicts: OptionCheck[][]): OptionSummary {
  const byCheck = Object.fromEntries(OPTION_CHECKS.map((c) => [c, 0])) as Record<OptionCheck, number>;
  for (const v of verdicts) for (const c of v) byCheck[c] += 1;
  return { turns: verdicts.length, passed: verdicts.filter((v) => v.length === 0).length, byCheck };
}
