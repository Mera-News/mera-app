import {
  LIST_END_RESERVE,
  MERA_BUTTON_BAR_GAP,
  MERA_BUTTON_SIZE,
  TAB_BAR_HEIGHT,
  listEndClearance,
  meraButtonBottom,
  tabBarClearance,
  foldTabBarTop,
  TAB_CONTENT_END_GAP,
  tabBarOverlap,
  tabContentBottomInset,
  tabBarTopFromBottom,
} from '../tab-bar';

describe('tabBarClearance', () => {
  it('on iOS returns the tab inset alone, because it already includes the bar', () => {
    // NativeTabs gives each tab its own SafeAreaProvider; on a Face ID iPhone
    // the bottom inset there is ~85 (bar + home indicator), not 34.
    expect(tabBarClearance('ios', 85)).toBe(85);
  });

  it('on iOS never adds TAB_BAR_HEIGHT, whatever the inset', () => {
    for (const inset of [0, 34, 83, 85]) {
      expect(tabBarClearance('ios', inset)).not.toBe(inset + TAB_BAR_HEIGHT);
    }
  });

  it('on Android returns zero: the tab content area already ends at the bar', () => {
    // Measured on the API 35 emulator (gesture nav): list viewports end exactly
    // at the bar's top edge, with a 24dp inset and an 80.4dp bar.
    expect(tabBarClearance('android', 24)).toBe(0);
  });

  it('puts an in-tab FAB 20dp above the Android bar, not the measured 99.8', () => {
    const FAB_OFFSET = 20;
    // The old sum reproduced the capture: 20 + 24 + 56 = 100 (measured 99.8).
    expect(FAB_OFFSET + 24 + TAB_BAR_HEIGHT_ANDROID).toBe(100);
    expect(FAB_OFFSET + tabBarClearance('android', 24)).toBe(20);
  });

  it('pads an in-tab Android list end by 24 over the bar, nothing more', () => {
    expect(tabBarClearance('android', 24) + 24).toBe(24);
  });
});

/** The Android value of TAB_BAR_HEIGHT; the module constant reads the jest
 *  platform (ios), so the capture arithmetic states it explicitly. */
const TAB_BAR_HEIGHT_ANDROID = 56;

describe('listEndClearance', () => {
  it('derives the design 172pt on a Face ID iPhone tab (inset 85 includes the bar)', () => {
    expect(LIST_END_RESERVE).toBe(MERA_BUTTON_BAR_GAP + MERA_BUTTON_SIZE + 12);
    expect(listEndClearance('ios', 85)).toBe(172);
  });

  it('on Android reserves only the button stack above the bar', () => {
    expect(listEndClearance('android', 24)).toBe(LIST_END_RESERVE);
  });

  it('keeps 12pt between the list end and the button top on both platforms', () => {
    for (const [os, inset] of [['ios', 85], ['android', 24]] as const) {
      const buttonTop = meraButtonBottom(os, inset) + MERA_BUTTON_SIZE;
      expect(listEndClearance(os, inset) - buttonTop).toBe(12);
    }
  });
});

describe('tabBarTopFromBottom', () => {
  it('on iOS: content runs under the bar, so the tab inset alone (bar + home indicator)', () => {
    expect(tabBarTopFromBottom(874, 874, 'ios', 83)).toBe(83);
  });

  it('on Android: content ends at the bar, so the gap under it (bar + nav inset)', () => {
    expect(tabBarTopFromBottom(915, 810.6, 'android', 24)).toBeCloseTo(104.4);
  });

  it('never goes negative for a measure past the window', () => {
    expect(tabBarTopFromBottom(874, 880, 'android', 0)).toBe(0);
  });
});

describe('foldTabBarTop', () => {
  const empty = { top: null, windowHeight: null };

  it('keeps the largest report for a window height (the early inset-only report loses)', () => {
    let s = foldTabBarTop(empty, 34, 844);
    expect(s.top).toBe(34);
    s = foldTabBarTop(s, 83, 844);
    expect(s.top).toBe(83);
    const kept = foldTabBarTop(s, 34, 844);
    expect(kept).toBe(s);
    expect(kept.top).toBe(83);
  });

  it('starts over when the window changes size', () => {
    const s = foldTabBarTop(foldTabBarTop(empty, 83, 844), 40, 390);
    expect(s).toEqual({ top: 40, windowHeight: 390 });
  });
});

describe('tabBarOverlap and tabContentBottomInset', () => {
  it('never lets an iOS page end under the measured bar, even on the early inset', () => {
    // The tab's safe area has not landed yet (34), the tabs measured the bar (83).
    expect(tabBarOverlap('ios', 34, 83)).toBe(83);
    expect(tabBarOverlap('ios', 83, 83)).toBe(83);
    expect(tabBarOverlap('ios', 34, null)).toBe(34);
    expect(tabContentBottomInset('ios', 34, 83)).toBe(83 + TAB_CONTENT_END_GAP);
  });

  it('adds only the gap on Android, where the content already ends at the bar', () => {
    expect(tabBarOverlap('android', 24, 104)).toBe(0);
    expect(tabContentBottomInset('android', 24, 104)).toBe(TAB_CONTENT_END_GAP);
  });
});
