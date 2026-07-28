/* eslint-disable @typescript-eslint/no-require-imports */
import { act, render } from '@testing-library/react-native';
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
    useTranslation: () => ({ t: (k: string) => k }),
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => {
    const ReactLib = require('react');
    return {
        router: { push: (...a: any[]) => mockRouterPush(...a) },
        // The real hook runs the callback on focus and its teardown on blur;
        // a plain effect is the mounted-and-focused equivalent.
        useFocusEffect: (cb: () => void | (() => void)) => ReactLib.useEffect(cb, [cb]),
    };
});

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/icon', () => {
    const { View } = require('react-native');
    return { Icon: (p: any) => <View {...p} />, AlertCircleIcon: 'AlertCircleIcon' };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// --- child components → light stubs ----------------------------------------
// Mount counting happens in an EFFECT, not the render body: the acceptance is
// about mounts (which remount + refetch), and a render-body spy would count
// every re-render instead.
const mockListMount = jest.fn();
jest.mock('../ScopeArticleList', () => {
    const ReactLib = require('react');
    const { View } = require('react-native');
    const ScopeArticleListStub = ({ scope }: any) => {
        ReactLib.useEffect(() => {
            mockListMount(scope.id);
        }, []);
        return <View testID="scope-article-list" accessibilityLabel={scope.id} />;
    };
    return { __esModule: true, default: ScopeArticleListStub };
});

const mockChipRow = jest.fn();
jest.mock('../ScopeChipRow', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: (props: any) => {
            mockChipRow(props);
            return <View testID="scope-chip-row" />;
        },
    };
});

// --- services / stores ------------------------------------------------------
// Deliberately NOT synchronous: the real WatermelonDB observable emits after
// the first render, which is exactly the condition the flicker gate exists for.
let emitLocations: ((rows: any[]) => void) | null = null;
const mockUnsubscribe = jest.fn();
jest.mock('@/lib/database/services/location-service', () => ({
    observeAll: () => ({
        subscribe: (cb: (rows: any[]) => void) => {
            emitLocations = cb;
            return { unsubscribe: mockUnsubscribe };
        },
    }),
}));

jest.mock('@/lib/explore/device-country', () => ({
    // Device region differs from the persona home country — the whole point of
    // the test is that the list never mounts on this one.
    getDeviceCountryAlpha2: () => 'US',
}));

const mockSetSetting = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/lib/database/services/setting-service', () => ({
    setSetting: (...a: unknown[]) => mockSetSetting(...a),
}));

jest.mock('@/lib/stores/network-store', () => ({ useIsConnected: () => true }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import ExploreScreen from '../ExploreScreen';

const row = (over: Record<string, unknown> = {}) => ({
    id: 'loc1',
    city: 'mumbai',
    region: null,
    countryCode: 'IN',
    role: 'home',
    weight: 0.9,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    emitLocations = null;
});

describe('ExploreScreen — cold-open flicker gate', () => {
    it('holds the article list until locations emit, then mounts it exactly once on the primary country', () => {
        const { queryByTestId, getByTestId } = render(<ExploreScreen />);

        // Before the emission the chip row renders (against the device-country
        // fallback) but the list must not — mounting here would flash country:USA.
        expect(getByTestId('scope-chip-row')).toBeTruthy();
        expect(queryByTestId('scope-article-list')).toBeNull();
        expect(mockListMount).not.toHaveBeenCalled();

        act(() => {
            emitLocations!([row(), row({ id: 'loc2', city: 'paris', countryCode: 'FR', role: 'interest', weight: 0.4 })]);
        });

        // Exactly one mount, and on the persona home country — never on the
        // device fallback that the pre-emission render would have produced.
        expect(mockListMount).toHaveBeenCalledTimes(1);
        expect(mockListMount).toHaveBeenCalledWith('country:IND');
        expect(getByTestId('scope-article-list').props.accessibilityLabel).toBe('country:IND');
    });

    it('does not remount the list when the selection-resolving effect writes back the same id', () => {
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row()]);
        });
        // The effect sets selectedId to scopes[0].id, which selectedScope already
        // resolved to — the key is unchanged, so no second mount.
        act(() => {});
        expect(mockListMount).toHaveBeenCalledTimes(1);
    });

    it('re-emitting the same locations does not remount the list', () => {
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row()]);
        });
        act(() => {
            emitLocations!([row()]);
        });
        expect(mockListMount).toHaveBeenCalledTimes(1);
    });
});

describe('ExploreScreen — scopes and selection', () => {
    it('passes [primary country, …, World] to the chip row with the first chip selected', () => {
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row(), row({ id: 'loc2', countryCode: 'FR', role: 'interest', weight: 0.4 })]);
        });

        const props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        expect(props.scopes.map((s: any) => s.id)).toEqual(['country:IND', 'country:FRA', 'world']);
        expect(props.selectedId).toBe('country:IND');
        // No Top stories chip anywhere.
        expect(props.scopes.some((s: any) => s.id === 'top-stories')).toBe(false);
    });

    it('switching scope remounts the list on the new scope and persists the selection', () => {
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row()]);
        });
        expect(mockListMount).toHaveBeenCalledTimes(1);

        const props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        const world = props.scopes.find((s: any) => s.id === 'world');
        act(() => {
            props.onSelect(world);
        });

        expect(mockListMount).toHaveBeenCalledTimes(2);
        expect(mockListMount).toHaveBeenLastCalledWith('world');
        expect(mockSetSetting).toHaveBeenCalledWith('explore_last_scope', 'world');
    });

    it('snaps back to the first scope when the selected one disappears', () => {
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row(), row({ id: 'loc2', countryCode: 'FR', role: 'interest', weight: 0.4 })]);
        });

        const props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        act(() => {
            props.onSelect(props.scopes.find((s: any) => s.id === 'country:FRA'));
        });
        expect(mockListMount).toHaveBeenLastCalledWith('country:FRA');

        // France removed from the user's locations.
        act(() => {
            emitLocations!([row()]);
        });
        expect(mockListMount).toHaveBeenLastCalledWith('country:IND');
    });
});
