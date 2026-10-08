jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));

import { reportHeaderBottom, resetCurrentSurface, useCurrentSurfaceStore } from '../current-surface';

describe('tabHeaderBottom', () => {
  beforeEach(() => resetCurrentSurface());

  it("keeps the tallest tab header, and ignores other screens' headers", () => {
    reportHeaderBottom('tab:feed', 99);
    reportHeaderBottom('tab:world', 143.4);
    reportHeaderBottom('tab:feed', 99);
    reportHeaderBottom('fact', 200);
    expect(useCurrentSurfaceStore.getState().tabHeaderBottom).toBe(143);
  });
});
