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
  { id: 'webSearch', phrasesKey: 'chatPhases.webSearch' },
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
 * `test/unit/chat/chat-phases.test.ts` covers the three `device*` pools, so this
 * one needs its own assertion and has one.
 */
export const OPENING_PHASE_ID: ChatPhaseId = 'preparing';

export function chatPhaseDef(id: ChatPhaseId): PhaseDef {
  const found = CHAT_PHASES.find((p) => p.id === id);
  // Unreachable: `ChatPhaseId` is a closed union and the table is exhaustive
  // over it, asserted in `test/unit/chat/chat-phases.test.ts` ("the registry covers
  // every phase id").
  if (!found) throw new Error(`[chat-phase] unknown phase ${id}`);
  return found;
}

/** Re-exported so the registry test can assert exhaustiveness in one import. */
export { CHAT_PHASE_IDS };

/**
 * The wait row RESERVES two lines and may grow to three (owner ruling ux2 M4),
 * so the longer locales read the phase copy in full. The reservation, not the
 * cap, is what keeps a short line from moving the thread.
 */
export const WAIT_LINE_MAX_LINES = 3;

/** The wait line's line height for most scripts (see `phaseLineHeight`). */
export const WAIT_LINE_HEIGHT = 21;

/**
 * The wait line's line height per script. Devanagari and Thai stack marks
 * above and below the line, and Arabic carries marks too, so 21pt clips them.
 */
const TALL_SCRIPT_LINE_HEIGHT: Readonly<Record<string, number>> = { hi: 25, th: 25, ar: 24 };

export function phaseLineHeight(language: string): number {
  return TALL_SCRIPT_LINE_HEIGHT[language.split('-')[0]] ?? WAIT_LINE_HEIGHT;
}

/** The strip's drawn height. It never scales vertically (width scales only
 *  below 272pt), so every height below can assume it. */
export const STRIP_HEIGHT = 32;
/** The wait row's width: the 272pt strip plus the bubble's 14pt text insets. */
export const WAIT_ROW_WIDTH = 272 + 28;
const ROW_PAD = 8;
const WORDS_GAP = 6;
/** Lines reserved for the words: three under the cloud strip, two beside the
 *  phone on device. */
export const CLOUD_WORD_LINES = 3;
export const DEVICE_WORD_LINES = 2;

/**
 * The wait row's height, which a streaming reply also holds so the thread
 * never moves at the first token. Computed, never a constant: the words grow
 * with the reader's text size and with the script.
 *
 * Cloud: pad + strip + [gap + 3 lines] + pad, so 117 with words and 48
 * without at 1x in English. Device: one row, the phone beside two lines of
 * words, so 58 at 1x.
 */
export function waitRowHeight(input: {
  showWords: boolean;
  engine: 'cloud' | 'local';
  /** The effective text scale (OS font scale, capped, times the app's own). */
  textScale: number;
  language: string;
}): number {
  const line = phaseLineHeight(input.language) * input.textScale;
  if (input.engine === 'local') {
    return ROW_PAD * 2 + Math.max(STRIP_HEIGHT, DEVICE_WORD_LINES * line);
  }
  const words = input.showWords ? WORDS_GAP + CLOUD_WORD_LINES * line : 0;
  return ROW_PAD * 2 + STRIP_HEIGHT + words;
}
