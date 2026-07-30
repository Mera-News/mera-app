// nav-state — the module-level pathname mirror non-React code reads, plus the
// idempotent paywall navigation and the app-wide "a screen just came into view"
// signal that refreshes relative timestamps.

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ router: { replace: (...a: unknown[]) => mockReplace(...a) } }));

const mockNotifyTimeTick = jest.fn();
jest.mock('../time-tick', () => ({ notifyTimeTick: () => mockNotifyTimeTick() }));

import {
  getCurrentPathname,
  navigateToPaywall,
  setCurrentPathname,
} from '../nav-state';

beforeEach(() => {
  jest.clearAllMocks();
  setCurrentPathname(''); // reset module state between cases
  mockNotifyTimeTick.mockClear();
});

describe('setCurrentPathname', () => {
  it('mirrors the pathname for non-React readers', () => {
    setCurrentPathname('/logged-in/app_container/feed');
    expect(getCurrentPathname()).toBe('/logged-in/app_container/feed');
  });

  // The app-wide focus signal: the root layout calls this on every route change,
  // so one call here refreshes every on-screen age instead of each screen
  // needing its own focus effect.
  it('notifies the time ticker when the route CHANGES', () => {
    setCurrentPathname('/a');
    expect(mockNotifyTimeTick).toHaveBeenCalledTimes(1);
    setCurrentPathname('/b');
    expect(mockNotifyTimeTick).toHaveBeenCalledTimes(2);
  });

  it('does NOT notify when the pathname is unchanged', () => {
    setCurrentPathname('/a');
    mockNotifyTimeTick.mockClear();
    setCurrentPathname('/a');
    setCurrentPathname('/a');
    expect(mockNotifyTimeTick).not.toHaveBeenCalled();
  });
});

describe('navigateToPaywall', () => {
  it('navigates once and swallows a second concurrent call', () => {
    navigateToPaywall();
    navigateToPaywall();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/logged-in/not-subscribed');
  });

  it('no-ops when already on the paywall', () => {
    setCurrentPathname('/logged-in/not-subscribed');
    navigateToPaywall();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('re-arms once the route settles somewhere else', () => {
    navigateToPaywall();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    setCurrentPathname('/logged-in/app_container/feed'); // clears the in-flight guard
    navigateToPaywall();
    expect(mockReplace).toHaveBeenCalledTimes(2);
  });
});
