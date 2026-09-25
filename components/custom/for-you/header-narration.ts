// The header narration's pool -> phrase-key registry, and its rhythm.
//
// PURE DATA: i18n KEY STRINGS only, no `t()` and no JSX, so a test can read
// this file and assert every key against all twenty dictionaries directly
// without standing up a translation runtime. The global i18n mock makes any
// `t()`-based copy test pass against a dictionary that lacks the key; a file
// read cannot be faked.
//
// Same shape as `components/custom/chat/chat-phases.ts` and
// `components/custom/processing/processing-stages.ts`, which are the two
// sibling surfaces this one is modelled on.

import {
  HEADER_STAGE_POOL_IDS,
  type HeaderNarrationPoolId,
  type HeaderStagePoolId,
} from '@/lib/services/header-narration';

/** Every pool key, stage pools plus the one nudge pool. */
export const HEADER_NARRATION_KEYS: Record<HeaderNarrationPoolId, string> = {
  starting: 'headerNarration.stages.starting',
  fetching: 'headerNarration.stages.fetching',
  downloading: 'headerNarration.stages.downloading',
  grouping: 'headerNarration.stages.grouping',
  analysing: 'headerNarration.stages.analysing',
  onDevice: 'headerNarration.stages.onDevice',
  summarising: 'headerNarration.stages.summarising',
  preparing: 'headerNarration.stages.preparing',
  nudges: 'headerNarration.nudges',
};

/**
 * ONE stable label for the whole rotating line.
 *
 * Deliberately not the sentence currently on screen, and deliberately NOT an
 * `accessibilityLiveRegion` — unlike the chat wait line, which is a focused
 * wait on one element. Here the reader is working a list, and a region that
 * announced a new sentence every four seconds would talk over them.
 */
export const HEADER_NARRATION_A11Y_KEY = 'headerNarration.a11y' as const;

/**
 * The rotation rhythm, stated as the two numbers a reader cares about rather
 * than as one period they have to do arithmetic on.
 *
 * A sentence is fully legible for `NARRATION_HOLD_MS`, then the swap takes
 * `NARRATION_TRANSITION_MS` end to end: half fading the old line out, half
 * fading the new one in. `NARRATION_CYCLE_MS` is DERIVED, so changing either
 * number cannot leave the interval and the fade disagreeing.
 *
 * Held a second longer than the chat wait line's 2000ms. That line is read by
 * someone staring at one bubble waiting for it; this one sits above a list the
 * reader is actively scrolling, so it has to survive being glanced at rather
 * than watched.
 */
export const NARRATION_HOLD_MS = 3700;
/**
 * 300ms end to end, 150ms each way. It was 1000: the line sits at opacity near
 * zero for the middle of every fade, which measured 1.1:1 against the header
 * mid-fade, so a long fade was a second of unreadable text out of every four.
 * The cycle stays 4000ms.
 */
export const NARRATION_TRANSITION_MS = 300;
/** Each half of the crossfade. */
export const NARRATION_FADE_MS = NARRATION_TRANSITION_MS / 2;
/** Interval between swaps: the legible hold plus both halves of the fade. */
export const NARRATION_CYCLE_MS = NARRATION_HOLD_MS + NARRATION_TRANSITION_MS;

/**
 * The ONE line colour, as a literal. White: the previous rgb 190 measured
 * 3.6:1 on the header over a warm backdrop, white 6.7:1. In `style`, never a
 * class, so a theme token cannot invert it.
 */
export const NARRATION_COLOR = '#FFFFFF';

/**
 * The widest the narration can be where it is shown: INLINE on the Feed,
 * between the "?" and the `[mark] [bell]` cluster, per width step (the
 * `headerTitleSize` breakpoint). Derived for English: row (window - 40) less
 * the title, the "?" footprint (24), the mark's layout box, the bell (24),
 * three ~7pt row gaps and HEADER_ACTIONS_GAP (25).
 *   400pt+ (402): 362 - 82.1 - 24 - 18.1 - 24 - 21 - 25 = ~168
 *   compact (375): 335 - 68.7 - 24 - 15.1 - 24 - 21 - 25 = ~157
 * `narration-widths.json` is every line in every locale measured with CoreText
 * at 14pt. At 400pt+ every line must fit (the test is strict); on compact
 * phones a bounded few lines take a "…" (owner decision), never a second line.
 */
export const NARRATION_INLINE_WIDTH_PT_WIDE = 168;
export const NARRATION_INLINE_WIDTH_PT_COMPACT = 157;

/**
 * The line's typography and its wrap budget, in ONE place because the row
 * height is pinned from the same numbers. Only the Feed narrates, one line
 * inline in its title row.
 *
 * `2 x 21 = 42`, against a `3xl` title's 45pt line box, is where the copy's
 * 46-character English ceiling comes from. A third line does not fit and is
 * not allowed to be reached: `HeaderNarrationLine` clamps to `MAX_LINES` and
 * the copy test keeps every locale short enough that the clamp never fires.
 *
 * NOT `adjustsFontSizeToFit`. `header-title-size.ts:21-27` records that
 * collapsing text to ~8px in a shrinkable column, which is the worse failure.
 */
export const HEADER_NARRATION_METRICS = {
  fontSize: 14,
  lineHeight: 21,
  maxLines: 2,
} as const;

/** Re-exported so the registry test can assert exhaustiveness in one import. */
export { HEADER_STAGE_POOL_IDS };
export type { HeaderNarrationPoolId, HeaderStagePoolId };
