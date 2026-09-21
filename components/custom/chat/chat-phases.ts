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
 */
export const OPENING_PHASE_ID: ChatPhaseId = 'preparing';

/** How long the newest phase waits before it may replace a just-painted one. */
export const MIN_PHASE_MS = 600;
/** How long one sentence stays up before the pool advances. */
export const PHASE_CYCLE_MS = 2800;
/** Crossfade half-life, matching the processing area's. */
export const FADE_MS = 220;

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
