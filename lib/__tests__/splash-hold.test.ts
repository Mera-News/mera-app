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

  it('hides once, however many releases arrive', () => {
    holdSplash();
    releaseSplash('a');
    releaseSplash('b');
    flushFrame();
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  // Android deadlock: the held splash cancels every draw, so a frame never
  // comes. Release (and the cap) must hide WITHOUT waiting for one.
  it('hides without waiting for a frame, and so does the cap', () => {
    const raf = jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 0);
    try {
      holdSplash();
      releaseSplash('route');
      expect(mockHide).toHaveBeenCalledTimes(1);

      __resetSplashHoldForTests();
      mockHide.mockClear();
      holdSplash();
      act(() => { jest.advanceTimersByTime(SPLASH_MAX_HOLD_MS + 50); });
      expect(mockHide).toHaveBeenCalledTimes(1);
    } finally {
      raf.mockRestore();
    }
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

describe('Android', () => {
  it('Android: holdSplash is a no-op (expo-router auto-hides as before)', () => {
    const RN = require('react-native');
    const original = RN.Platform.OS;
    Object.defineProperty(RN.Platform, 'OS', { configurable: true, get: () => 'android' });
    try {
      holdSplash();
      releaseSplash('route');
      act(() => { jest.advanceTimersByTime(SPLASH_MAX_HOLD_MS + 50); });
      expect(mockPrevent).not.toHaveBeenCalled();
      expect(mockHide).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(RN.Platform, 'OS', { configurable: true, get: () => original });
    }
  });
});
