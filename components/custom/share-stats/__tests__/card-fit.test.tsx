// The on-screen card must be the same SHAPE as the exported one.
//
// This test exists because the first attempt was not. The cards lived in a
// Dashboard pane that had already spent its vertical budget on a collapsing
// header, a stats sentence, a sub-tab row, dots, a pill and a tab bar, so a
// 360x640 portrait host was simply CLIPPED by the pager's bounds. Measured off
// a 1206x2622 screenshot the visible card was about 1081x937, a ratio of 1.15
// against the export's 0.76 — it read as a landscape card with its heatmap
// sliced mid-row. Nothing had been resized; it had been cropped.
//
// A full-screen route removed the cause. This keeps it removed.

// card-shell imports AbstractGradientBackdrop and MeraLogo, and through them
// reanimated, whose native side does not exist under jest: the suite dies on
// "Native part of Worklets doesn't seem to be initialized" with a stack
// pointing at an import line. Same two stubs every other suite here uses. The
// functions under test are pure arithmetic and render nothing.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));

import {
  EXPORT_WIDTH,
  INK_BOX_ASPECT,
  INK_BOX_HEIGHT_PX,
  fitCardToPage,
} from '../card-shell';
import {
  DOTS_ALLOWANCE,
  HEADER_ALLOWANCE,
  PILL_ALLOWANCE,
} from '../screen-metrics';

/** Real viewports in points, shortest first. The 3 GB floor device is the one
 *  that decides whether the ratio-fitted card is still readable. */
const VIEWPORTS = [
  { name: 'iPhone SE (floor)', width: 320, height: 568, top: 20, bottom: 0 },
  { name: 'iPhone 8', width: 375, height: 667, top: 20, bottom: 0 },
  { name: 'iPhone 13 mini', width: 375, height: 812, top: 50, bottom: 34 },
  { name: 'Pixel 5', width: 393, height: 851, top: 24, bottom: 24 },
  { name: 'iPhone 16 Pro Max', width: 440, height: 956, top: 62, bottom: 34 },
];

function pageBoxFor(v: (typeof VIEWPORTS)[number]) {
  return {
    width: v.width,
    height: v.height - v.top - v.bottom - HEADER_ALLOWANCE - DOTS_ALLOWANCE - PILL_ALLOWANCE,
  };
}

describe('the on-screen card preserves the export ratio', () => {
  it('has the ratio the export box states', () => {
    expect(INK_BOX_ASPECT).toBeCloseTo(EXPORT_WIDTH / INK_BOX_HEIGHT_PX, 10);
    expect(INK_BOX_ASPECT).toBeCloseTo(1080 / 1420, 10);
  });

  for (const v of VIEWPORTS) {
    it(`${v.name}: width over height equals 1080/1420 within a pixel`, () => {
      const fitted = fitCardToPage(pageBoxFor(v));
      // Within a pixel at the device's own scale, not within a point.
      const ratio = fitted.width / fitted.height;
      expect(ratio).toBeCloseTo(1080 / 1420, 4);
      expect(Math.abs(fitted.width - fitted.height * (1080 / 1420))).toBeLessThan(1 / 3);
    });

    it(`${v.name}: fits inside the page without cropping`, () => {
      const box = pageBoxFor(v);
      const fitted = fitCardToPage(box);
      // No dimension may exceed the page: overflow IS the crop.
      expect(fitted.width).toBeLessThanOrEqual(box.width + 0.001);
      expect(fitted.height).toBeLessThanOrEqual(box.height + 0.001);
      // And it must not be degenerate, or "fits" is vacuously true.
      expect(fitted.width).toBeGreaterThan(0);
      expect(fitted.height).toBeGreaterThan(0);
    });

    it(`${v.name}: letterboxes rather than stretching`, () => {
      const box = pageBoxFor(v);
      const fitted = fitCardToPage(box);
      // Height-bound is the expected case: the card is narrower than the page
      // and the slack is horizontal. If width ever binds instead, the card is
      // SMALLER, never wider than the page.
      const heightBound = Math.abs(fitted.height - box.height) < 0.001;
      const widthBound = Math.abs(fitted.width - box.width) < 0.001;
      expect(heightBound || widthBound).toBe(true);
    });
  }

  it('exercises BOTH binding regimes across real viewports', () => {
    // Non-vacuity, and it corrects an assumption worth recording: the binding
    // dimension is NOT always height. On SHORT devices (SE, iPhone 8) the page
    // is wider than 1080/1420 wants, so height binds and the card letterboxes
    // HORIZONTALLY — narrower than the page, slack either side. On tall modern
    // phones the page is tall enough that the ratio wants a card wider than the
    // screen, so WIDTH binds and the letterboxing is VERTICAL instead.
    //
    // Both are correct and both must stay reachable, or a future change to the
    // allowances could silently push every device into one regime and this
    // suite would keep passing while only half the code was ever run.
    const regimes = VIEWPORTS.map((v) => {
      const box = pageBoxFor(v);
      const fitted = fitCardToPage(box);
      return Math.abs(fitted.height - box.height) < 0.001 ? 'height' : 'width';
    });
    expect(regimes).toContain('height');
    expect(regimes).toContain('width');
  });

  it('stays legible on the floor device', () => {
    // If this ever fails the answer is NOT to crop or shrink type: it is that
    // the card set needs splitting, and it should be reported rather than
    // absorbed.
    const se = fitCardToPage(pageBoxFor(VIEWPORTS[0]));
    expect(se.height).toBeGreaterThan(300);
    expect(se.width).toBeGreaterThan(228);
  });

  it('returns nothing rather than a negative card for a degenerate page', () => {
    expect(fitCardToPage({ width: 0, height: 400 })).toEqual({ width: 0, height: 0 });
    expect(fitCardToPage({ width: 320, height: -50 })).toEqual({ width: 0, height: 0 });
    expect(fitCardToPage({ width: Number.NaN, height: 400 })).toEqual({ width: 0, height: 0 });
  });
});
