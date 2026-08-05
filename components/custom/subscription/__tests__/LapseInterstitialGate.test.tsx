// LapseInterstitialGate.test.tsx — fire-once behaviour, gated on route settle
// and the derived showLapseInterstitial verdict.
//
// Renders null, so no NativeWind/Gluestack/reanimated setup is needed — only
// its direct dependencies: expo-router's usePathname, the subscription store,
// nav-state's navigateToPaywall (whose real implementation has a module-level
// latch that would silently no-op a second test), and billing-service's
// acknowledgeLapseInterstitial (a real GraphQL call). feature-gates and
// ai-access are left REAL — DEV_FORCE_LAPSED defaults to false, which is also
// what keeps devAcked synchronously `false` without touching setting-service.

import { act, render } from '@testing-library/react-native';
import React from 'react';

let mockPathname = '/logged-in/app_container/feed';
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
}));

const mockNavigateToPaywall = jest.fn();
jest.mock('@/lib/nav-state', () => ({
  navigateToPaywall: (...a: any[]) => mockNavigateToPaywall(...a),
}));

const mockAcknowledgeLapseInterstitial = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/billing-service', () => ({
  acknowledgeLapseInterstitial: (...a: any[]) => mockAcknowledgeLapseInterstitial(...a),
}));

// Not exercised while DEV_FORCE_LAPSED is false (its effect returns before
// touching either), but the import still resolves lib/database/index.ts,
// which instantiates a real SQLiteAdapter at module load — mock it out so the
// suite doesn't need a native DB.
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn().mockResolvedValue(null),
  setSetting: jest.fn().mockResolvedValue(undefined),
}));

const mockClearLapseInterstitial = jest.fn();
let mockShowLapseInterstitial: boolean | null = null;

jest.mock('@/lib/stores/subscription-store', () => ({
  useSubscriptionStore: (selector: (s: any) => any) =>
    selector({
      showLapseInterstitial: mockShowLapseInterstitial,
      clearLapseInterstitial: mockClearLapseInterstitial,
    }),
}));

import LapseInterstitialGate, { ROUTE_SETTLE_MS } from '../LapseInterstitialGate';

describe('LapseInterstitialGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockPathname = '/logged-in/app_container/feed';
    mockShowLapseInterstitial = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing', () => {
    mockShowLapseInterstitial = true;
    const { toJSON } = render(<LapseInterstitialGate />);
    expect(toJSON()).toBeNull();
  });

  it('does not fire when showLapseInterstitial is false', () => {
    mockShowLapseInterstitial = false;
    render(<LapseInterstitialGate />);
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('does not fire when showLapseInterstitial is null (unknown)', () => {
    mockShowLapseInterstitial = null;
    render(<LapseInterstitialGate />);
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('does not fire outside the logged-in app shell, even when lapsed', () => {
    mockShowLapseInterstitial = true;
    mockPathname = '/logged-in/onboarding/welcome';
    render(<LapseInterstitialGate />);
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('fires once the route has settled inside the app shell for a lapsed user', () => {
    mockShowLapseInterstitial = true;
    render(<LapseInterstitialGate />);

    // Not yet — the route-settle timer hasn't elapsed.
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS - 1);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);
    expect(mockNavigateToPaywall).toHaveBeenCalledWith('lapsed');
    expect(mockClearLapseInterstitial).toHaveBeenCalledTimes(1);
    expect(mockAcknowledgeLapseInterstitial).toHaveBeenCalledTimes(1);
  });

  it('fires at most once, even if the effect re-runs on a later re-render', () => {
    mockShowLapseInterstitial = true;
    const { rerender } = render(<LapseInterstitialGate />);
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);

    // A subsequent render with the flag still true (e.g. the store hasn't
    // been cleared by this mock, unlike the real one) must not re-fire.
    rerender(<LapseInterstitialGate />);
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);
  });

  it('a pathname change before the route settles restarts the timer instead of firing early', () => {
    mockShowLapseInterstitial = true;
    const { rerender } = render(<LapseInterstitialGate />);

    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS - 100);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();

    // Route changes (e.g. logged-in/index still routing) — cancel + restart.
    mockPathname = '/logged-in/app_container/for_you';
    rerender(<LapseInterstitialGate />);

    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS - 100);
    });
    // The old timer would have fired here; the restarted one has not.
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);
  });
});

export {};
