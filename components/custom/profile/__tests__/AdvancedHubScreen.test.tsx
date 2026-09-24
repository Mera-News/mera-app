/* eslint-disable @typescript-eslint/no-require-imports */
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim — same as ProfileScreen.test.tsx.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: any) => o?.defaultValue ?? _k }),
}));

jest.mock('expo-router', () => ({
    router: { push: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => void) => { const React2 = require('react'); React2.useEffect(cb, []); },
}));

// Same ScrollView-to-View proxy jest-expo needs — see ProfileScreen.test.tsx.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            return (target as any)[prop];
        },
    });
});

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// --- services / stores ------------------------------------------------------
jest.mock('@/components/custom/BlockedBanner', () => { const { Text } = require('react-native'); return { __esModule: true, default: () => <Text>blocked-banner</Text> }; });
jest.mock('@/components/custom/not-interested/use-not-interested-data', () => ({
    useNotInterestedData: () => ({ total: 0, isLoading: false, filters: [], topics: [], mutedSources: [] }),
}));
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: () => Promise.resolve([]) }));
jest.mock('@/lib/database/services/publication-preference-service', () => ({ getActive: () => Promise.resolve([]) }));
jest.mock('@/lib/database/services/hygiene-service', () => ({
    getPendingCount: () => Promise.resolve(0),
    subscribeHygieneChange: () => () => {},
}));
jest.mock('@/lib/stores/floating-chat-store', () => ({ useFloatingChatFactMutationVersion: () => 0 }));
// STABLE references, not a fresh object per call: AdvancedHubScreen's init
// effect depends on `userPersona`/`fetchUserPersona` directly, and a mock that
// hands back a new object (and a new `jest.fn()`) on every render re-fires
// that effect every render — `setIsLoading` flaps true/false forever and
// `getByTestId` only "sees" the settled tree on a lucky poll. React's own
// "Maximum update depth" warning is silent here because jest.setup.js mutes
// console.error/warn globally, so this fails quietly, not loudly.
const mockUserPersona = { _id: 'p1', blockedByLlm: false };
const mockFetchUserPersona = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: () => ({ userPersona: mockUserPersona, fetchUserPersona: mockFetchUserPersona }),
}));
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));

import AdvancedHubScreen from '../AdvancedHubScreen';

describe('AdvancedHubScreen', () => {
    it('no longer renders the Refresh Suggestions control — it moved to Profile', async () => {
        const { queryByTestId, getByTestId } = render(<AdvancedHubScreen userId="u1" onBack={jest.fn()} />);
        await waitFor(() => expect(getByTestId('advanced-row-facts')).toBeTruthy());
        expect(queryByTestId('advanced-hub-refresh-suggestions')).toBeNull();
        expect(queryByTestId('advanced-hub-refresh-hint')).toBeNull();
    });
});
