import { TAB_BAR_HEIGHT, tabBarClearance } from '../tab-bar';

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
