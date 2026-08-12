// The screen-title size for the Feed and Dashboard headers, chosen from the
// window width.
//
// These two titles share a row with the status mark, the importance filter chip
// and (on the Dashboard) the notification bell. At a fixed `4xl` (36px) that row
// ran out of width on a standard phone and "Dashboard" truncated to "Dasbo…" —
// and a screen title that cannot say its own name is worse than a smaller one.
//
// Two mechanisms, and they cover different failures:
//   • This function picks the CEILING from the window width, so a phone starts
//     smaller and a tablet keeps the full display size.
//   • `adjustsFontSizeToFit` + `minimumFontScale` at the call site handle the
//     rest, because the real variable is not the screen, it is the WORD:
//     "Feed" and "Dashboard" fit where "Tableau de bord" and "Bảng điều khiển"
//     do not, and no breakpoint can know that.
//
// ⚠️ `adjustsFontSizeToFit` is only safe because the title box cannot collapse.
// `ExploreScreen.tsx:453-462` records what happens when it can: a `flex-shrink`
// title column in a `justify-between` row collapsed toward zero and scale-to-fit
// then shrank the text to ~8px. The floor below is the backstop for that — past
// it the title ellipsises rather than becoming unreadable, which is the less bad
// of the two failures.

/** Below this window width the display size does not fit the header row. */
const COMPACT_WIDTH = 400;

export type HeaderTitleSize = '3xl' | '4xl';

/**
 * `4xl` (36px) where there is room, `3xl` (30px) on a compact phone.
 *
 * Deliberately two steps rather than a continuous ramp: the type scale carries
 * a matched lineHeight per step (tailwind.config.js), and interpolating the
 * size without it reintroduces the clipped-descender bug that scale exists to
 * prevent for Devanagari and Thai.
 */
export function headerTitleSize(windowWidth: number): HeaderTitleSize {
    return windowWidth >= COMPACT_WIDTH ? '4xl' : '3xl';
}

/**
 * How far `adjustsFontSizeToFit` may shrink before the title gives up and
 * ellipsises. 0.75 of `3xl` is ~22px — still unmistakably a screen title.
 */
export const HEADER_TITLE_MIN_SCALE = 0.75;
