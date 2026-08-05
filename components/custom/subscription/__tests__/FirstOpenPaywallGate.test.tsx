// FirstOpenPaywallGate.test.tsx — fire-once behaviour for the first-open push,
// plus its half of the "mutually exclusive with the lapse gate" contract.
//
// Renders null. Mocks: expo-router's usePathname, nav-state's
// navigateToPaywall (real one has a module-level latch across tests),
// setting-service (real one drags in a native SQLiteAdapter — see
// LapseInterstitialGate.test.tsx), and the subscription store (both the
// `useSubscriptionStore` hook AND the imperative `getAiAccess` this gate reads
// directly — omitting the latter would make it always `undefined`, so the
// gate's `getAiAccess() !== 'locked'` check would always short-circuit true
// and every "does it fire" assertion would pass for the wrong reason).

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

const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...a: any[]) => mockGetSetting(...a),
}));

// This gate imports ROUTE_SETTLE_MS from LapseInterstitialGate, which in turn
// imports billing-service — which (via apollo-client → for-you-store →
// article-suggestion-service) drags in lib/database/index.ts and a real
// SQLiteAdapter at module load. Mock it out; nothing here calls it.
jest.mock('@/lib/billing-service', () => ({
  acknowledgeLapseInterstitial: jest.fn().mockResolvedValue(null),
}));

let mockHasEverSubscribed: boolean | null = null;
let mockAiAccess: 'unknown' | 'entitled' | 'locked' = 'locked';

jest.mock('@/lib/stores/subscription-store', () => ({
  useSubscriptionStore: (selector: (s: any) => any) =>
    selector({ hasEverSubscribed: mockHasEverSubscribed }),
  getAiAccess: () => mockAiAccess,
}));

import FirstOpenPaywallGate, {
  FIRST_OPEN_DISMISSED_SETTING_KEY,
} from '../FirstOpenPaywallGate';
import { ROUTE_SETTLE_MS } from '../LapseInterstitialGate';

/** Flush the getSetting() microtask the mount effect kicks off. */
async function flushSettingRead() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('FirstOpenPaywallGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockPathname = '/logged-in/app_container/feed';
    mockHasEverSubscribed = false;
    mockAiAccess = 'locked';
    mockGetSetting.mockResolvedValue(null); // not dismissed
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing', () => {
    const { toJSON } = render(<FirstOpenPaywallGate />);
    expect(toJSON()).toBeNull();
  });

  it('reads the dismissed flag under its documented key', async () => {
    render(<FirstOpenPaywallGate />);
    await flushSettingRead();
    expect(mockGetSetting).toHaveBeenCalledWith(FIRST_OPEN_DISMISSED_SETTING_KEY);
  });

  it('does not fire while the dismissed setting has not resolved yet', () => {
    mockGetSetting.mockReturnValue(new Promise(() => {})); // never resolves
    render(<FirstOpenPaywallGate />);
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('does not fire when the user already dismissed it', async () => {
    mockGetSetting.mockResolvedValue('true');
    render(<FirstOpenPaywallGate />);
    await flushSettingRead();
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('does not fire when hasEverSubscribed is true (a lapsed user, not a first-timer)', async () => {
    mockHasEverSubscribed = true;
    render(<FirstOpenPaywallGate />);
    await flushSettingRead();
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('does not fire when hasEverSubscribed is null (unknown — not yet "never")', async () => {
    mockHasEverSubscribed = null;
    render(<FirstOpenPaywallGate />);
    await flushSettingRead();
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('does not fire when aiAccess is not locked (e.g. unknown, still loading)', async () => {
    mockAiAccess = 'unknown';
    render(<FirstOpenPaywallGate />);
    await flushSettingRead();
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('does not fire outside the logged-in app shell', async () => {
    mockPathname = '/logged-in/onboarding/welcome';
    render(<FirstOpenPaywallGate />);
    await flushSettingRead();
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();
  });

  it('fires once the route has settled for a never-subscribed, locked, non-dismissed user', async () => {
    render(<FirstOpenPaywallGate />);
    await flushSettingRead();

    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS - 1);
    });
    expect(mockNavigateToPaywall).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);
    // Default mode, no 'reason' arg — deliberately distinct from the lapse
    // gate's navigateToPaywall('lapsed').
    expect(mockNavigateToPaywall).toHaveBeenCalledWith();
  });

  it('fires at most once even across a re-render', async () => {
    const { rerender } = render(<FirstOpenPaywallGate />);
    await flushSettingRead();
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);

    rerender(<FirstOpenPaywallGate />);
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });
    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);
  });
});

export {};
