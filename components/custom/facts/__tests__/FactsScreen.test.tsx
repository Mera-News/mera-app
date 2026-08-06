/* eslint-disable @typescript-eslint/no-require-imports */
// FactsScreen — the offline/local-identity contract.
//
// Facts are device-local and ARE the product, so nothing on this screen may
// wait on a server session. It used to read `session.user.id` and bail out of
// pull-to-refresh entirely (`if (!userId) return`) whenever /get-session could
// not be reached — offline, a keychain-locked background wake, a 401 blip —
// which showed a refresh spinner that reloaded nothing for a user who had never
// logged out. Identity is a LOCAL fact (lib/security/launch-route.ts).
import { act, render } from '@testing-library/react-native';
import React from 'react';

// RN's real ScrollView doesn't load in this Jest env (its native view config
// ships untranspiled) — the same reason ScopeArticleList.test.tsx replaces the
// whole react-native module with host elements. The ScrollView stub also parks
// its props so the test can pull the RefreshControl's onRefresh back out.
const mockScrollProps = { current: null as any };
jest.mock('react-native', () => {
    const ReactLib = require('react');
    const host = (name: string) => (props: any) => ReactLib.createElement(name, props, props.children);
    const View = host('View');
    return {
        __esModule: true,
        View,
        Text: host('Text'),
        Pressable: host('Pressable'),
        RefreshControl: (props: any) => ReactLib.createElement(View, props),
        ScrollView: (props: any) => {
            mockScrollProps.current = props;
            return ReactLib.createElement(View, props, props.children);
        },
        Platform: { OS: 'ios', select: (o: any) => o.ios },
        StyleSheet: { create: (s: any) => s, flatten: (s: any) => s },
    };
});

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: any) => o?.defaultValue ?? k }),
}));

// UI primitives → host elements. With react-native itself mocked above, the
// real gluestack/NativeWind implementations have nothing to build on.
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable: (p: any) => <Pressable {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { View, Text } = require('react-native');
    return { Button: (p: any) => <View {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const stub = (p: any) => <View {...p} />;
    return {
        Modal: (p: any) => (p.isOpen ? <View {...p} /> : null),
        ModalBackdrop: stub, ModalBody: stub, ModalContent: stub,
        ModalFooter: stub, ModalHeader: stub,
    };
});

jest.mock('@/components/custom/config-panel/DrillDownHeader', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/subscription/FreeTierReadOnlyBanner', () => ({
    __esModule: true,
    default: () => null,
    useFreeTierReadOnly: () => false,
}));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: jest.fn(),
    withAppLanguage: (u: string) => u,
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({ useIsOnDeviceProcessing: () => false }));

// FactsList owns the local facts data; the screen only drives it through the
// imperative `refresh()` handle its RefreshControl calls.
const mockListRefresh = jest.fn(() => Promise.resolve());
jest.mock('../FactsList', () => {
    const React2 = require('react');
    const Stub = React2.forwardRef((props: any, ref: any) => {
        React2.useImperativeHandle(ref, () => ({ refresh: () => mockListRefresh() }));
        React2.useEffect(() => { props.onFactsChange?.([{ id: 'f1', statement: 'Lives in Pune' }]); }, []);
        return null;
    });
    Stub.displayName = 'FactsListStub';
    return { __esModule: true, default: Stub };
});

const mockSessionRef = { current: { user: { id: 'u1' } } as { user: { id: string } } | null };
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSessionRef.current }) },
}));

// Selector-shaped — the screen reads `useUserStore((s) => s.userId)` as well as
// destructuring actions off a bare call.
const mockFetchUserPersona = jest.fn(() => Promise.resolve(null));
const mockLocalUserIdRef = { current: 'u1' as string | null };
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (selector?: (s: unknown) => unknown) => {
        const state = { userId: mockLocalUserIdRef.current, fetchUserPersona: mockFetchUserPersona };
        return selector ? selector(state) : state;
    },
}));

import FactsScreen from '../FactsScreen';

async function pullToRefresh() {
    await act(async () => {
        await mockScrollProps.current.refreshControl.props.onRefresh();
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockScrollProps.current = null;
    mockSessionRef.current = { user: { id: 'u1' } };
    mockLocalUserIdRef.current = 'u1';
});

describe('FactsScreen', () => {
    it('pull-to-refresh reloads facts and the persona when the session is healthy', async () => {
        render(<FactsScreen onBack={jest.fn()} />);
        await pullToRefresh();

        expect(mockListRefresh).toHaveBeenCalled();
        expect(mockFetchUserPersona).toHaveBeenCalledWith('u1', true);
    });

    it('pull-to-refresh still works off the LOCAL id when the session cannot be fetched', async () => {
        mockSessionRef.current = null;
        render(<FactsScreen onBack={jest.fn()} />);

        // The mount hydration is the half that matters on a cold offline open —
        // it must fire off the local id before anyone pulls to refresh.
        expect(mockFetchUserPersona).toHaveBeenCalledWith('u1');
        mockFetchUserPersona.mockClear();

        await pullToRefresh();

        expect(mockListRefresh).toHaveBeenCalled();
        expect(mockFetchUserPersona).toHaveBeenCalledWith('u1', true);
    });

    // Genuinely no identity anywhere: the LOCAL reload must still happen. Only
    // the server-side persona refresh is skipped.
    it('reloads the local facts even with no identity at all', async () => {
        mockSessionRef.current = null;
        mockLocalUserIdRef.current = null;
        render(<FactsScreen onBack={jest.fn()} />);
        await pullToRefresh();

        expect(mockListRefresh).toHaveBeenCalled();
        expect(mockFetchUserPersona).not.toHaveBeenCalled();
    });
});
