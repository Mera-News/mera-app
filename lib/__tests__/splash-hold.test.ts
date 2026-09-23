/* eslint-disable @typescript-eslint/no-require-imports */
// F1: the native splash is held until the first real screen commits, and can
// never hang.
const mockPrevent = jest.fn(async () => true);
const mockHide = jest.fn();
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: () => mockPrevent(),
  hide: () => mockHide(),
}));
let mockPathname = '/';
jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));

import { act, renderHook } from '@testing-library/react-native';
import {
  SPLASH_MAX_HOLD_MS,
  SplashReleaser,
  __resetSplashHoldForTests,
  holdSplash,
  releaseSplash,
} from '../splash-hold';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  __resetSplashHoldForTests();
  mockPathname = '/';
});
afterEach(() => jest.useRealTimers());

const flushFrame = () => act(() => { jest.advanceTimersByTime(20); });

describe('splash hold', () => {
  it('prevents the auto-hide once', () => {
    holdSplash();
    holdSplash();
    expect(mockPrevent).toHaveBeenCalledTimes(1);
  });

  it('hides once, after a frame, however many releases arrive', () => {
    holdSplash();
    releaseSplash('a');
    expect(mockHide).not.toHaveBeenCalled();
    flushFrame();
    releaseSplash('b');
    flushFrame();
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  it('hides on its own at the cap when nothing releases', () => {
    holdSplash();
    act(() => { jest.advanceTimersByTime(SPLASH_MAX_HOLD_MS + 50); });
    expect(mockHide).toHaveBeenCalledTimes(1);
  });
});

describe('SplashReleaser', () => {
  it('does not release on a startup gate', () => {
    holdSplash();
    mockPathname = '/';
    const h = renderHook(() => SplashReleaser());
    mockPathname = '/logged-in';
    h.rerender({});
    flushFrame();
    expect(mockHide).not.toHaveBeenCalled();
  });

  it.each(['/logged-in/app_container/feed', '/login', '/pin-lock', '/logged-in/onboarding'])(
    'releases on %s',
    (path) => {
      holdSplash();
      mockPathname = path;
      renderHook(() => SplashReleaser());
      flushFrame();
      expect(mockHide).toHaveBeenCalledTimes(1);
    },
  );
});
