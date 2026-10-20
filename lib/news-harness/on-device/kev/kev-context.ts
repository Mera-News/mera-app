// Layer 3 (D41): Kev's decision as a few plain-English lines for the writer's
// prompt. Never JSON and never a model name: the built-in model echoes what it
// reads. One line per question, in a stable order, for example
//
//   What the user wants: remove a saved fact (very likely, 0.91)
//   The fact they mean: "Lives in Porto" (likely, 0.74)
//
// Pure and RN-free. The relevance line reads the score answer's own legend, so
// nothing here imports the relevance model's questions.

import type {
  DecisionAnswer,
  DecisionChoiceAnswer,
  DecisionNoulAnswer,
  DecisionQuestion,
  DecisionQuestions,
  DecisionScoreAnswer,
} from 'llama.rn';
import { margin, ranked, UNSURE_MIN_MARGIN } from './decision';

/** Above the default cap the block starts eating the writer's 4,000-token input. */
const DEFAULT_MAX_CHARS = 600;
/** One option description in a line; the criteria texts are authored short. */
const MAX_OPTION_CHARS = 120;

export function confidenceWord(p: number): 'very likely' | 'likely' | 'unsure' {
  return p >= 0.8 ? 'very likely' : p >= 0.6 ? 'likely' : 'unsure';
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('').trimEnd()}...`;
}

function fallbackText(key: string): string {
  return key.replace(/_/g, ' ');
}

interface LineOptions {
  /** Option key to its words; defaults to the key with spaces for underscores. */
  describe?: (key: string) => string;
  /** Put the option words in double quotes (a fact statement), for all keys or per key. */
  quote?: boolean | ((key: string) => boolean);
}

/** "Label: words (likely, 0.74)", plus ", or maybe: words (0.61)" when the runner-up is within 0.2. */
export function choiceLine(
  label: string,
  answer: Pick<DecisionChoiceAnswer, 'probabilities'> & { choice?: string },
  { describe = fallbackText, quote = false }: LineOptions = {},
  keyOrder?: readonly string[],
): string {
  const [first, second] = ranked(answer, keyOrder);
  if (!first) return `${label}: nothing decided`;
  const words = (key: string) => {
    const text = clip(describe(key), MAX_OPTION_CHARS);
    return (typeof quote === 'function' ? quote(key) : quote) ? `"${text}"` : text;
  };
  let line = `${label}: ${words(first.key)} (${confidenceWord(first.p)}, ${first.p.toFixed(2)})`;
  if (second && margin(answer) < UNSURE_MIN_MARGIN) {
    line += `, or maybe: ${words(second.key)} (${second.p.toFixed(2)})`;
  }
  return line;
}

/** Choice criteria as a describe function: the description, or the key in words when it is null. */
function criteriaWords(criteria: Record<string, string | null>) {
  return (key: string) => criteria[key] ?? fallbackText(key);
}

/** What the user wants, from the intent question. */
export function intentLine(
  answer: DecisionChoiceAnswer,
  criteria: Record<string, string | null>,
  label = 'What the user wants',
): string {
  return choiceLine(label, answer, { describe: criteriaWords(criteria) }, Object.keys(criteria));
}

/** The saved fact they mean, quoted. `noneKey` (default 'none') reads as no saved fact. */
export function targetFactLine(
  answer: DecisionChoiceAnswer,
  criteria: Record<string, string | null>,
  { label = 'The fact they mean', noneKey = 'none' }: { label?: string; noneKey?: string } = {},
): string {
  const describe = criteriaWords(criteria);
  return choiceLine(
    label,
    answer,
    {
      describe: (k) => (k === noneKey ? 'none of the saved facts' : describe(k)),
      // A quoted "none" would read as a fact called none.
      quote: (k) => k !== noneKey,
    },
    Object.keys(criteria),
  );
}

/** A score answer (the relevance question) as its likeliest level's words, from the answer's legend. */
export function relevanceLine(answer: DecisionScoreAnswer, label = 'How relevant this is to them'): string {
  return choiceLine(
    label,
    { probabilities: answer.probabilities },
    { describe: (level) => answer.legend[level] ?? `level ${level}` },
    Object.keys(answer.legend),
  );
}

function noulLine(label: string, answer: DecisionNoulAnswer, criteria?: { true?: string | null; false?: string | null }) {
  const yes = answer.noul >= 0.5;
  return choiceLine(
    label,
    { probabilities: { true: answer.noul, false: 1 - answer.noul }, choice: yes ? 'true' : 'false' },
    { describe: (k) => (k === 'true' ? criteria?.true ?? 'yes' : criteria?.false ?? 'no') },
    ['true', 'false'],
  );
}

export interface FormatOptions {
  /** Question id to the line's label. Defaults to the id in words. */
  labels?: Record<string, string>;
  /** Question ids whose option words are quoted (a target fact). */
  quote?: readonly string[];
  /** Line order; the default is the questions object's own order. */
  order?: readonly string[];
  /** Lines after the decision, dropped first when over the cap. */
  extra?: readonly string[];
  maxChars?: number;
}

function lineFor(id: string, question: DecisionQuestion, answer: DecisionAnswer, opts: FormatOptions): string | null {
  const label = opts.labels?.[id] ?? fallbackText(id);
  if (question.type === 'choice' && answer.type === 'choice') {
    return choiceLine(
      label,
      answer,
      { describe: criteriaWords(question.criteria), quote: opts.quote?.includes(id) },
      Object.keys(question.criteria),
    );
  }
  if (question.type === 'score' && answer.type === 'score') return relevanceLine(answer, label);
  if (question.type === 'noul' && answer.type === 'noul') return noulLine(label, answer, question.criteria);
  return null;
}

/**
 * The whole decision as one block. Questions with no answer are skipped. Over
 * `maxChars`, extra lines go first, then decision lines from the end; a line
 * that alone is over the cap is cut and ends in "...".
 */
export function formatDecision(
  questions: DecisionQuestions,
  answers: Partial<Record<string, DecisionAnswer>>,
  opts: FormatOptions = {},
): string {
  const ids = opts.order ?? Object.keys(questions);
  const lines: string[] = [];
  for (const id of ids) {
    const question = questions[id];
    const answer = answers[id];
    if (!question || !answer) continue;
    const line = lineFor(id, question, answer, opts);
    if (line) lines.push(line);
  }
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const all = [...lines, ...(opts.extra ?? [])];
  while (all.length > 1 && all.join('\n').length > max) all.pop();
  return all.length === 1 ? clip(all[0], max) : all.join('\n');
}
