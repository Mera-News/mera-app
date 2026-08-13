/* eslint-disable @typescript-eslint/no-require-imports */
// Cold-start routing gate (app/logged-in/index.tsx).
//
// Two invariants live here:
//   1. Session <-> local-identity coherence is resolved BEFORE any persona /
//      fact read and before the app shell is entered. A 'reauth' verdict must
//      leave for /login WITH reauth:'1' — without that param login.tsx
//      short-circuits on the live session and bounces straight back, an
//      infinite loop.
//   2. Onboarding is gated on LOCAL FACTS, never the server onboardingStage.
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
// The fail-closed screen. Stubbed to a bare marker: its own behaviour (the
// retry budget, the always-enabled sign-out, the no-store rule) is covered in
// components/custom/auth/__tests__/IdentitySwitchFailedScreen.test.tsx. What
// this suite asserts is only that the gate renders it INSTEAD of routing.
jest.mock('@/components/custom/auth/IdentitySwitchFailedScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="identity-switch-failed" /> };
});
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

const mockReplace = jest.fn();
const mockDismissAll = jest.fn();
jest.mock('expo-router', () => ({ router: { replace: (...a: any[]) => mockReplace(...a), dismissAll: () => mockDismissAll() } }));

let mockSession: any = { user: { id: 'u1' } };
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: mockSession }) } }));

const mockClearPreviousUserData = jest.fn(async () => {});
jest.mock('@/lib/stores', () => ({ clearPreviousUserData: (...a: any[]) => mockClearPreviousUserData(...(a as [])) }));

const mockHasAnyFacts = jest.fn(async () => true);
jest.mock('@/lib/database/services/fact-service', () => ({ hasAnyFacts: () => mockHasAnyFacts() }));

// Key-aware: `cached_user_id` and `startup_tab` (read by
// lib/navigation/startup-tab.ts, real module, not mocked) share this one
// getSetting mock. Tests that call `mockGetSetting.mockResolvedValue(...)`
// directly (identity-fault scenarios below) replace this default entirely —
// harmless here, since any value that isn't 'feed' | 'for_you' | 'around'
// falls back to the 'feed' default in parseStartupTab().
let mockStartupTabSetting: string | null = null;
const mockGetSetting = jest.fn(async (key: string): Promise<string | null> =>
    key === 'startup_tab' ? mockStartupTabSetting : 'u1',
);
jest.mock('@/lib/database/services/setting-service', () => ({ getSetting: (k: string) => mockGetSetting(k) }));

const mockResolveIdentity = jest.fn(() => 'coherent' as string);
const mockHasIdentityFault = jest.fn(async () => false);
// The recorder is REAL module state in the source, so every member of it has to
// exist on this factory. A missing one is `undefined` at the call site, the
// effect throws a TypeError, and the catch at the bottom of the gate swallows
// it — a coding error that renders as a passing routing test.
const mockReadPendingAuthUserId = jest.fn((): string | null => null);
const mockClearPendingAuthUserId = jest.fn();
jest.mock('@/lib/security/identity-gate', () => ({
    resolveIdentity: (...a: any[]) => mockResolveIdentity(...(a as [])),
    hasIdentityFault: () => mockHasIdentityFault(),
    readPendingAuthUserId: () => mockReadPendingAuthUserId(),
    clearPendingAuthUserId: () => mockClearPendingAuthUserId(),
    // NOT a jest.fn: the precedence rule is the thing under test on this path,
    // so the gate must run the REAL one. Its own unit tests live in
    // lib/security/__tests__/identity-gate.test.ts.
    effectiveSessionUserId: (s?: string | null, p?: string | null) => (s ? s : p || null),
}));

