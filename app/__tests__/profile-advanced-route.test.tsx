/* eslint-disable @typescript-eslint/no-require-imports */
// app/logged-in/profile-advanced.tsx — routing only.
//
// The assertion that matters: the hub renders. This route gated its only child
// on `session.user.id` and rendered `null` otherwise, so a signed-in user who
// opened Advanced while /get-session could not be reached — offline, a
// keychain-locked background wake, a 401 blip — got a blank page. Identity is a
// LOCAL fact (lib/security/launch-route.ts); the persisted id is cleared only
// by an explicit logout.
import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => ({ GluestackUIProvider: ({ children }: any) => children }));
jest.mock('react-native-safe-area-context', () => {
    const { View } = require('react-native');
    return { SafeAreaView: (p: any) => <View {...p} /> };
});

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('expo-router', () => ({ router: { back: jest.fn() } }));

// Stub the hub so this suite stays a routing test — it records the userId it
// was handed, which is the whole contract of this route.
jest.mock('@/components/custom/profile/AdvancedHubScreen', () => {
    const ReactLib = require('react');
    return {
        __esModule: true,
        default: ({ userId }: any) =>
            ReactLib.createElement('View', { testID: 'advanced-hub', accessibilityLabel: userId }),
    };
});

const mockSessionRef = { current: { user: { id: 'u1' } } as { user: { id: string } } | null };
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSessionRef.current }) },
}));

// Selector-shaped — the route reads `useUserStore((s) => s.userId)`. Also keeps
// the real store's WatermelonDB adapter out of this suite.
const mockLocalUserIdRef = { current: 'local-u1' as string | null };
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (selector?: (s: unknown) => unknown) => {
        const state = { userId: mockLocalUserIdRef.current };
        return selector ? selector(state) : state;
    },
}));

import ProfileAdvanced from '../logged-in/profile-advanced';

beforeEach(() => {
    jest.clearAllMocks();
    mockSessionRef.current = { user: { id: 'u1' } };
    mockLocalUserIdRef.current = 'local-u1';
});

describe('profile-advanced route', () => {
    it('prefers the LOCAL id over the session id', () => {
        const { getByTestId } = render(<ProfileAdvanced />);
        expect(getByTestId('advanced-hub').props.accessibilityLabel).toBe('local-u1');
    });

    // The reported bug: a blank Advanced screen for a signed-in user.
    it('still renders the hub when the session cannot be fetched', () => {
        mockSessionRef.current = null;
        const { getByTestId } = render(<ProfileAdvanced />);
        expect(getByTestId('advanced-hub').props.accessibilityLabel).toBe('local-u1');
    });

    // Before hydrateFromDb() has run there is no local id yet — the session is
    // the fallback, so this window behaves exactly as it did before.
    it('falls back to the session id before local hydration', () => {
        mockLocalUserIdRef.current = null;
        const { getByTestId } = render(<ProfileAdvanced />);
        expect(getByTestId('advanced-hub').props.accessibilityLabel).toBe('u1');
    });

    // No identity anywhere is a genuinely logged-out device — unchanged.
    it('renders nothing when there is no identity at all', () => {
        mockLocalUserIdRef.current = null;
        mockSessionRef.current = null;
        const { queryByTestId } = render(<ProfileAdvanced />);
        expect(queryByTestId('advanced-hub')).toBeNull();
    });
});
