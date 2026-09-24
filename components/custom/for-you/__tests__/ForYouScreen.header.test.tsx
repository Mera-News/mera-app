/* eslint-disable @typescript-eslint/no-require-imports */
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
  return { __esModule: true, default: { View: (p: any) => <View {...p} /> } };
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
jest.mock('@/components/custom/FeedSyncIndicator', () => ({
  useFeedSyncRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }),
  useIsFeedProcessing: () => mockProcessing,
}));
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
jest.mock('@/lib/hooks/use-feed-status-mode', () => ({ useFeedStatusMode: () => 'idle' }));
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
jest.mock('@/components/custom/for-you/DashboardSectionsFeed', () => mockStub('sections'));
jest.mock('@/components/custom/for-you/status-dropdown', () => ({
  StatusDropdownProvider: ({ children }: any) => children,
  StatusDropdownLayer: () => {
    const { View } = require('react-native');
    return <View testID="stats-dropdown-layer" />;
  },
}));
jest.mock('@/components/custom/fact-checks/FactChecksPanel', () => mockStub('fact-checks'));
jest.mock('@/components/custom/for-you/FeedStatsSentence', () => mockStub('stats-sentence'));
jest.mock('@/components/custom/saved-suggestions/SavedSuggestionsScreen', () => mockStub('saved'));
jest.mock('@/components/custom/config-panel/VisitedPublicationsList', () => mockStub('visited'));
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
import { AccessibilityInfo } from 'react-native';
import ForYouScreen from '../ForYouScreen';

beforeEach(() => {
  mockProcessing = false;
  mockLastNewArticlesAt = null;
  mockFontScale = 1;
});
afterEach(() => jest.restoreAllMocks());

/** Every host node's testID inside the header, in tree order. */
const headerIds = () =>
  screen
    .getByTestId('dashboard-header')
    .findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string')
    .map((n: any) => n.props.testID as string);

describe('Dashboard header', () => {
  it('keeps the title while syncing (D6), with no Mera mark in any state (owner)', () => {
    mockProcessing = true;
    render(<ForYouScreen />);
    expect(screen.getByText('feed.dashboardTitle')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-status-indicator')).toBeNull();
  });

  it('puts the "?" right after the title, in the title row', () => {
    render(<ForYouScreen />);
    const ids = headerIds();
    expect(ids.indexOf('dashboard-title')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('dashboard-explainer-open')).toBe(ids.indexOf('dashboard-title') + 1);
  });

  it('draws the same header on every pill, so its height cannot change', () => {
    render(<ForYouScreen />);
    const overview = headerIds();
    // Presence first: the comparison below is not two empty lists.
    expect(overview).toContain('dashboard-title');
    for (const k of ['stories', 'saved', 'factChecks', 'history', 'feed']) {
      fireEvent.press(screen.getByTestId(`subtab-${k}`));
      expect(headerIds()).toEqual(overview);
    }
  });

  it('has no status sentence row at all: no narration while syncing (owner decision)', () => {
    mockProcessing = true;
    render(<ForYouScreen />);
    expect(screen.queryByTestId('dashboard-status-row')).toBeNull();
    expect(screen.queryByTestId('dashboard-narration-line')).toBeNull();
  });

  it('has no "Updated" line at rest either', () => {
    mockLastNewArticlesAt = Date.now() - 10_000;
    render(<ForYouScreen />);
    expect(screen.queryByTestId('dashboard-status-row')).toBeNull();
    expect(screen.queryByTestId('dashboard-updated-label')).toBeNull();
  });

  it('mounts no status sheet and no status panel: both live in the Overview stats card', () => {
    render(<ForYouScreen />);
    expect(screen.getByTestId('dashboard-title')).toBeTruthy();
    expect(screen.queryByTestId('status-sheet')).toBeNull();
    expect(screen.queryByTestId('status-panel')).toBeNull();
  });

  it('hands the status-bar scrim the header\'s hidden value (F21)', () => {
    render(<ForYouScreen />);
    expect(screen.getByTestId('scrim').props.coverProgress).toEqual({ value: 0, __hidden: true });
  });

  it('carries no stats sentence: it moved into the Overview list', () => {
    render(<ForYouScreen />);
    expect(screen.getByTestId('dashboard-title')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-stats-sentence')).toBeNull();
    expect(screen.queryByTestId('stats-sentence')).toBeNull();
  });

  it('lets the pill row bleed by exactly the header side padding', () => {
    render(<ForYouScreen />);
    expect(screen.getByTestId('subtabs').props.bleed).toBe(20);
  });

  it('carries the "?" explainer (N4)', () => {
    render(<ForYouScreen />);
    expect(screen.getByTestId('dashboard-explainer-open')).toBeTruthy();
  });

  it('announces the end of a sync once', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    mockProcessing = true;
    const view = render(<ForYouScreen />);
    mockProcessing = false;
    act(() => view.rerender(<ForYouScreen />));
    act(() => view.rerender(<ForYouScreen />));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('feedStatus.syncDoneA11y');
  });

  it('mounts the stats dropdown layer in the screen, after the header, so it paints over both', () => {
    render(<ForYouScreen />);
    const root = screen.getByTestId('dashboard-screen');
    const ids = root
      .findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string')
      .map((n: any) => n.props.testID as string);
    expect(ids.indexOf('stats-dropdown-layer')).toBeGreaterThan(ids.indexOf('dashboard-header'));
  });
});