const mockSetUserId = jest.fn();
const mockAdoptLocalUserId = jest.fn();
const mockHydrateFromDb = jest.fn(async () => {});
const mockFetchUserPersona = jest.fn(async () => null);
const mockFetchUserPersonaOrThrow = jest.fn(async () => ({}));
const mockSetNeedsReauth = jest.fn((_v: boolean) => {});
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: {
        getState: () => ({
            setUserId: mockSetUserId,
            adoptLocalUserId: mockAdoptLocalUserId,
            setNeedsReauth: mockSetNeedsReauth,
            hydrateFromDb: mockHydrateFromDb,
            fetchUserPersona: mockFetchUserPersona,
            fetchUserPersonaOrThrow: mockFetchUserPersonaOrThrow,
            userPersona: { onboardingStage: 'FINISHED' },
        }),
    },
}));
const mockProbeServerReachable = jest.fn(async () => true);
jest.mock('@/lib/stores/network-store', () => ({
    useNetworkStore: { getState: () => ({ isConnected: true }) },
    probeServerReachable: () => mockProbeServerReachable(),
}));
jest.mock('@/lib/stores/subscription-store', () => ({ useSubscriptionStore: { getState: () => ({ setCustomerInfo: jest.fn() }) } }));
jest.mock('@/lib/revenuecat', () => ({ loginRevenueCat: jest.fn(async () => null) }));
// Same reason as the mock above: the real module reaches apollo-client and, via
// for-you-store, the WatermelonDB SQLite adapter — which needs native JSI and
// cannot be constructed in this environment. Routing is what's under test here.
jest.mock('@/lib/subscription/entitlement-sync', () => ({ syncEntitlement: jest.fn(async () => undefined) }));

// Pre-onboarding paywall gate. Stubbed for the same reason as the two mocks
// above (its real graph reaches react-native-purchases and Apollo) and so this
// suite stays about identity + facts. Its behaviour is covered end-to-end in
// components/custom/subscription/__tests__/onboarding-paywall-order.test.tsx.
// The default verdict is the pass-through one, so every pre-existing assertion
// here describes an entitled user and is unchanged.
const mockNavigateToPaywall = jest.fn();
jest.mock('@/lib/nav-state', () => ({ navigateToPaywall: () => mockNavigateToPaywall() }));
const mockResolveEntitlement = jest.fn(async () => 'entitled' as string);
const mockDecideEntry = jest.fn(() => 'onboarding' as string);
jest.mock('@/lib/subscription/onboarding-paywall', () => ({
    resolveEntitlementForOnboarding: (...a: any[]) => mockResolveEntitlement(...(a as [])),
    decideOnboardingEntry: (...a: any[]) => mockDecideEntry(...(a as [])),
}));
const mockReadFirstOpenDismissed = jest.fn(async () => false);
jest.mock('@/lib/subscription/first-open-dismissal', () => ({
    FIRST_OPEN_DISMISSED_SETTING_KEY: 'free_tier_first_open_dismissed',
    readFirstOpenDismissed: () => mockReadFirstOpenDismissed(),
}));

import LoggedInIndex from '../logged-in/index';

beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { user: { id: 'u1' } };
    mockStartupTabSetting = null;
    mockGetSetting.mockImplementation(async (key: string) =>
        key === 'startup_tab' ? mockStartupTabSetting : 'u1',
    );
    mockResolveIdentity.mockReturnValue('coherent');
    mockHasIdentityFault.mockResolvedValue(false);
    // Nothing recorded is the DEFAULT, and it is the offline/cold-start shape.
    // Without this reset the recorder leaks between tests, which is exactly how
    // a suite stops testing the offline path without anybody noticing.
    mockReadPendingAuthUserId.mockReturnValue(null);
    mockClearPreviousUserData.mockResolvedValue(undefined);
    mockHasAnyFacts.mockResolvedValue(true);
    mockResolveEntitlement.mockResolvedValue('entitled');
    mockDecideEntry.mockReturnValue('onboarding');
    mockReadFirstOpenDismissed.mockResolvedValue(false);
});

