// "More options" on a follow card, on the phone: ONE built-in model call, no
// Kev, no history. RN-free; the app and the harness pass their own writer.

import type { JsonSchema } from '../../../mera-protocol-toolkit/core/structured-json';
import type { ProposalAction, TrackFeedbackSubject } from '../../core/types';
import { asUntrusted } from '../../prompts/untrusted-text';
import { IDENTITY_LINE, renderPrompt } from '../shared';
import { trackOptions } from './parse';
import { TRACK_OPTION_RULES } from './prompt';
import { TRACK_OPTIONS_SCHEMA } from './schema';
import { DEVICE_SLOTS } from '../../../harnesses/slots';
import { render } from '../../../harnesses/template';

export type MoreOptionsReason = 'none' | 'busy' | 'failed' | 'stopped';

export interface MoreTrackOptionsInput {
  /** YYYY-MM-DD. */
  today: string;
  shown: { label: string; searchText: string }[];
  room: number;
  subject: TrackFeedbackSubject;
  /** The article chat's article, when there is one. */
  articleTitle?: string;
}

export interface MoreTrackOptionsPorts {
  write<T extends Record<string, unknown>>(system: string, prompt: string, schema: JsonSchema): Promise<T>;
  budget(system: string, schema: JsonSchema): Promise<number>;
}

export const MORE_OPTIONS_SYSTEM = render(DEVICE_SLOTS["follow-story/more-options-system"], { IDENTITY_LINE });

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: { options: TRACK_OPTIONS_SCHEMA },
  required: ['options'],
};

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The new options' texts, filtered against the card by label or search and capped at `room`; null when the writer failed. */
export async function writeMoreTrackOptions(
  input: Omit<MoreTrackOptionsInput, 'subject'>,
  ports: MoreTrackOptionsPorts,
): Promise<{ label: string; search: string }[] | null> {
  const shownLabels = asUntrusted(input.shown.map((s) => s.label).join('; '), 400);
  const context = [
    `Option rules: ${TRACK_OPTION_RULES}`,
    input.articleTitle ? `Article: ${asUntrusted(input.articleTitle, 160)}` : `Story: ${shownLabels}`,
    `Already on the card, write different ones: ${shownLabels}`,
    `Today: ${input.today}`,
  ].join('\n\n');
  let raw: { options?: unknown } | null;
  try {
    raw = await ports.write<{ options?: unknown }>(
      MORE_OPTIONS_SYSTEM,
      renderPrompt(context, [], await ports.budget(MORE_OPTIONS_SYSTEM, SCHEMA)),
      SCHEMA,
    );
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const seenLabels = new Set(input.shown.map((s) => norm(s.label)));
  const seenSearches = new Set(input.shown.map((s) => norm(s.searchText)));
  const out: { label: string; search: string }[] = [];
  for (const o of trackOptions(raw.options)) {
    if (out.length >= input.room) break;
    const label = norm(o.label);
    const search = norm(o.search || o.label);
    if (seenLabels.has(label) || seenSearches.has(search)) continue;
    seenLabels.add(label);
    seenSearches.add(search);
    out.push({ label: o.label, search: o.search || o.label });
  }
  return out;
}

export async function runMoreTrackOptions(
  input: MoreTrackOptionsInput,
  ports: MoreTrackOptionsPorts,
): Promise<{ actions: Extract<ProposalAction, { type: 'track_story' }>[]; reason?: MoreOptionsReason }> {
  const more = await writeMoreTrackOptions(input, ports);
  if (!more) return { actions: [], reason: 'failed' };
  const actions = more.map((o) => ({ type: 'track_story' as const, label: o.label, searchText: o.search, subject: input.subject }));
  return actions.length > 0 ? { actions } : { actions: [], reason: 'none' };
}
