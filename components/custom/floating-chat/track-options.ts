// The follow card's option list and per-row outcomes: pure, no RN.
//
// The card's tool-result override carries what the staged call cannot know:
// `cardOptions` (the list after More options grew it), `followed` (each row's
// outcome, written after each follow) and `dismissed` (Not now). The deriver
// reads them here, so a resumed chat redraws the card the reader left.

import { MAX_FOLLOW_OPTIONS } from '@/lib/chat-session/engine';
// The eval's own "too close" rule (eval/track-metrics.ts): one tokenizer, pure.
import { contentJaccard, DETECT_JACCARD } from '@/lib/mera-harness';

/** A card never grows past this: the engine contract's own cap. */
export const MAX_TRACK_CARD_OPTIONS = MAX_FOLLOW_OPTIONS;

export interface TrackOption {
  label: string;
  search: string;
}

export type TrackOutcome = 'following' | 'already' | 'failed';

/** Trimmed, lower case, whitespace collapsed: the key for labels and search texts alike. */
export function normaliseTrackText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * New options appended after the shown ones. An incoming option is a duplicate
 * when its label OR its search text matches one already on the card (or one
 * earlier in the same answer), or its label is a near-copy of one (content-word
 * Jaccard >= 0.6), so a reworded label adds nothing.
 */
export function mergeTrackOptions(
  shown: readonly TrackOption[],
  incoming: readonly TrackOption[],
  cap = MAX_TRACK_CARD_OPTIONS,
): { options: TrackOption[]; added: number } {
  const labels = new Set(shown.map((o) => normaliseTrackText(o.label)));
  const searches = new Set(shown.map((o) => normaliseTrackText(o.search)));
  const options = [...shown];
  for (const o of incoming) {
    if (options.length >= cap) break;
    const label = normaliseTrackText(o.label);
    const search = normaliseTrackText(o.search);
    if (!label || labels.has(label) || (search && searches.has(search))) continue;
    if (options.some((k) => contentJaccard(o.label, k.label) >= DETECT_JACCARD)) continue;
    labels.add(label);
    if (search) searches.add(search);
    options.push(o);
  }
  return { options, added: options.length - shown.length };
}

/**
 * The persisted `cardOptions`, or null when absent or malformed. A shape check
 * only: the options were cleaned when they were staged or merged.
 */
export function readCardOptions(raw: unknown): TrackOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TrackOption[] = [];
  for (const entry of raw) {
    const rec = entry as Record<string, unknown> | null;
    const label = typeof rec?.label === 'string' ? rec.label.trim() : '';
    if (!label) continue;
    const search = typeof rec?.search === 'string' && rec.search.trim() ? rec.search.trim() : label;
    out.push({ label, search });
    if (out.length >= MAX_TRACK_CARD_OPTIONS) break;
  }
  return out.length > 0 ? out : null;
}

/** The persisted `followed` map (normalised label to outcome); unknown values dropped. */
export function readTrackOutcomes(raw: unknown): Record<string, TrackOutcome> {
  const out: Record<string, TrackOutcome> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === 'following' || value === 'already' || value === 'failed') out[key] = value;
  }
  return out;
}

export type TrackCardStatus = 'pending' | 'followed' | 'dismissed' | 'expired';

/**
 * What the card shows. A card with a followed row is resolved and never flips
 * to expired; a failed row keeps it pending (Try again); only a card replaced
 * by a newer proposeTrack expires, and only while nothing on it was followed.
 */
export function trackCardStatus(input: {
  outcomes: Record<string, TrackOutcome>;
  dismissed: boolean;
  superseded: boolean;
}): TrackCardStatus {
  const values = Object.values(input.outcomes);
  const succeeded = values.some((v) => v !== 'failed');
  const failed = values.includes('failed');
  if (succeeded && (!failed || input.dismissed || input.superseded)) return 'followed';
  if (input.dismissed) return 'dismissed';
  if (input.superseded) return 'expired';
  return 'pending';
}
