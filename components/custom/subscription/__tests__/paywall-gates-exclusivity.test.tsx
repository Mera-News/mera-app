// paywall-gates-exclusivity.test.tsx — renders LapseInterstitialGate and
// FirstOpenPaywallGate together against ONE shared store, over the two states
// that are actually reachable in production (see each gate's own precondition
// comment):
//
//   - never-subscribed, locked  → only the first-open push may fire
//   - lapsed (hasEverSubscribed: true, showLapseInterstitial: true)
//         → only the lapse interstitial may fire
//
// The pair {hasEverSubscribed: false, showLapseInterstitial: true} is NOT
// tested here: FirstOpenPaywallGate.tsx's own comment states the two are
// "mutually exclusive by construction" because a lapse can only happen to a
// user for whom hasEverSubscribed is true — so that combination is not a real
// state, and asserting behaviour for it would test a bug that can't occur
// rather than the actual contract.

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
  setSetting: jest.fn().mockResolvedValue(undefined),
}));

const mockAcknowledgeLapseInterstitial = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/billing-service', () => ({
  acknowledgeLapseInterstitial: (...a: any[]) => mockAcknowledgeLapseInterstitial(...a),
}));

let mockStoreState = {
  hasEverSubscribed: false as boolean | null,
  showLapseInterstitial: false as boolean | null,
  clearLapseInterstitial: jest.fn(),
};
let mockAiAccess: 'unknown' | 'entitled' | 'locked' = 'locked';

jest.mock('@/lib/stores/subscription-store', () => ({
  useSubscriptionStore: (selector: (s: any) => any) => selector(mockStoreState),
  getAiAccess: () => mockAiAccess,
}));

import LapseInterstitialGate, { ROUTE_SETTLE_MS } from '../LapseInterstitialGate';
import FirstOpenPaywallGate from '../FirstOpenPaywallGate';

function BothGates() {
  return (
    <>
      <LapseInterstitialGate />
      <FirstOpenPaywallGate />
    </>
  );
}

describe('LapseInterstitialGate + FirstOpenPaywallGate — mutual exclusivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockPathname = '/logged-in/app_container/feed';
    mockGetSetting.mockResolvedValue(null);
    mockAiAccess = 'locked';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('never-subscribed + locked: only the first-open push fires', async () => {
    mockStoreState = {
      hasEverSubscribed: false,
      showLapseInterstitial: false,
      clearLapseInterstitial: jest.fn(),
    };

    render(<BothGates />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });

    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);
    expect(mockNavigateToPaywall).toHaveBeenCalledWith(); // no 'lapsed' reason
  });

  it('lapsed (hasEverSubscribed: true, showLapseInterstitial: true): only the interstitial fires', async () => {
    mockStoreState = {
      hasEverSubscribed: true,
      showLapseInterstitial: true,
      clearLapseInterstitial: jest.fn(),
    };

    render(<BothGates />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(ROUTE_SETTLE_MS);
    });

    expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1);
    expect(mockNavigateToPaywall).toHaveBeenCalledWith('lapsed');
  });
});

export {};