describe('cold-start identity gate', () => {
    it('reauth verdict leaves for /login with reauth:"1" and never enters the shell', async () => {
        mockResolveIdentity.mockReturnValue('reauth');
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        // The param is load-bearing: login.tsx redirects a live session back to
        // /logged-in (i.e. straight back here) unless reauthMode is on.
        expect(mockReplace).toHaveBeenCalledWith({ pathname: '/login', params: { reauth: '1' } });
        expect(mockReplace).toHaveBeenCalledTimes(1);
        // Nothing local was touched, and no personalized read happened.
        expect(mockClearPreviousUserData).not.toHaveBeenCalled();
        expect(mockSetUserId).not.toHaveBeenCalled();
        expect(mockHydrateFromDb).not.toHaveBeenCalled();
        expect(mockHasAnyFacts).not.toHaveBeenCalled();
    });

    it('wipeAndProceed wipes the previous owner before hydrating or counting', async () => {
        mockResolveIdentity.mockReturnValue('wipeAndProceed');
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockHasAnyFacts).toHaveBeenCalled());
        expect(mockClearPreviousUserData).toHaveBeenCalledWith('u1');
        const wipeOrder = mockClearPreviousUserData.mock.invocationCallOrder[0];
        expect(wipeOrder).toBeLessThan(mockHydrateFromDb.mock.invocationCallOrder[0]);
        expect(wipeOrder).toBeLessThan(mockHasAnyFacts.mock.invocationCallOrder[0]);
    });

    it('coherent verdict skips the wipe', async () => {
        mockResolveIdentity.mockReturnValue('coherent');
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockHasAnyFacts).toHaveBeenCalled());
        expect(mockClearPreviousUserData).not.toHaveBeenCalled();
        expect(mockSetUserId).toHaveBeenCalledWith('u1');
    });

    it('feeds the session id, the on-disk owner, the fault and connectivity into the verdict', async () => {
        mockGetSetting.mockResolvedValue('other-user');
        mockHasIdentityFault.mockResolvedValue(true);
        mockResolveIdentity.mockReturnValue('reauth');
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockResolveIdentity).toHaveBeenCalledWith({
            sessionUserId: 'u1',
            // Fed in alongside the atom, never pre-coalesced into it: the
            // precedence rule has exactly one home, inside resolveIdentity.
            pendingAuthUserId: null,
            cachedUserId: 'other-user',
            ownershipFault: true,
            isConnected: true,
            // Probed because a fault is present — see the reachability tests below.
            serverReachable: true,
        });
    });

    // ── server-reachability probe ────────────────────────────────────────
    // The eject must not fire when the auth server cannot be reached: the OTP
    // it sends the user to could not be completed. Deferral, not cancellation —
    // the fault stays persisted and the next reachable launch ejects as before.
    it('does not spend a probe round-trip on the happy path', async () => {
        mockHasIdentityFault.mockResolvedValue(false);
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockProbeServerReachable).not.toHaveBeenCalled();
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ serverReachable: undefined }),
        );
    });

    it('probes and forwards the result when a fault is present', async () => {
        mockHasIdentityFault.mockResolvedValue(true);
        mockProbeServerReachable.mockResolvedValue(false);
        mockResolveIdentity.mockReturnValue('coherent');
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockProbeServerReachable).toHaveBeenCalledTimes(1);
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ ownershipFault: true, serverReachable: false }),
        );
    });

    it('keeps needsReauth set when the fault is deferred', async () => {
        // Deferring the eject must not leave background work ungated — the
        // scheduler's auth pre-flight keys off needsReauth to halt feed-sync.
        mockHasIdentityFault.mockResolvedValue(true);
        mockProbeServerReachable.mockResolvedValue(false);
        mockResolveIdentity.mockReturnValue('coherent');
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockSetNeedsReauth).toHaveBeenCalledWith(true));
    });

    it('leaves needsReauth alone when there is no fault', async () => {
        mockHasIdentityFault.mockResolvedValue(false);
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockSetNeedsReauth).not.toHaveBeenCalled();
    });

    // ── THE LEAK, AS A DATA-FLOW TEST ────────────────────────────────────
    //
    // The recorder turns a timing bug into a data-flow bug, which is why none
    // of this needs fake timers. The scenario is the reported one: user A's
    // data on disk, user B signs in through the reauth banner, and the gate
    // runs before better-auth's session atom has settled.
    it("routes B's sign-in off the RECORDER when the session atom has not settled", async () => {
        mockSession = null;
        mockGetSetting.mockImplementation(async (key: string) =>
            key === 'startup_tab' ? mockStartupTabSetting : 'A',
        );
        mockReadPendingAuthUserId.mockReturnValue('B');
        mockResolveIdentity.mockReturnValue('wipeAndProceed');

        render(<LoggedInIndex />);

        await waitFor(() => expect(mockHasAnyFacts).toHaveBeenCalled());
        // The unresolved atom is passed through as-is; the recorder rides
        // beside it.
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionUserId: undefined,
                pendingAuthUserId: 'B',
                cachedUserId: 'A',
            }),
        );
        // A's data goes, and the wipe TARGET is B — passing the unresolved
        // session id would hand clearPreviousUserData `undefined`.
        expect(mockClearPreviousUserData).toHaveBeenCalledWith('B');
        expect(mockSetUserId).toHaveBeenCalledWith('B');
        // The negative is the assertion that matters. `toHaveBeenCalledWith('B')`
        // passes just as happily when A is stamped back afterwards, which is
        // precisely the sticky-state bug this replaces.
        expect(mockSetUserId).not.toHaveBeenCalledWith('A');
        expect(mockAdoptLocalUserId).not.toHaveBeenCalled();
        // Consumed once stamped, so it cannot mask a later switch.
        expect(mockClearPendingAuthUserId).toHaveBeenCalledTimes(1);
    });

    // The other side of the same coin, and the one that must not regress: an
    // offline device has no recording (it requires a resolved network sign-in),
    // so nothing above is reachable for it and nothing is written to disk.
    it('offline: adopts the on-disk owner in memory and re-stamps NOTHING', async () => {
        mockSession = null;
        mockReadPendingAuthUserId.mockReturnValue(null);
        mockGetSetting.mockImplementation(async (key: string) =>
            key === 'startup_tab' ? mockStartupTabSetting : 'A',
        );
        mockResolveIdentity.mockReturnValue('coherent');

        render(<LoggedInIndex />);

        await waitFor(() =>
            expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed'),
        );
        expect(mockClearPreviousUserData).not.toHaveBeenCalled();
        expect(mockSetUserId).not.toHaveBeenCalled();
        expect(mockAdoptLocalUserId).toHaveBeenCalledWith('A');
    });

    // ── FAIL CLOSED ──────────────────────────────────────────────────────
    it('a failed wipe stamps nothing, routes nowhere, and blocks', async () => {
        mockSession = null;
        mockReadPendingAuthUserId.mockReturnValue('B');
        mockGetSetting.mockImplementation(async (key: string) =>
            key === 'startup_tab' ? mockStartupTabSetting : 'A',
        );
        mockResolveIdentity.mockReturnValue('wipeAndProceed');
        mockClearPreviousUserData.mockRejectedValue(new Error('database is locked'));

        const { findByTestId } = render(<LoggedInIndex />);

        expect(await findByTestId('identity-switch-failed')).toBeTruthy();
        // Not stamping is the RETRY MARKER: `cached_user_id` staying at A is
        // what makes the next launch re-detect the mismatch.
        expect(mockSetUserId).not.toHaveBeenCalled();
        expect(mockAdoptLocalUserId).not.toHaveBeenCalled();
        expect(mockClearPendingAuthUserId).not.toHaveBeenCalled();
        // No route AT ALL — not to the feed, not to onboarding, not to /login.
        expect(mockReplace).not.toHaveBeenCalled();
        // And nothing personalized was read on the way past.
        expect(mockHydrateFromDb).not.toHaveBeenCalled();
        expect(mockHasAnyFacts).not.toHaveBeenCalled();
    });

    // ── HOLE 2: THE SUPERSEDED RUN ───────────────────────────────────────
    //
    // `cancelled` used to guard navigation only, never writes. Two runs
    // interleaved and the older one stamped its stale owner back over the newer
    // one's, making the bad state sticky across launches.
    it('a superseded run never stamps the old owner over the new one', async () => {
        let releaseRun1: (v: string) => void = () => {};
        const parked = new Promise<string>((resolve) => { releaseRun1 = resolve; });
        let ownerReads = 0;
        mockGetSetting.mockImplementation(async (key: string) => {
            if (key === 'startup_tab') return mockStartupTabSetting;
            ownerReads += 1;
            // Run 1 parks on the owner read; every later run answers at once.
            return ownerReads === 1 ? parked : 'A';
        });

        // Run 1: the session has not resolved and nothing is recorded, so this
        // run would adopt A.
        mockSession = null;
        mockReadPendingAuthUserId.mockReturnValue(null);
        const { rerender } = render(<LoggedInIndex />);

        // Run 2: the session resolves to B and supersedes it.
        mockSession = { user: { id: 'B' } };
        mockResolveIdentity.mockReturnValue('wipeAndProceed');
        rerender(<LoggedInIndex />);
        await waitFor(() => expect(mockSetUserId).toHaveBeenCalledWith('B'));

        // Only now let the superseded run finish.
        await act(async () => {
            releaseRun1('A');
            for (let i = 0; i < 12; i++) await Promise.resolve();
        });

        expect(mockSetUserId).not.toHaveBeenCalledWith('A');
        expect(mockAdoptLocalUserId).not.toHaveBeenCalled();
        expect(mockSetUserId).toHaveBeenCalledTimes(1);
    });

    it('no local identity at all → back to the launch gate', async () => {
        mockSession = null;
        mockGetSetting.mockResolvedValue(null);
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
        expect(mockResolveIdentity).not.toHaveBeenCalled();
    });
});

