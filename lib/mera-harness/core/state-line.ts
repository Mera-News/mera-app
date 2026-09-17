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
    const rendered = input.resolvedPlaces
      .map((p) =>
        [p.neighbourhood, p.locality, p.admin1, p.countryName, p.bloc]
          .filter(Boolean)
          .map((s) => escapeUntrusted(String(s), 60))
          .join(', '),
      )
      .join(' | ');
    parts.push(
      input.resolvedPlaces.length === 1
        ? `Place resolved: ${rendered}.`
        : `Place candidates (${input.resolvedPlaces.length}): ${rendered}.`,
    );
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
