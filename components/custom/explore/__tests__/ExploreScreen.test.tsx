/* eslint-disable @typescript-eslint/no-require-imports */
import { act, render } from '@testing-library/react-native';
import React from 'react';

// The animated gradient backdrop is pure decoration and asserts nothing here.
// Stubbing it avoids pulling its own (unrelated) reanimated usage into this
// suite. reanimated itself, however, can no longer be kept out of the module
// graph entirely: ExploreScreen now uses the collapsible-header hook (worklet
// scroll handler + Animated.View), whose native worklets runtime cannot
// initialise under Jest — so it's mocked below instead, the same way
// DashboardSectionsFeed.test.tsx mocks it.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: { View },
        useAnimatedScrollHandler: (config: any) => config,
        useAnimatedStyle: (fn: any) => {
            try {
                return fn();
            } catch {
                return {};
            }
        },
        useSharedValue: (initial: any) => ({ value: initial }),
        withTiming: (value: any) => value,
    };
});

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
const mockListRender = jest.fn();
jest.mock('../ScopeArticleList', () => {
    const ReactLib = require('react');
    const { View } = require('react-native');
    const ScopeArticleListStub = ({ scope, enabled }: any) => {
        mockListRender({ scopeId: scope.id, enabled });
        ReactLib.useEffect(() => {
            mockListMount(scope.id);
        }, []);
        return (
            <View
                testID="scope-article-list"
                accessibilityLabel={scope.id}
                accessibilityState={{ disabled: !enabled }}
            />
        );
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
// Backs lib/explore/browse-countries.ts + lib/explore/suppressed-scopes.ts too
// (both real modules, not mocked — they're pure aside from this KV layer).
// Empty by default so browseCountries/suppressedIds resolve to their
// no-op-empty defaults and every pre-existing assertion below is unaffected.
const mockGetSetting = jest.fn((..._a: unknown[]): Promise<string | null> => Promise.resolve(null));
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
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
    it('RENDERS the list from the first commit but leaves its query disabled until locations emit', () => {
        // The gate moved from the MOUNT to the QUERY. It has to: react-native-
        // screens walks `subviews[0]` from the tab screen exactly once, when the
        // screen's first child mounts, to find the tab's scroll view — a list
        // that is not on screen in that first commit is never registered, and
        // iOS 26 tab-bar minimize never engages on this tab. So the list is
        // always present; only its fetch is held back.
        const { getByTestId } = render(<ExploreScreen />);

        expect(getByTestId('scope-chip-row')).toBeTruthy();
        expect(getByTestId('scope-article-list')).toBeTruthy();
        expect(mockListRender).toHaveBeenLastCalledWith(
            expect.objectContaining({ enabled: false }),
        );

        act(() => {
            emitLocations!([row(), row({ id: 'loc2', city: 'paris', countryCode: 'FR', role: 'interest', weight: 0.4 })]);
        });

        expect(mockListRender).toHaveBeenLastCalledWith({ scopeId: 'world', enabled: true });

        // Exactly one mount. World now leads the row, so that is the landing
        // chip — the point of the gate is still that the pre-emission render
        // (device-country fallback) never reaches the list.
        expect(mockListMount).toHaveBeenCalledTimes(1);
        expect(mockListMount).toHaveBeenCalledWith('world');
        expect(getByTestId('scope-article-list').props.accessibilityLabel).toBe('world');
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
    it('passes [World, primary country, …] to the chip row with the first chip selected', () => {
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row(), row({ id: 'loc2', countryCode: 'FR', role: 'interest', weight: 0.4 })]);
        });

        const props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        expect(props.scopes.map((s: any) => s.id)).toEqual(['world', 'country:IND', 'country:FRA']);
        expect(props.selectedId).toBe('world');
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
        const india = props.scopes.find((s: any) => s.id === 'country:IND');
        act(() => {
            props.onSelect(india);
        });

        expect(mockListMount).toHaveBeenCalledTimes(2);
        expect(mockListMount).toHaveBeenLastCalledWith('country:IND');
        expect(mockSetSetting).toHaveBeenCalledWith('explore_last_scope', 'country:IND');
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
        expect(mockListMount).toHaveBeenLastCalledWith('world');
    });
});

