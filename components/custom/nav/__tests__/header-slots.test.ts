import { headerSideSlots, SIDE_SLOT, trackCentreX } from '../header-slots';

describe('headerSideSlots', () => {
  it('centres the track on the screen on Feed, Library and You', () => {
    const tabs = [
      { name: 'feed', leading: true, help: true },
      { name: 'library', leading: false, help: true },
      { name: 'you', leading: false, help: true },
    ];
    for (const width of [375, 402, 440]) {
      for (const tab of tabs) {
        expect(trackCentreX(width, 6, headerSideSlots(tab.leading, tab.help))).toBe(width / 2);
      }
    }
  });

  it('balances a lone control with an empty slot as wide', () => {
    expect(headerSideSlots(false, true)).toEqual({ left: SIDE_SLOT, right: SIDE_SLOT });
    expect(headerSideSlots(true, false)).toEqual({ left: SIDE_SLOT, right: SIDE_SLOT });
    expect(headerSideSlots(false, false)).toEqual({ left: 0, right: 0 });
  });
});
