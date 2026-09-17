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

  if (input.similarFactCount !== null) {
    parts.push(
      input.similarFactCount === 0
        ? 'Similar facts: none.'
        : `Similar facts: ${input.similarFactCount}.`,
    );
  }

  if (input.resolvedChoiceText) {
    parts.push(`They chose: ${escapeUntrusted(input.resolvedChoiceText, 80)}.`);
  }

  if (input.answerPending) {
    parts.push('They did not answer your last question. Offer, do not ask again.');
  }

  return parts.join(' ');
}