describe('cold-start fact gate', () => {
    it('routes to the feed when the device holds facts, no startup-tab preference set', async () => {
        mockHasAnyFacts.mockResolvedValue(true);
        render(<LoggedInIndex />);
        await waitFor(() =>
            expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed'),
        );
    });

    // The primary path for the startup-tab preference: every returning user,
    // every launch. Pinned at a non-default value so a future simplification
    // back to a hard-coded '/logged-in/app_container/feed' fails loudly.
    it('routes to the startup-tab preference instead of a hard-coded feed', async () => {
        mockHasAnyFacts.mockResolvedValue(true);
        mockStartupTabSetting = 'around';
        render(<LoggedInIndex />);
        await waitFor(() =>
            expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/around'),
        );
    });

    it('routes to onboarding on 0 facts, whatever the server stage says', async () => {
        mockHasAnyFacts.mockResolvedValue(false);
        render(<LoggedInIndex />);
        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/logged-in/onboarding'));
    });

    it('treats an unreadable fact count as 0 facts (onboarding, not a broken feed)', async () => {
        mockHasAnyFacts.mockRejectedValue(new Error('db unreadable'));
        render(<LoggedInIndex />);
        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/logged-in/onboarding'));
    });
});

// ---------------------------------------------------------------------------
// Pre-onboarding paywall ordering
// ---------------------------------------------------------------------------
// The decision itself lives in OnboardingScreen (the only mounter of the
// wizard, and the one place both doorways pass through — DeepLinkVerifyScreen
// redirects straight to /logged-in/onboarding and never reaches this file;
// app/login.tsx did too until 2026-08-06, and now redirects to /logged-in
// instead). What is asserted here is the WIRING of the cold-start copy: that
// the resolve happens before the onboarding redirect, and never on the
// has-facts path.
describe('cold-start paywall ordering', () => {
    it('resolves entitlement BEFORE redirecting to onboarding', async () => {
        mockHasAnyFacts.mockResolvedValue(false);
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/logged-in/onboarding'));
        expect(mockResolveEntitlement).toHaveBeenCalledTimes(1);
        expect(mockResolveEntitlement.mock.invocationCallOrder[0]).toBeLessThan(
            mockReplace.mock.invocationCallOrder[0],
        );
    });

    it('a locked, never-dismissed user gets the paywall instead of onboarding', async () => {
        mockHasAnyFacts.mockResolvedValue(false);
        mockResolveEntitlement.mockResolvedValue('locked');
        mockDecideEntry.mockReturnValue('paywall');
        render(<LoggedInIndex />);

        await waitFor(() => expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1));
        expect(mockReplace).not.toHaveBeenCalledWith('/logged-in/onboarding');
    });

    it('a locked, already-dismissed user lands on Mera News Free, not onboarding', async () => {
        mockHasAnyFacts.mockResolvedValue(false);
        mockResolveEntitlement.mockResolvedValue('locked');
        mockDecideEntry.mockReturnValue('free-tier');
        render(<LoggedInIndex />);

        await waitFor(() =>
            expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed'),
        );
        expect(mockNavigateToPaywall).not.toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalledWith('/logged-in/onboarding');
    });

    // Renamed and widened 2026-08-06. The guard was `aiAccess === 'locked'`; it
    // is now `aiAccess !== 'entitled'`, because `'unknown'` diverts too.
    it('skips the dismissal read on the entitled path — the subscriber pays for no DB read', async () => {
        mockHasAnyFacts.mockResolvedValue(false);
        render(<LoggedInIndex />);
        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/logged-in/onboarding'));
        expect(mockReadFirstOpenDismissed).not.toHaveBeenCalled();
    });

    // ── THE ANTI-LOOP GUARD (2026-08-06) ────────────────────────────────────
    //
    // `'unknown'` now means "this device has never resolved a tier", and it
    // diverts exactly like `'locked'`. If this copy of the guard were left at
    // `=== 'locked'`, `firstOpenDismissed` would be hard-coded `false` for such
    // a device — so a user who already dismissed the paywall would be sent back
    // to it on every launch, forever. This guard and OnboardingScreen's must
    // stay identical; the sibling assertion lives in
    // components/custom/subscription/__tests__/onboarding-paywall-order.test.tsx.
    it("reads the dismissal flag on an 'unknown' verdict too, not just 'locked'", async () => {
        mockHasAnyFacts.mockResolvedValue(false);
        mockResolveEntitlement.mockResolvedValue('unknown');
        mockDecideEntry.mockReturnValue('paywall');

        render(<LoggedInIndex />);

        await waitFor(() => expect(mockNavigateToPaywall).toHaveBeenCalledTimes(1));
        expect(mockReadFirstOpenDismissed).toHaveBeenCalledTimes(1);
        // And the real answer is what reaches the decision — not a hard-coded
        // `false` that would defeat the dismissal.
        expect(mockDecideEntry).toHaveBeenCalledWith({
            aiAccess: 'unknown',
            firstOpenDismissed: false,
        });
    });

    it("an 'unknown' verdict on a DISMISSED device goes to Mera News Free, never back to the paywall", async () => {
        mockHasAnyFacts.mockResolvedValue(false);
        mockResolveEntitlement.mockResolvedValue('unknown');
        mockReadFirstOpenDismissed.mockResolvedValue(true);
        mockDecideEntry.mockReturnValue('free-tier');

        render(<LoggedInIndex />);

        await waitFor(() =>
            expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed'),
        );
        expect(mockDecideEntry).toHaveBeenCalledWith({
            aiAccess: 'unknown',
            firstOpenDismissed: true,
        });
        expect(mockNavigateToPaywall).not.toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalledWith('/logged-in/onboarding');
    });

    it('an already-onboarded user pays for none of it (requirement: no regression)', async () => {
        mockHasAnyFacts.mockResolvedValue(true);
        render(<LoggedInIndex />);

        await waitFor(() =>
            expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed'),
        );
        expect(mockResolveEntitlement).not.toHaveBeenCalled();
        expect(mockNavigateToPaywall).not.toHaveBeenCalled();
    });
});
