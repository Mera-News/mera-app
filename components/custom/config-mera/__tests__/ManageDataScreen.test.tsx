/* eslint-disable @typescript-eslint/no-require-imports */
// ManageDataScreen — delete-account flow (B6, Item 2b). The behaviour that
// matters: `authClient.deleteUser()` now 404s unconditionally on the server
// (immediate deletion was replaced by a 30-day grace period), so this suite
// pins the replacement call and its success/failure branching —
// better-auth's `$fetch` resolves `{data, error}` rather than throwing on a
// non-2xx response, so a request that "completed" without an `error` field
// must still be treated as success, and one WITH an `error` field must NOT
// run the local sign-out/cleanup or show the success toast.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const calls: string[] = [];

const mockFetch = jest.fn();
const mockSignOut = jest.fn(async () => { calls.push('signOut'); });
const mockClearAuthStorage = jest.fn(async () => { calls.push('clearAuthStorage'); });
jest.mock('@/lib/auth-client', () => ({
    authClient: {
        $fetch: (...a: any[]) => mockFetch(...a),
        signOut: () => mockSignOut(),
    },
    clearAuthStorage: () => mockClearAuthStorage(),
}));

jest.mock('@/lib/database', () => ({
    __esModule: true,
    default: { get: () => ({ query: () => ({ fetch: async () => [] }) }), write: async (fn: any) => fn() },
}));

jest.mock('@/lib/scheduler/AppScheduler', () => ({ AppScheduler: { trigger: jest.fn() } }));
jest.mock('@/lib/scheduler/scheduler-store', () => ({
    useSchedulerStore: { getState: () => ({ isRunning: () => false }) },
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({ clearAllVisits: jest.fn() }));
jest.mock('@/lib/services/scoring-pipeline', () => ({ abortRun: jest.fn() }));

const mockClearAllStores = jest.fn(async () => { calls.push('clearAllStores'); });
jest.mock('@/lib/stores', () => ({
    clearAllStores: () => mockClearAllStores(),
    useForYouStore: { getState: () => ({ clearData: jest.fn() }) },
}));
jest.mock('@/lib/stores/feed-order-store', () => ({ useFeedOrderStore: { getState: () => ({ reset: jest.fn() }) } }));
jest.mock('@/lib/diagnostics/coldstart-timeline', () => ({ arm: jest.fn() }));

const mockCloseModal = jest.fn();
const mockSetModalProcessing = jest.fn();
jest.mock('@/lib/stores/ui-store', () => ({
    useDeleteAccountModal: () => ({ isOpen: true, step: 'confirm', isProcessing: false }),
    useUIStore: () => ({
        openModal: jest.fn(),
        closeModal: mockCloseModal,
        setDeleteAccountStep: jest.fn(),
        setModalProcessing: mockSetModalProcessing,
    }),
}));

const mockReplace = jest.fn((...a: any[]) => { calls.push('replace'); return a; });
const mockDismissAll = jest.fn(() => { calls.push('dismissAll'); });
jest.mock('expo-router', () => ({
    router: { replace: (...a: any[]) => mockReplace(...a), dismissAll: () => mockDismissAll() },
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ScrollView's native component spec can't be parsed under Jest — proxy RN so
// it renders as a plain View; every other export stays lazy/real. Same
// pattern as ForYouSubTabs.test.tsx.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            return (target as any)[prop];
        },
    });
});

// --- chrome -----------------------------------------------------------------
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => {
    const { View } = require('react-native');
    return { GluestackUIProvider: ({ children }: any) => <View>{children}</View> };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable: (p: any) => <Pressable {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: ({ children, onPress, disabled, testID, ...p }: any) => (
            <Pressable onPress={onPress} disabled={disabled} testID={testID} {...p}>{children}</Pressable>
        ),
        ButtonText: ({ children }: any) => <Text>{children}</Text>,
    };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const passthrough = ({ children }: any) => <View>{children}</View>;
    return {
        Modal: ({ children, isOpen }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: () => null,
        ModalContent: passthrough,
        ModalHeader: passthrough,
        ModalBody: passthrough,
        ModalFooter: passthrough,
    };
});
jest.mock('@/components/ui/toast', () => {
    const { View, Text } = require('react-native');
    return {
        useToast: () => ({ show: (opts: any) => { calls.push('toast'); opts.render?.(); } }),
        Toast: (p: any) => <View {...p} />,
        ToastTitle: (p: any) => <Text {...p} />,
        ToastDescription: (p: any) => <Text {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import ManageDataScreen from '../ManageDataScreen';

describe('ManageDataScreen — delete account (grace-period flow)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        calls.length = 0;
    });

    it('posts to /request-account-deletion (never the removed deleteUser())', async () => {
        mockFetch.mockResolvedValue({ data: { success: true }, error: null });
        const { getByText } = render(<ManageDataScreen />);
        fireEvent.press(getByText('preferences.yesDeleteAccount'));

        await waitFor(() => expect(mockFetch).toHaveBeenCalled());
        expect(mockFetch).toHaveBeenCalledWith('/request-account-deletion', { method: 'POST' });
    });

    it('on success: signs out, clears local storage/stores, and navigates home — in that order', async () => {
        mockFetch.mockResolvedValue({ data: { success: true }, error: null });
        const { getByText } = render(<ManageDataScreen />);
        fireEvent.press(getByText('preferences.yesDeleteAccount'));

        await waitFor(() => expect(mockClearAllStores).toHaveBeenCalled());

        expect(calls).toEqual(
            expect.arrayContaining(['signOut', 'clearAuthStorage', 'dismissAll', 'replace', 'clearAllStores', 'toast']),
        );
        // signOut must precede clearAllStores — the local cleanup sequence.
        expect(calls.indexOf('signOut')).toBeLessThan(calls.indexOf('clearAllStores'));
    });

    it('a resolved {error} (non-2xx, no throw) is treated as FAILURE — no sign-out, no success toast', async () => {
        mockFetch.mockResolvedValue({ data: null, error: { status: 500, message: 'boom' } });
        const { getByText } = render(<ManageDataScreen />);
        fireEvent.press(getByText('preferences.yesDeleteAccount'));

        await waitFor(() => expect(mockSetModalProcessing).toHaveBeenCalledWith('deleteAccount', false));

        expect(mockSignOut).not.toHaveBeenCalled();
        expect(mockClearAuthStorage).not.toHaveBeenCalled();
        expect(mockClearAllStores).not.toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('a genuine throw from $fetch is also treated as failure', async () => {
        mockFetch.mockRejectedValue(new Error('offline'));
        const { getByText } = render(<ManageDataScreen />);
        fireEvent.press(getByText('preferences.yesDeleteAccount'));

        await waitFor(() => expect(mockSetModalProcessing).toHaveBeenCalledWith('deleteAccount', false));
        expect(mockSignOut).not.toHaveBeenCalled();
    });
});
