// Layer 1 of "Kev decides, the built-in model writes" (D38): a flow's typed
// question to Kev, run as ONE decide() call, plus the readers every flow shares.
// Pure and RN-free: the app passes the toolkit's decide() (llama lock inside),
// the harness passes a local Kev. Type imports from llama.rn are erased at
// runtime.

import type {
  DecisionChoiceAnswer,
  DecisionContent,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
} from 'llama.rn';
import type { JsonSchema } from '../../../mera-protocol-toolkit/core/structured-json';

/** One decide() call. App: toolkit `decide` (takes the llama lock, not
 *  re-entrant, so never call it from inside withLlamaLock). Harness: local Kev. */
export type DecidePort = <R extends DecisionRequest>(request: R) => Promise<DecisionResult<R['questions']>>;

/** The built-in model writing a reply to a schema. Resolves to the parsed object;
 *  a refusal or a parse failure rejects, and the flow falls back to a fixed reply. */
export type WriterPort = <T extends Record<string, unknown>>(
  system: string,
  prompt: string,
  schema: JsonSchema,
) => Promise<T>;

export type DecisionAnswers<Q extends DecisionQuestions> = DecisionResult<Q>['answers'];

/**
 * A flow's decision. `questions` holds 1-2 questions, and a choice question
 * lists an option only when it applies (agree_to_card only with a card
 * pending). Each question is a full read of the state, about 0.6 s on the
 * phone, and each must stay under 4,096 prompt tokens.
 * Choice keys that look like numbers sort first: prefix them ('f1', not '1').
 */
export interface DecisionSpec<I, D, Q extends DecisionQuestions = DecisionQuestions> {
  /** The small labelled object Kev reads. An object renders as `key: value` lines. */
  state(input: I): DecisionContent;
  questions(input: I): Q;
  read(answers: DecisionAnswers<Q>, input: I): D;
}

export interface DecisionRun<D, Q extends DecisionQuestions> {
  decision: D;
  /** Kept for kev-context's formatDecision, which needs the option descriptions. */
  questions: Q;
  answers: DecisionAnswers<Q>;
}

/** Exactly one decide() call. A follow-up (the target fact) is a second spec,
 *  run only when the first decision needs it. */
export async function runDecision<I, D, Q extends DecisionQuestions>(
  spec: DecisionSpec<I, D, Q>,
  input: I,
  decide: DecidePort,
): Promise<DecisionRun<D, Q>> {
  const questions = spec.questions(input);
  const result = await decide({ state: spec.state(input), questions });
  const answers = result.answers as DecisionAnswers<Q>;
  return { decision: spec.read(answers, input), questions, answers };
}

/**
 * D39: below this top probability Mera asks instead of acting. D39 set 0.6 and 0.2;
 * P6d moved them on the dev split (ask rate and accuracy both improved). Kev answers
 * at its GGUF temperature (2.4), so its probabilities are soft: over 5 to 7 options a
 * clear reading often tops out near 0.5.
 */
export const UNSURE_MIN_CONFIDENCE = 0.4;
/** D39: a top-2 gap below this is a close call, so Mera asks. */
export const UNSURE_MIN_MARGIN = 0.15;

export interface Ranked<K extends string = string> {
  key: K;
  p: number;
}

/**
 * Options by probability, highest first. `probabilities` has no guaranteed key
 * order, so a tie goes to the order of `keyOrder` (pass the question's criteria
 * keys), then to the key Kev chose, then to plain key order.
 */
export function ranked<K extends string>(
  answer: Pick<DecisionChoiceAnswer<K>, 'probabilities'> & { choice?: K },
  keyOrder?: readonly string[] | Record<string, unknown>,
): Ranked<K>[] {
  const order: readonly string[] = Array.isArray(keyOrder) ? keyOrder : keyOrder ? Object.keys(keyOrder) : [];
  const pos = (k: K) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return (Object.entries(answer.probabilities) as [K, number][])
    .map(([key, p]) => ({ key, p }))
    .sort(
      (a, b) =>
        b.p - a.p
        || pos(a.key) - pos(b.key)
        || (a.key === answer.choice ? -1 : b.key === answer.choice ? 1 : 0)
        || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
}

/** The likeliest option, or null for an answer with no options. */
export function top<K extends string>(
  answer: Pick<DecisionChoiceAnswer<K>, 'probabilities'> & { choice?: K },
  keyOrder?: readonly string[] | Record<string, unknown>,
): Ranked<K> | null {
  return ranked(answer, keyOrder)[0] ?? null;
}

/** Top probability minus the runner-up's. A lone option has margin = its own p.
 *  Rounded to 1e-9 so 0.6 - 0.4 reads as 0.2, not 0.19999999999999996. */
export function margin(answer: Pick<DecisionChoiceAnswer, 'probabilities'>): number {
  const [first, second] = ranked(answer);
  return first ? Math.round((first.p - (second?.p ?? 0)) * 1e9) / 1e9 : 0;
}

/**
 * D39 "unsure": the top option's probability is under `minConfidence`, or its
 * lead over the runner-up is under `minMargin`. Read from the probabilities,
 * NOT from Kev's `confidence` field: that one is a spread measure (0 = all
 * options equally likely, 1 = one option has all the mass), so with many
 * options it stays low even when one option clearly leads.
 */
export function isUnsure(
  answer: Pick<DecisionChoiceAnswer, 'probabilities'>,
  { minConfidence = UNSURE_MIN_CONFIDENCE, minMargin = UNSURE_MIN_MARGIN } = {},
): boolean {
  const first = top(answer);
  if (!first) return true;
  return first.p < minConfidence || margin(answer) < minMargin;
}
