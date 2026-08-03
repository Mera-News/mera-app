/* eslint-disable @typescript-eslint/no-require-imports */
// OnboardingScreen gate tests.
//
// The gate is LOCAL FACTS, never the server's onboardingStage:
//   - >=1 fact            → onComplete(), wizard never mounts
//   - 0 facts             → wizard, even when the server says FINISHED
//   - user switch         → clearPreviousUserData() runs BEFORE the count
//                           (`facts` is device-global, so a stale count would
//                           let user B skip onboarding on user A's device)
//   - local read failure  → wizard (never a persona-less feed)
// No AccountService / network call is involved at all.
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

// Decorative, and it drags in react-native-reanimated (no worklets runtime
// under Jest) — stub it out of the module graph entirely.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => {
    const { View } = require('react-native');
    return { Spinner: (p: any) => <View testID="onboarding-gate-spinner" {...p} /> };
});

jest.mock('@/components/custom/onboarding/OnboardingWizard', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="onboarding-wizard" {...p} /> };
});

// Records the interleaving of the wipe and the count so the ordering test can
// assert the wipe strictly precedes the count.
const callOrder: string[] = [];

const mockClearPreviousUserData = jest.fn(async () => { callOrder.push('clear'); });
const mockSetUserId = jest.fn((_id: string) => { callOrder.push('setUserId'); });
jest.mock('@/lib/stores', () => ({
    clearPreviousUserData: (...args: any[]) => mockClearPreviousUserData(...(args as [])),
    useUserStore: { getState: () => ({ setUserId: mockSetUserId }) },
}));

const mockHasAnyFacts = jest.fn(async () => { callOrder.push('count'); return false; });
jest.mock('@/lib/database/services/fact-service', () => ({
    hasAnyFacts: () => mockHasAnyFacts(),
}));

// The identity gate itself is exhaustively tested in
// lib/security/__tests__/identity-gate.test.ts — here we only pin the WIRING:
// which verdict produces which action, and in what order.
const mockResolveIdentity = jest.fn(() => 'wipeAndProceed' as string);
const mockHasIdentityFault = jest.fn(async () => false);
jest.mock('@/lib/security/identity-gate', () => ({
    resolveIdentity: (...a: any[]) => mockResolveIdentity(...(a as [])),
    hasIdentityFault: () => mockHasIdentityFault(),
}));

const mockGetSetting = jest.fn(async (_k: string): Promise<string | null> => 'u1');
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
}));

jest.mock('@/lib/stores/network-store', () => ({
    useNetworkStore: { getState: () => ({ isConnected: true }) },
}));

import OnboardingScreen from '../OnboardingScreen';

beforeEach(() => {
    jest.clearAllMocks();
    callOrder.length = 0;
    mockClearPreviousUserData.mockImplementation(async () => { callOrder.push('clear'); });
    mockSetUserId.mockImplementation((_id: string) => { callOrder.push('setUserId'); });
    mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return false; });
    mockResolveIdentity.mockReturnValue('wipeAndProceed');
    mockHasIdentityFault.mockResolvedValue(false);
    mockGetSetting.mockResolvedValue('u1');
});

function renderScreen(onComplete = jest.fn(), onLoginRedirect = jest.fn()) {
    const utils = render(
        <OnboardingScreen userId="u1" onLoginRedirect={onLoginRedirect} onComplete={onComplete} />,
    );
    return { ...utils, onComplete, onLoginRedirect };
}

describe('OnboardingScreen fact gate', () => {
    it('shows the wizard when the user has 0 local facts (server stage is irrelevant)', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return false; });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(queryByTestId('onboarding-wizard')).toBeTruthy());
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('calls onComplete without mounting the wizard when the user has >=1 fact', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(queryByTestId('onboarding-wizard')).toBeNull();
    });

    it('keeps the spinner up while handing off to onComplete (no blank flash)', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalled());
        expect(queryByTestId('onboarding-gate-spinner')).toBeTruthy();
    });

    it('wipes a previous user\'s data, stamps the new owner, THEN counts facts', async () => {
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        renderScreen();

        await waitFor(() => expect(mockHasAnyFacts).toHaveBeenCalled());
        expect(mockClearPreviousUserData).toHaveBeenCalledWith('u1');
        // setUserId writes `cached_user_id`, the sentinel clearPreviousUserData
        // keys off. Nothing else on the fresh-login path writes it, so without
        // this stamp the wipe is a permanent no-op for a user who logged in but
        // never cold-started — and the next user inherits their facts.
        expect(mockSetUserId).toHaveBeenCalledWith('u1');
        expect(callOrder).toEqual(['clear', 'setUserId', 'count']);
    });

    it('still counts facts when the wipe throws (a broken wipe must not strand the user)', async () => {
        mockClearPreviousUserData.mockImplementation(async () => { throw new Error('db locked'); });
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });

    it('shows the wizard when the local fact count throws', async () => {
        mockHasAnyFacts.mockImplementation(async () => { throw new Error('db unreadable'); });
        const { queryByTestId, onComplete } = renderScreen();

        await waitFor(() => expect(queryByTestId('onboarding-wizard')).toBeTruthy());
        expect(onComplete).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Identity-gate wiring
// ---------------------------------------------------------------------------

describe('OnboardingScreen identity gate', () => {
    it('reads the on-disk owner BEFORE the wipe can delete it', async () => {
        renderScreen();
        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockGetSetting).toHaveBeenCalledWith('cached_user_id');
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ sessionUserId: 'u1', cachedUserId: 'u1' }),
        );
    });

    it('reauth verdict → routes to the reauth login and never reads facts', async () => {
        mockResolveIdentity.mockReturnValue('reauth');
        const { onLoginRedirect, onComplete, queryByTestId } = renderScreen();

        await waitFor(() => expect(onLoginRedirect).toHaveBeenCalledTimes(1));
        expect(mockClearPreviousUserData).not.toHaveBeenCalled();
        expect(mockSetUserId).not.toHaveBeenCalled();
        expect(mockHasAnyFacts).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
        expect(queryByTestId('onboarding-wizard')).toBeNull();
    });

    it('coherent verdict → stamps the owner but skips the wipe', async () => {
        mockResolveIdentity.mockReturnValue('coherent');
        mockHasAnyFacts.mockImplementation(async () => { callOrder.push('count'); return true; });
        const { onComplete } = renderScreen();

        await waitFor(() => expect(onComplete).toHaveBeenCalled());
        expect(mockClearPreviousUserData).not.toHaveBeenCalled();
        expect(mockSetUserId).toHaveBeenCalledWith('u1');
    });

    it('passes the observed ownership fault into the verdict', async () => {
        mockHasIdentityFault.mockResolvedValue(true);
        renderScreen();
        await waitFor(() => expect(mockResolveIdentity).toHaveBeenCalled());
        expect(mockResolveIdentity).toHaveBeenCalledWith(
            expect.objectContaining({ ownershipFault: true, isConnected: true }),
        );
    });
});
