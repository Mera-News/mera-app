// A chip list of DISTINCT FACTS, as opposed to readings of one ambiguous thing.
//
// Owner rule (ux1): distinct facts are never a pick-one. Measured on the
// Android dev build: "I live in niew West Amsterdam and I'm an expat from
// india" came back as "Which fact should I offer to save?" with the chips
// "You are an expat" / "You are from India" / "You live in New West,
// Amsterdam". The loop turns such a question into cards for all of them, and
// a chip list that still reaches the user carries "Save all".
//
// PURE and shared: the loop and AskChoiceCard must agree on what a fact pick
// is and on the exact text a "Save all" tap sends, or the tap is not
// recognised.

import type { Place } from './types';

/** "I mean Porto", "I'll write it", "I want the first one": a reply about the
 *  question, never a fact. */
const HEDGES = new Set([
  'mean', 'meant', 'want', 'wanted', 'prefer', 'would', 'will', 'do', 'did', 'does',
  "don't", 'dont', "didn't", 'can', 'could', 'should', 'need', 'think', 'guess',
  'not', 'just', 'only', 'choose', 'pick',
]);

/** The option with its subject normalised: "you are ...", "you live ...". */
function subjectless(option: string): string[] | null {
  const t = option
    .trim()
    .replace(/^(you|i)['’]re\b/i, 'you are')
    .replace(/^i['’]m\b/i, 'i am')
    .replace(/[.!?]+$/, '');
  const m = /^(?:you|i)\s+(.+)$/i.exec(t);
  if (!m) return null;
  const words = m[1].split(/\s+/).filter(Boolean);
  if (words.length === 0 || HEDGES.has(words[0].toLowerCase())) return null;
  return words;
}

/**
 * True when every option states a separate fact about the user. Two options
 * with the same opening ("live in" twice) are READINGS of one thing, as is an
 * option naming one of several looked-up places.
 */
export function isFactPickChoice(options: unknown, candidates: readonly Place[] = []): boolean {
  if (!Array.isArray(options) || options.length < 2) return false;
  if (!options.every((o) => typeof o === 'string')) return false;
  const heads = new Set<string>();
  for (const option of options as string[]) {
    const words = subjectless(option);
    if (!words) return false;
    const head = words.slice(0, 2).join(' ').toLowerCase();
    if (heads.has(head)) return false;
    heads.add(head);
    if (candidates.length >= 2) {
      const lower = option.toLowerCase();
      if (candidates.some((c) => lower.includes(c.locality.toLowerCase()))) return false;
    }
  }
  return true;
}

function thirdPerson(verb: string): string {
  const v = verb.toLowerCase();
  if (v === 'have') return 'has';
  if (v === 'do' || v === 'go') return `${v}es`;
  if (/(?:s|sh|ch|x|z|o)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A chip written as a fact: "You are from India" gives "From India", "You
 *  live in X" gives "Lives in X", "You work at X" gives "Works at X". */
export function factPickStatement(option: string): string {
  const words = subjectless(option);
  if (!words) return option.trim();
  const [first, ...rest] = words;
  if (/^(?:are|am)$/i.test(first)) {
    const body = rest.join(' ').replace(/^(?:an?|the)\s+/i, '');
    return capitalise(body);
  }
  return capitalise([thirdPerson(first), ...rest].join(' '));
}

/** The exact text a "Save all" tap sends: every option as its own sentence. */
export function joinFactPick(options: readonly string[]): string {
  return options.map((o) => `${o.trim().replace(/[.!?]+$/, '')}.`).join(' ');
}
