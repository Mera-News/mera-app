/* eslint-disable @typescript-eslint/no-require-imports */
// app/logged-in/onboarding.tsx — routing only.
//
// The one assertion that matters: `onLoginRedirect` (the escape hatch the
// identity gate pulls when session and local identity are unresolvably out of
// sync) must navigate to /login WITH reauth:'1'. login.tsx:23 redirects any
// live session straight back to /logged-in/onboarding unless reauthMode is on,
// so a missing param turns the recovery path into an infinite bounce.
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
    router: { replace: (...a: any[]) => mockReplace(...a) },
    Redirect: () => null,
}));

let mockSession: any = { user: { id: 'u1' } };
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: mockSession, isPending: false }) } }));

// Stand-in for the gate: immediately pulls whichever escape hatch the test asks
// for, so the route's handlers are exercised without the real gate's DB reads.
let mockInvoke: 'login' | 'complete' | null = null;
jest.mock('@/components/custom/onboarding/OnboardingScreen', () => {
    const React2 = require('react');
    const GateStub = ({ onLoginRedirect, onComplete }: any) => {
        React2.useEffect(() => {
            if (mockInvoke === 'login') onLoginRedirect();
            if (mockInvoke === 'complete') onComplete();
        }, [onLoginRedirect, onComplete]);
        return null;
    };
    return { __esModule: true, default: GateStub };
});

import Onboarding from '../logged-in/onboarding';

beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { user: { id: 'u1' } };
    mockInvoke = null;
});

describe('onboarding route', () => {
    it('onLoginRedirect navigates to /login WITH reauth:"1"', async () => {
        mockInvoke = 'login';
        render(<Onboarding />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        expect(mockReplace).toHaveBeenCalledWith({
            pathname: '/login',
            params: { reauth: '1' },
        });
    });

    it('onComplete navigates to the dashboard with fromOnboarding', async () => {
        mockInvoke = 'complete';
        render(<Onboarding />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalled());
        expect(mockReplace).toHaveBeenCalledWith({
            pathname: '/logged-in/app_container/for_you',
            params: { fromOnboarding: '1' },
        });
    });
});
