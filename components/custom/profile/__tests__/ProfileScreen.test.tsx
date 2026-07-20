/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
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
    router: { push: jest.fn() },
    useFocusEffect: (cb: () => void) => { const React2 = require('react'); React2.useEffect(cb, []); },
}));

// jest-expo mis-transforms RN's ScrollView native-component file ("Unexpected
// token 'export'"). Proxy RN so ScrollView renders as a plain View; every other
// export stays lazy/real (our ui mocks read View/Text/Pressable/Modal).
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
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// --- child components → light stubs ----------------------------------------
jest.mock('@/components/custom/BlockedBanner', () => { const { Text } = require('react-native'); return { __esModule: true, default: () => <Text>blocked-banner</Text> }; });
jest.mock('@/components/custom/MeraLogo', () => { const { View } = require('react-native'); return { __esModule: true, default: () => <View testID="mera-logo" /> }; });
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});
jest.mock('@/components/custom/profile-hub/HubRow', () => {
    const { Pressable, Text } = require('react-native');
    return { __esModule: true, default: ({ label, onPress }: any) => <Pressable accessibilityLabel={label} onPress={onPress}><Text>{label}</Text></Pressable> };
});
jest.mock('@/components/custom/profile/PersonaStringSheet', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ visible, row }: any) => (visible ? <Text>sheet:{row?.text}</Text> : null) };
});

// --- services / stores ------------------------------------------------------
const mockGetFacts = jest.fn();
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: (...a: unknown[]) => mockGetFacts(...a) }));

let mockObservedRows: any[] = [];
jest.mock('@/lib/database/services/persona-summary-service', () => ({
    observeSummaryStrings: () => ({ subscribe: (cb: (rows: any[]) => void) => { cb(mockObservedRows); return { unsubscribe: jest.fn() }; } }),
    toRow: (r: any) => r,
}));

const mockRegen = jest.fn();
jest.mock('@/lib/database/services/persona-summary-trigger', () => ({ maybeRegeneratePersonaSummary: (...a: unknown[]) => mockRegen(...a) }));

jest.mock('@/lib/haptics', () => ({ hapticMedium: jest.fn() }));

const mockExpand = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatFactMutationVersion: () => 0,
    useFloatingChatStore: { getState: () => ({ expand: mockExpand }) },
}));

jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: () => ({ userPersona: { blockedByLlm: false }, fetchUserPersona: jest.fn() }),
}));

jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));

import ProfileScreen from '../ProfileScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockObservedRows = [];
});

describe('ProfileScreen', () => {
    it('empty persona → shows the empty-state CTA and no About-you rows', async () => {
        mockGetFacts.mockResolvedValue([]);
        const { getByText, queryByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText("I don't know you yet")).toBeTruthy());
        expect(queryByText('ABOUT YOU')).toBeNull();
        // Advanced row still present.
        expect(getByText('Advanced')).toBeTruthy();
    });

    it('with facts + strings → renders the About-you strings and opens the sheet on tap', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Lives in Pune' }]);
        mockObservedRows = [
            { id: 's1', text: 'Lives in Pune with family', linkedFactIds: ['f1'], linkedTopicIds: ['t1'], generatedAt: 1, personaVersion: 'v', stale: false },
        ];
        const { getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('Lives in Pune with family')).toBeTruthy());
        expect(getByText('Talk to Mera')).toBeTruthy();

        fireEvent.press(getByText('Lives in Pune with family'));
        expect(getByText('sheet:Lives in Pune with family')).toBeTruthy();
    });

    it('mirror CTA opens the persona chat', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByLabelText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(mockGetFacts).toHaveBeenCalled());
        fireEvent.press(getByLabelText('Talk to Mera'));
        expect(mockExpand).toHaveBeenCalledWith({ kind: 'persona' });
    });

    it('regenerates the summary on focus', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(mockRegen).toHaveBeenCalled());
    });
});
