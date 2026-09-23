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

  it('on Android keeps the previous arithmetic until an emulator capture measures it', () => {
    expect(tabBarClearance('android', 24)).toBe(24 + TAB_BAR_HEIGHT);
  });
});
