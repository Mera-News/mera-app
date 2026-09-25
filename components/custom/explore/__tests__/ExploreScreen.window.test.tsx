/* eslint-disable @typescript-eslint/no-require-imports */
// ux2 B3, owner on device: "while swiping i see the next section which is
// coming to the view port to look like the current section". The REAL pager
// and a list stand-in that draws the scope it was GIVEN (as ScopeArticleList
// fetches by its own `scope` prop): each warmed neighbour must already show
// its own scope while another is active.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
    const R = require('react');
    return {
        __esModule: true,
        default: { View },
        useAnimatedScrollHandler: (config: any) => config,
        // Live, as on device (the REAL SwipeTabs reads its row offset here).
        useAnimatedStyle: (fn: any) =>
            new Proxy({}, {
                get: (_t, k) => { try { return fn()[k]; } catch { return undefined; } },
                ownKeys: () => { try { return Reflect.ownKeys(fn()); } catch { return []; } },
                getOwnPropertyDescriptor: (_t, k) => ({ enumerable: true, configurable: true, value: (() => { try { return fn()[k]; } catch { return undefined; } })() }),
            }),
        useSharedValue: (initial: any) => R.useRef({ value: initial }).current,
        useReducedMotion: () => false,
        withSpring: (v: any) => v,
        withTiming: (value: any, _c?: unknown, cb?: (f: boolean) => void) => {
            if (cb) cb(true);
            return value;
        },
        runOnJS: (fn: any) => fn,
    };
});
const mockPan: Record<string, any> = {};
jest.mock('react-native-gesture-handler', () => {
    const chain: any = new Proxy({}, { get: (_t, key: string) => (arg: unknown) => { mockPan[key] = arg; return chain; } });
    return { Gesture: { Pan: () => chain }, GestureDetector: ({ children }: any) => children };
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
    const ScopeArticleListStub = ({ scope, enabled, active }: any) => {
        mockListRender({ scopeId: scope.id, enabled, active });
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

// --- Item 12a: search bar/results stubs + the state hook they read --------
// ExploreSearchBar/ExploreSearchResults are exercised by their own test
// files; here they're stubbed so this suite stays focused on the INTEGRATION
// question — does activating search ever disturb the scope chips/list — and
// isn't coupled to their internal markup.
type MockSearchStatus = 'idle' | 'loading' | 'success' | 'error';
const defaultSearchState = () => ({
    query: '',
    setQuery: jest.fn(),
    clear: jest.fn(),
    status: 'idle' as MockSearchStatus,
    hits: [] as any[],
    errorKind: null as string | null,
    retry: jest.fn(),
    isActive: false,
});
const mockUseNewsSearch = jest.fn<ReturnType<typeof defaultSearchState>, []>(defaultSearchState);
jest.mock('@/lib/news-search/use-news-search', () => ({
    useNewsSearch: () => mockUseNewsSearch(),
}));

const mockOpenArticle = jest.fn();
jest.mock('@/lib/hooks/use-open-article', () => ({
    useOpenArticle: () => mockOpenArticle,
}));

const mockSearchBar = jest.fn();
jest.mock('../ExploreSearchBar', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: (props: any) => {
            mockSearchBar(props);
            return <View testID="explore-search-bar-stub" />;
        },
    };
});

jest.mock('@/components/custom/notifications/NotificationBellButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="bell" /> };
});
jest.mock('@/components/custom/for-you/TabExplainerButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID={p.testID} tab={p.tab} /> };
});

const mockSearchResults = jest.fn();
jest.mock('../ExploreSearchResults', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: (props: any) => {
            mockSearchResults(props);
            return <View testID="explore-search-results-stub" />;
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

const HIDDEN = { includeHiddenElements: true } as const;
const row = (over: Record<string, unknown> = {}) => ({
    id: 'loc1', city: 'mumbai', region: null, countryCode: 'IN', role: 'home', weight: 0.9, ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    emitLocations = null;
    mockUseNewsSearch.mockReturnValue(defaultSearchState());
});

/** The scope ids a mounted panel's list draws. */
const listsIn = (r: any, scopeId: string) =>
    r
        .getByTestId(`explore-swipe-tabs-panel-${scopeId}`, HIDDEN)
        .findAll((n: any) => n.props?.testID === 'scope-article-list' && typeof n.type === 'string')
        .map((n: any) => n.props.accessibilityLabel);

describe('Explore swipe window: every panel draws its own scope', () => {
    it('with the middle scope active, both neighbours show their own scope', () => {
        const r = render(<ExploreScreen />);
        act(() => {
            emitLocations!([row(), row({ id: 'loc2', countryCode: 'FR', role: 'interest', weight: 0.4 })]);
        });
        fireEvent(r.getByTestId('explore-swipe-tabs'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 402, height: 800 } } });
        const props = mockChipRow.mock.calls[mockChipRow.mock.calls.length - 1][0];
        const ids = props.scopes.map((s: any) => s.id);
        expect(ids.length).toBeGreaterThanOrEqual(3);
        act(() => props.onSelect(props.scopes[1]));
        for (const id of ids.slice(0, 3)) expect(listsIn(r, id)).toEqual([id]);
    });
});
