// The wait line's phase -> phrase-pool registry.
//
// PURE DATA: i18n KEY STRINGS only, no `t()` and no JSX, so a test can read
// this file and assert every key against `en.json` directly without standing
// up a translation runtime. A mocked translator makes any `t()`-based copy
// test pass; a file read cannot be faked.
//
// Same shape as `components/custom/processing/processing-stages.ts`, which is
// the sibling surface this one is modelled on.

import { CHAT_PHASE_IDS, type ChatPhaseId } from '@/lib/services/chat-phase';

export interface ChatPhaseDef {
  readonly id: ChatPhaseId;
  readonly phrasesKey: string;
}

export const CHAT_PHASES = [
  { id: 'preparing', phrasesKey: 'chatPhases.preparing' },
  { id: 'queued', phrasesKey: 'chatPhases.queued' },
  { id: 'securing', phrasesKey: 'chatPhases.securing' },
  { id: 'attesting', phrasesKey: 'chatPhases.attesting' },
  { id: 'thinking', phrasesKey: 'chatPhases.thinking' },
  { id: 'retrying', phrasesKey: 'chatPhases.retrying' },
  { id: 'deviceLoading', phrasesKey: 'chatPhases.deviceLoading' },
  { id: 'devicePreparing', phrasesKey: 'chatPhases.devicePreparing' },
  { id: 'deviceThinking', phrasesKey: 'chatPhases.deviceThinking' },
] as const satisfies readonly ChatPhaseDef[];

export type PhaseDef = (typeof CHAT_PHASES)[number];

/**
 * The pool rendered when nothing has been published yet.
 *
 * Not a "loading" placeholder: it is the honest first thing every turn does on
 * both engines, which is why an unpublished turn can safely show it.
 *
 * ITS POOL MUST STAY ENGINE-NEUTRAL. It is a cloud-ordered id, but the `idle`
 * view renders it on the on-device engine too, where a line mentioning
 * encryption or a server would be a false claim. The device honesty check in
 * `__tests__/chat-phases.test.ts` covers the three `device*` pools, so this
 * one needs its own assertion and has one.
 */
export const OPENING_PHASE_ID: ChatPhaseId = 'preparing';

/**
 * The rotation rhythm, stated as the two numbers a reader actually cares about
 * rather than as one period they have to do arithmetic on.
 *
 * A sentence is fully legible for `PHASE_LINE_HOLD_MS`, then the swap to the
 * next one takes `PHASE_TRANSITION_MS` end to end: half fading the old line
 * out, half fading the new one in. `PHASE_CYCLE_MS` is derived, so changing
 * either number cannot leave the interval and the fade disagreeing.
 *
 * A full second of crossfade is unusually slow for a UI transition and that is
 * the point: this text is read, not glanced at, and a quick swap under a
 * reader's eye is what makes cycling copy feel like a flickering spinner.
 */
export const PHASE_LINE_HOLD_MS = 2000;
export const PHASE_TRANSITION_MS = 1000;
/** Each half of the crossfade. */
export const FADE_MS = PHASE_TRANSITION_MS / 2;
/** Interval between swaps: the legible hold plus both halves of the fade. */
export const PHASE_CYCLE_MS = PHASE_LINE_HOLD_MS + PHASE_TRANSITION_MS;

export function chatPhaseDef(id: ChatPhaseId): PhaseDef {
  const found = CHAT_PHASES.find((p) => p.id === id);
  // Unreachable: `ChatPhaseId` is a closed union and the table is exhaustive
  // over it, asserted in `__tests__/chat-phases.test.ts` ("the registry covers
  // every phase id").
  if (!found) throw new Error(`[chat-phase] unknown phase ${id}`);
  return found;
}

/** Re-exported so the registry test can assert exhaustiveness in one import. */
export { CHAT_PHASE_IDS };
