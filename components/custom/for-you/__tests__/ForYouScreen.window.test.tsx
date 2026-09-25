/* eslint-disable @typescript-eslint/no-require-imports */
// ux2 B3, owner on device: "while swiping i see the next section which is
// coming to the view port to look like the current section". The REAL pager,
// with stand-ins that keep their identity: while one tab is active, each
// warmed neighbour must already draw ITS OWN tab, and a drag must reveal it.
// The Dashboard header (D6, N11, F16, N4, ux1). Every child screen and store is
// stubbed: this suite is about which rows the header draws and when.

jest.mock('react-native-css-interop/jsx-runtime', () => {
  const R = require('react/jsx-runtime');
  return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const R = require('react/jsx-dev-runtime');
  return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

function mockStub(testID: string) {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID={testID} /> };
}
/** A stub that keeps the `active` prop it was given, for the swipe window. */
function mockActiveStub(testID: string) {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID={testID} active={p.active} /> };
}
let mockProcessing = false;
let mockLastNewArticlesAt: number | null = null;
let mockFontScale = 1;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    // What the REAL SwipeTabs uses. Styles read shared values live.
    useSharedValue: (v: number) => R.useRef({ value: v }).current,
    useAnimatedStyle: (fn: () => Record<string, unknown>) =>
      new Proxy({}, {
        get: (_t, k) => (fn() as any)[k],
        ownKeys: () => Reflect.ownKeys(fn()),
        getOwnPropertyDescriptor: (_t, k) => ({ enumerable: true, configurable: true, value: (fn() as any)[k] }),
      }),
    useReducedMotion: () => false,
    withSpring: (v: number) => v,
    withTiming: (v: number, _c: unknown, cb?: (f: boolean) => void) => {
      if (cb) cb(true);
      return v;
    },
    runOnJS: (fn: any) => fn,
  };
});
const mockPan: Record<string, any> = {};
jest.mock('react-native-gesture-handler', () => {
  const chain: any = new Proxy({}, { get: (_t, key: string) => (arg: unknown) => { mockPan[key] = arg; return chain; } });
  return { Gesture: { Pan: () => chain }, GestureDetector: ({ children }: any) => children };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 85, left: 0, right: 0 }),
}));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 402, height: 874, scale: 3, fontScale: mockFontScale }),
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => mockStub('backdrop'));
jest.mock('@/lib/diagnostics/coldstart-timeline', () => ({ mark: jest.fn() }));
let mockLocal = false;
let mockStatusMode = 'idle';
jest.mock('@/components/custom/FeedSyncIndicator', () => ({
  useFeedSyncRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }),
  useIsFeedProcessing: () => mockProcessing,
}));
jest.mock('@/components/custom/for-you/use-mark-active', () => ({
  useIsFeedMarkActive: () => mockLocal,
}));
jest.mock('@/components/custom/feed/FeedStatusMark', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID={p.testID} mode={p.mode} /> };
});
jest.mock('@/components/custom/for-you/FeedStatusIndicator', () => mockStub('dashboard-status-indicator'));
jest.mock('@/components/custom/for-you/FeedStatusPanel', () => mockStub('status-panel'));
jest.mock('@/components/custom/HeaderWorkingGradient', () => mockStub('working-gradient'));
jest.mock('@/components/custom/for-you/HeaderNarrationLine', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: (p: any) => <Text testID={p.testID} numberOfLines={p.maxLines}>narration</Text>,
  };
});
jest.mock('@/components/custom/for-you/TabExplainerButton', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID={p.testID} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/heading', () => {
  const { Text } = require('react-native');
  return { Heading: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@/components/custom/processing/use-processing-snapshot', () => ({
  useProcessingSnapshot: () => ({ stage: 'analysing' }),
}));
jest.mock('@/lib/hooks/use-feed-status-mode', () => ({ useFeedStatusMode: () => mockStatusMode }));
jest.mock('@/lib/hooks/use-status-disclosure', () => ({
  useStatusDisclosure: () => ({ expanded: false, toggle: jest.fn() }),
}));
jest.mock('@/components/custom/GlassSurface', () => ({
  GLASS_HEADER_SCRIM: 'rgba(0,0,0,0.42)',
  GLASS_HEADER_TINT: 'rgba(255,255,255,0.16)',
  GlassHeaderAndroidBackdrop: () => null,
  GlassPlate: () => null,
}));
jest.mock('@/components/custom/notifications/NotificationBellButton', () => mockStub('bell'));
jest.mock('@/components/custom/for-you/DashboardEmptyState', () => mockStub('empty-state'));
jest.mock('@/components/custom/for-you/ForYouSubTabs', () => {
  const { Pressable, Text, View } = require('react-native');
  const keys = ['feed', 'stories', 'saved', 'factChecks', 'history'];
  return {
    __esModule: true,
    FOR_YOU_SUB_TAB_ORDER: keys,
    default: ({ onSelect, bleed }: any) => (
      <View testID="subtabs" bleed={bleed}>
        {keys.map((k) => (
          <Pressable key={k} testID={`subtab-${k}`} onPress={() => onSelect(k)}>
            <Text>{k}</Text>
          </Pressable>
        ))}
      </View>
    ),
  };
});
jest.mock('@/components/custom/for-you/StoriesSlotPlaceholder', () => mockStub('stories'));
jest.mock('@/components/custom/for-you/DashboardSectionsFeed', () => mockActiveStub('sections'));
jest.mock('@/components/custom/for-you/status-dropdown', () => ({
  StatusDropdownProvider: ({ children }: any) => children,
  StatusDropdownLayer: () => {
    const { View } = require('react-native');
    return <View testID="stats-dropdown-layer" />;
  },
}));
jest.mock('@/components/custom/fact-checks/FactChecksPanel', () => mockActiveStub('fact-checks'));
jest.mock('@/components/custom/for-you/FeedStatsSentence', () => mockStub('stats-sentence'));
jest.mock('@/components/custom/saved-suggestions/SavedSuggestionsScreen', () => mockActiveStub('saved'));
// Reports 3 rows, as a loaded History list does, so the share button has
// something to share.
jest.mock('@/components/custom/config-panel/VisitedPublicationsList', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: (p: any) => {
      R.useEffect(() => p.onCountChange?.(3), []);
      return <View testID="visited" active={p.active} />;
    },
  };
});
jest.mock('@/components/custom/ShareStatsFab', () => mockStub('share-fab'));
jest.mock('@/components/custom/StatusBarScrim', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID="scrim" coverProgress={p.coverProgress} /> };
});
jest.mock('@/lib/stores/fact-rows-selector', () => ({ buildFactRows: () => ({ breaking: [], rows: [] }) }));
jest.mock('@/components/custom/for-you/use-section-snapshots', () => ({ useSectionSnapshots: () => null }));
jest.mock('@/lib/user-context/user-geo-language-context', () => ({ useUserGeoLanguageContext: () => null }));
jest.mock('@/lib/news-harness/core/config', () => ({ DEFAULT_HARNESS_CONFIG: {} }));
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: null }) } }));
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: jest.fn(() => Promise.resolve([])) }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock('@/lib/stores/for-you-store', () => ({ useForYouStore: { getState: () => ({}) } }));
jest.mock('@/lib/stores/database-store', () => ({ useDatabaseStore: (sel: any) => sel({ ready: true }) }));
jest.mock('@/lib/stores/selectors', () => ({
  useForYouAsyncJobPhase: () => 'idle',
  useForYouDeviceProcessing: () => ({ isDeviceProcessing: false }),
  useForYouHasGeneratedTopics: () => true,
  useForYouLastNewArticlesAt: () => mockLastNewArticlesAt,
  useForYouLastProcessingRunFinishedAt: () => Date.now() - 120_000,
  useForYouSuggestions: () => [],
  useForYouSyncStatusMessage: () => null,
  useForYouScoringError: () => null,
  useForYouDailyLimitResetAt: () => null,
  useForYouUnscoredCount: () => 0,
}));
jest.mock('@/lib/feed-ordering/dashboard-resort', () => ({
  DASHBOARD_RESORT_INTERVAL_MS: 600_000,
  msUntilResortDue: () => 600_000,
  shouldResort: () => false,
}));
jest.mock('@/lib/stores/feed-order-store', () => ({ useFeedOrderStore: { getState: () => ({ cardStates: {} }) } }));
jest.mock('@/lib/hooks/use-feed-bootstrap', () => ({ useFeedBootstrap: () => ({ isLoading: false, errorMessage: null }) }));
jest.mock('@/lib/hooks/use-open-suggestion', () => ({ useOpenSuggestion: () => jest.fn() }));
jest.mock('@/lib/hooks/use-collapsible-header', () => ({
  useCollapsibleHeader: () => ({
    scrollHandler: {},
    headerStyle: {},
    onHeaderLayout: jest.fn(),
    headerHeight: 200,
    reveal: jest.fn(),
    resetScrollOrigin: jest.fn(),
    hidden: { value: 0, __hidden: true },
  }),
}));
jest.mock('@/lib/stores/opened-stories-store', () => {
  const state = { ids: new Set(), articleIds: new Set(), hydrated: false };
  const hook: any = (sel: any) => sel(state);
  hook.getState = () => state;
  return { useOpenedStoriesStore: hook };
});
jest.mock('@/lib/stores/section-visits-store', () => ({
  useSectionVisitsStore: { getState: () => ({ hydrate: () => Promise.resolve() }) },
}));
jest.mock('@/lib/stores/network-store', () => ({ useIsConnected: () => true }));

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import ForYouScreen from '../ForYouScreen';

