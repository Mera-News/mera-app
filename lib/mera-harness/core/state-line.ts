// mera-harness/core — the one short state line the loop writes for itself.
// PURE, RN-free.
//
// This replaces chat history on every leg. It is BETTER than history for the
// purpose: it states what the loop actually established, rather than making the
// model re-derive it from a transcript that windowing may have truncated
// mid-pair. It also costs ~40 tokens against the 1,500 a history window took.

import type { Place } from './types';

/** Escape-only, for values that came from the user or the model. Tool results
 *  are framed as "here is what the lookup returned", not "here is the article",
 *  so they take NO nonce fence -- only escaping. */
export function escapeUntrusted(raw: string, maxLength = 200): string {
  const truncated = (raw ?? '').slice(0, maxLength);
  return truncated
    .replace(/</g, '< ')
    .replace(/>/g, ' >')
    .replace(/\n+/g, ' ')
    .trim();
}

export interface StateLineInput {
  routeKind: string | null;
  resolvedPlaces: Place[] | null;
  similarFactCount: number | null;
  /** Computed by the LOOP from turn state, never reported by the model. */
  answerPending: boolean;
  /** What the user tapped on the previous turn, if anything. */
  resolvedChoiceText: string | null;
  /** The question the PREVIOUS turn ended on. Present whenever there was one,
   *  answered or not: this message is most likely its answer, and without the
   *  text the model is classifying a fragment. See AgentTurnState.lastQuestion. */
  lastQuestion?: string | null;
  /** Statements ALREADY on file that find_similar_facts returned this turn. */
  existingFacts?: { factId: string; statement: string }[];
  /** The forced-proposal leg. Says plainly that nothing has been proposed. */
  forcedProposal?: boolean;
  /** The user typed a plain yes to this question. The turn resumed its skill
   *  so the subject survives; the model is told to do what the question
   *  offered and say in one sentence what it offered. */
  answeredYesTo?: string | null;
  /** Several subjects in one message: this leg handles one of them. */
  segmentScope?: { mine: string; others: string[]; questionPending: boolean } | null;
}

export function buildStateLine(input: StateLineInput): string {
  const parts: string[] = [];

  parts.push(
    input.routeKind
      ? `Handling: ${escapeUntrusted(input.routeKind, 60)}.`
      : 'Handling: not yet classified.',
  );

  if (input.resolvedPlaces && input.resolvedPlaces.length > 0) {
    // Every interpolated value is escaped: the literal scaffolding is ours,
    // the values are not.
    const chain = (p: Place) =>
      [p.neighbourhood, p.locality, p.admin1, p.countryName, p.bloc]
        .filter(Boolean)
        .map((v) => escapeUntrusted(String(v), 60))
        .join(', ');

    if (input.resolvedPlaces.length === 1) {
      parts.push(`Place resolved: ${chain(input.resolvedPlaces[0])}.`);
    } else {
      // The LABELS, quoted and separately from the chains.
      //
      // This used to render only the comma-joined chains, and on the ambiguous
      // fixture the model answered `ask_choice` with `options: []` in most
      // repeats even though the candidates reached it twice over (here and in
      // the tool result). Asking it to derive a <60-char chip label from
      // "Amsterdam, North Holland, Netherlands, EU" is a transformation it was
      // silently failing; handing it the exact strings removes the step.
      const labels = input.resolvedPlaces
        .map((p) => `"${escapeUntrusted(p.neighbourhood || p.locality, 60)}"`)
        .join(', ');
      parts.push(
        `Place is AMBIGUOUS, ${input.resolvedPlaces.length} candidates. `
        + `Call ask_choice with exactly these options: ${labels}. `
        + `Full chains: ${input.resolvedPlaces.map(chain).join(' | ')}.`,
      );
    }
  }

  if (input.existingFacts && input.existingFacts.length > 0) {
    // LABELLED, because the unlabelled list read as material to work from and
    // the model echoed one back as its "new" fact, or narrated it as a
    // confirmation. On device it "confirmed" a Rotterdam fact the user had
    // replaced two turns earlier.
    const rows = input.existingFacts
      .map((f) => `[${escapeUntrusted(f.factId, 40)}] "${escapeUntrusted(f.statement, 160)}"`)
      .join('; ');
    parts.push(
      `EXISTING facts already on file, never re-propose these: ${rows}. `
      + 'To change one, propose the NEW statement and set replaces to the matching id.',
    );
  } else if (input.similarFactCount !== null) {
    parts.push('Similar facts: none.');
  }

  if (input.resolvedChoiceText) {
    parts.push(`They chose: ${escapeUntrusted(input.resolvedChoiceText, 80)}.`);
  }

  if (input.segmentScope) {
    const others = input.segmentScope.others.map((k) => escapeUntrusted(k, 30)).join(', ');
    parts.push(
      `This message has several subjects. You handle only the ${escapeUntrusted(input.segmentScope.mine, 30)} part`
      + (others ? `; other guidelines handle ${others}. Offer nothing about those.` : '.'),
    );
    if (input.segmentScope.questionPending) {
      parts.push(
        'A question about another part is already waiting for the user. Ask nothing: if a reading '
        + 'is uncertain, put the other readings in alternatives.',
      );
    }
  }

  if (input.answeredYesTo) {
    parts.push(
      `They answered yes to your question: "${escapeUntrusted(input.answeredYesTo, 160)}". `
      + 'Do what that question offered now, and say in one short sentence what you are offering. '
      + 'A yes is never permission to delete anything.',
    );
  }

  if (input.forcedProposal) {
    parts.push(
      'You have not proposed anything yet. Propose the fact now or ask one choice question.',
    );
  }

  // THE PREVIOUS QUESTION, and the answer-pending guard, as ONE block.
  //
  // They were two lines and the second asserted something the loop cannot know.
  // `answerPending` is true for any turn that is not a chip tap, so a typed
  // answer was announced to the model as "they did not answer", while the
  // question itself was never sent at all. Stating the question and leaving the
  // reading to the model is both true and the thing that was missing; the
  // do-not-repeat half of the guard is kept verbatim, because that half works.
  if (input.lastQuestion && !input.answeredYesTo) {
    parts.push(
      `Your last turn asked: "${escapeUntrusted(input.lastQuestion, 160)}". `
      + 'This message is most likely its answer, so read it that way if it can be. '
      + 'Never ask that question again.',
    );
  } else if (input.answerPending) {
    parts.push('They did not answer your last question. Offer, do not ask again.');
  }

  return parts.join(' ');
}
