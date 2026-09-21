// The screen-title size for the Feed and Dashboard headers, chosen from the
// window width.
//
// These two titles share a row with the status mark and (on the Dashboard) the
// notification bell. At a fixed `4xl` (36px) that row ran out of width on a
// standard phone and "Dashboard" truncated to "Dasbo…" — and a screen title
// that cannot say its own name is worse than a smaller one.
//
// The row also carried a High/Med/Low importance chip when these breakpoints
// were measured; that chip is gone, so there is more slack than the numbers
// below assume. They are deliberately NOT retuned on that basis: the binding
// constraint was never the chip but the WORD, and "Bảng điều khiển" at 36px is
// exactly as wide as it was.
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

/**
 * The matched lineHeight for each step, from `tailwind.config.js:250-251`.
 *
 * Duplicated as numbers here because a `style={{ height }}` needs one and the
 * class-name pipeline does not hand it back. `__tests__/header-title-size.test.ts`
 * READS the tailwind config at test time and asserts these two against it, so
 * the duplication cannot rot silently the way a copied literal usually does.
 */
const TITLE_LINE_HEIGHT: Record<HeaderTitleSize, number> = {
  '3xl': 45,
  '4xl': 54,
};

/**
 * The height to PIN the title row to, from the same breakpoint as the size.
 *
 * ── Why the row is pinned at all ────────────────────────────────────────────
 *
 * The row's height is `max()` over its children and the Heading is that max:
 * 54 at `4xl`, 45 at `3xl`, against a 22pt status mark and a 45pt bell. While
 * a sync runs the title is REPLACED by a two-line 14/21 narration box, which
 * is 42 — so the row would shrink by 3 to 12 points at the start of every run
 * and grow back at the end. That fires `onHeaderLayout`, changes
 * `headerHeight`, and moves the list's `contentContainerStyle.paddingTop` and
 * `progressViewOffset` UNDER THE READER, twice per sync, on both tabs and on
 * all four Dashboard sub-tabs.
 *
 * Reserving two lines inside the narration box does not fix it: the row
 * collapses to its tallest REMAINING child, and with the title gone that is
 * the 22pt mark. The height has to be on the row.
 *
 * Applied UNCONDITIONALLY, in both states. A height that only appears while
 * narrating is the same bug with extra steps.
 *
 * It must come from `headerTitleSize`'s own breakpoint and not a second copy
 * of it, or a future tablet step moves the title and leaves the pin behind.
 */
export function headerTitleLineHeight(windowWidth: number): number {
  return TITLE_LINE_HEIGHT[headerTitleSize(windowWidth)];
}