const HIDDEN = { includeHiddenElements: true } as const;
const W = 402;
const PANEL_CONTENT: Record<string, string> = {
  feed: 'sections',
  stories: 'stories',
  saved: 'saved',
  factChecks: 'fact-checks',
  history: 'visited',
};

function laidOut() {
  render(<ForYouScreen />);
  fireEvent(screen.getByTestId('dashboard-swipe-tabs'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: W, height: 800 } } });
}

/** Which tab stand-ins a mounted panel draws. */
const contentOf = (key: string) =>
  Object.values(PANEL_CONTENT).filter(
    (id) => screen.getByTestId(`dashboard-swipe-tabs-panel-${key}`, HIDDEN).findAll((n: any) => n.props?.testID === id).length > 0,
  );

describe('Dashboard swipe window: every panel draws its own tab', () => {
  it.each([
    ['stories', ['feed', 'stories', 'saved']],
    ['saved', ['stories', 'saved', 'factChecks']],
    ['feed', ['feed', 'stories']],
    ['history', ['factChecks', 'history']],
  ] as const)('with %s active, each mounted panel shows its own content', (active, mounted) => {
    laidOut();
    act(() => fireEvent.press(screen.getByTestId(`subtab-${active}`)));
    for (const key of mounted) expect(contentOf(key)).toEqual([PANEL_CONTENT[key]]);
  });

  it('a drag reveals the next tab, not a copy of the active one', () => {
    laidOut();
    act(() => fireEvent.press(screen.getByTestId('subtab-stories')));
    // Stories is at x = 1*W in the row; the row sits at -1*W. Drag 100pt left.
    act(() => mockPan.onUpdate({ translationX: -100 }));
    const row = screen.getByTestId('dashboard-swipe-tabs-row', HIDDEN);
    const rowX = require('react-native').StyleSheet.flatten(row.props.style).transform[0].translateX;
    const nextX = require('react-native').StyleSheet.flatten(
      screen.getByTestId('dashboard-swipe-tabs-panel-saved', HIDDEN).props.style,
    ).transform[0].translateX;
    // The panel entering from the right edge is Saved, drawing Saved.
    expect(rowX + nextX).toBeLessThan(W);
    expect(rowX + nextX).toBeGreaterThan(0);
    expect(contentOf('saved')).toEqual(['saved']);
  });
});