// Flush the browse-countries/suppressed-scopes focus-effect promise chain
// (getSetting → JSON.parse → Promise.all → setState), which takes a few more
// microtask turns than the synchronous emitLocations! path above.
const flushKvLoad = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};

// mockGetSetting is typed as (...args: unknown[]) => Promise<string | null> —
// this stubs a per-key lookup on top of that without narrowing the param type
// (a `(key: string) => ...` override isn't assignable to mockImplementation's
// expected `(...args: unknown[]) => ...` signature).
const stubSettingByKey = (overrides: Record<string, string>) => (...args: unknown[]) => {
    const key = args[0] as string;
    return Promise.resolve(Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null);
};

describe('ExploreScreen — browse countries + suppressed scopes (Items 7/18)', () => {
    afterEach(() => {
        // Tests below override mockGetSetting per-key; restore the blanket
        // default so it never leaks into a later test.
        mockGetSetting.mockImplementation((..._a: unknown[]) => Promise.resolve(null));
    });

    it('appends a browse country after location-derived ones and passes onRemove through', async () => {
        mockGetSetting.mockImplementation(stubSettingByKey({ explore_browse_countries: JSON.stringify(['FR']) }));
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row()]); // IN, role: home
        });
        await flushKvLoad();

        const props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        expect(props.scopes.map((s: any) => s.id)).toEqual(['world', 'country:IND', 'country:FRA']);
        expect(typeof props.onRemove).toBe('function');
    });

    it('filters out a suppressed location-derived scope but never World', async () => {
        mockGetSetting.mockImplementation(
            stubSettingByKey({ explore_suppressed_scopes: JSON.stringify(['country:IND']) }),
        );
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row()]);
        });
        await flushKvLoad();

        const props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        expect(props.scopes.map((s: any) => s.id)).toEqual(['world']);
    });

    it('onRemove on a location-derived scope suppresses it (KV) without touching the browse set', async () => {
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row()]);
        });
        await flushKvLoad();

        let props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        const india = props.scopes.find((s: any) => s.id === 'country:IND');
        act(() => {
            props.onRemove(india);
        });
        // addSuppressedScopeId itself awaits getSetting THEN setSetting — two
        // more microtask hops beyond the synchronous local setState above.
        await flushKvLoad();

        expect(mockSetSetting).toHaveBeenCalledWith('explore_suppressed_scopes', JSON.stringify(['country:IND']));
        expect(mockSetSetting).not.toHaveBeenCalledWith('explore_browse_countries', expect.anything());
        props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        expect(props.scopes.map((s: any) => s.id)).toEqual(['world']);
    });

    it('onRemove on a browse-added scope drops it from the browse set, not the suppressed set', async () => {
        mockGetSetting.mockImplementation(stubSettingByKey({ explore_browse_countries: JSON.stringify(['FR']) }));
        render(<ExploreScreen />);
        act(() => {
            emitLocations!([row()]); // IN, role: home — FR has no location behind it
        });
        await flushKvLoad();

        let props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        const france = props.scopes.find((s: any) => s.id === 'country:FRA');
        act(() => {
            props.onRemove(france);
        });
        // removeBrowseCountry itself awaits getSetting THEN setSetting — two
        // more microtask hops beyond the synchronous local setState above.
        await flushKvLoad();

        expect(mockSetSetting).toHaveBeenCalledWith('explore_browse_countries', JSON.stringify([]));
        expect(mockSetSetting).not.toHaveBeenCalledWith('explore_suppressed_scopes', expect.anything());
        props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        expect(props.scopes.some((s: any) => s.id === 'country:FRA')).toBe(false);
    });
});
