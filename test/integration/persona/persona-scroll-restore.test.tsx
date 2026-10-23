// The You tab and the fact page join the resume spot. A fake navigator at the router edge rebuilds the
// stack; FactPage (a pushed screen) and the You Settings page (a tab-root page, reached through TabPages'
// page-scroll context) must land at the saved offset. FactPage's "Show less of" draft holds a restart.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { type PageScrollTarget } from '@/components/custom/nav/page-scroll';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import {
  __resetResumeSpotForTests,
  __setResumeSpotDepsForTests,
  isRestoreHidden,
  restoreSpot,
  type ResumeSpot,
} from '@/lib/navigation/resume-spot';

let mockRouteKey = 'none';
let mockPhrase = '';
let mockSetPhrase: (s: string) => void = () => undefined;
const mockScrolls: number[] = [];

jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ key: mockRouteKey }),
}));
jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: RN.View, ScrollView: RN.ScrollView },
    FadeInDown: { duration: () => undefined },
    useReducedMotion: () => true,
    useSharedValue: (v: number) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withTiming: (v: number) => v,
  };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/motion-gate', () => ({ useMotionAllowed: () => false }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => true }));
jest.mock('@/lib/theme/tokens', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
  useThemeMode: () => 'dark',
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true } }));
jest.mock('@/lib/chat-tools/tool-handlers', () => ({ retryTopicGeneration: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('@/components/custom/feed/feed-view-prefs', () => ({ openSectionedFeed: jest.fn() }));
jest.mock('@/components/custom/nav/current-surface', () => ({ reportHeaderBottom: jest.fn(), clearHeaderBottom: jest.fn() }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => () => null);
jest.mock('@/components/custom/MeraLogo', () => () => null);
jest.mock('@/components/custom/cards/ArticleSuggestionCompactCard', () => ({ ArticleSuggestionCompactCard: () => null }));
jest.mock('@/components/custom/chat/StatusIndicator', () => ({ StatusIndicator: () => null }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => () => null);
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => ({ __esModule: true, default: () => null, SUBPAGE_TOP_GAP: 0 }));
jest.mock('@/components/custom/nav/InlineChoiceChip', () => () => null);
jest.mock('@/components/custom/facts/AddTopicModal', () => () => null);
jest.mock('@/components/ui/bottom-sheet', () => ({ BottomSheet: () => null }));
jest.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
jest.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: () => null }));
jest.mock('@/components/ui/step-slider', () => ({ StepSlider: () => null }));
jest.mock('@/components/custom/you/rows', () => ({
  Group: () => null,
  GroupLabel: () => null,
  Help: () => null,
  Row: () => null,
}));
jest.mock('@/components/custom/facts/useFactPage', () => ({
  INFLUENCE_MAX: 1,
  INFLUENCE_MIN: 0,
  INFLUENCE_STEP: 0.1,
  useFactPage: () => ({
    tab: 'topics',
    filter: 'all',
    fact: { id: 'f1', statement: 'Rain' },
    topics: [],
    impactful: [],
    leftOut: [],
    topicStories: () => 0,
    filterCount: () => 0,
    filterLabel: () => '',
    displayStatement: 'Rain',
    total: 0,
    status: 'done',
    chips: [],
    phrase: mockPhrase,
    setPhrase: (s: string) => mockSetPhrase(s),
    addPhrase: () => undefined,
    openedIds: new Set(),
    taught: new Set(),
    knownIds: null,
    influence: 0.5,
    setTab: () => undefined,
    setFilter: () => undefined,
    setMenuOpen: () => undefined,
    setWeight: () => undefined,
    setRetrying: () => undefined,
    setConfirmTopic: () => undefined,
    setDontAsk: () => undefined,
    setAddOpen: () => undefined,
    setAddText: () => undefined,
  }),
}));
// A FlatList that behaves like a real one for the resume spot: scrollToOffset moves it and reports through onScroll.
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const R = require('react');
  const FakeList = R.forwardRef((props: { onScroll?: (e: unknown) => void; testID?: string }, ref: React.Ref<unknown>) => {
    R.useImperativeHandle(ref, () => ({
      scrollToOffset: ({ offset }: { offset: number }) => {
        mockScrolls.push(offset);
        props.onScroll?.({ nativeEvent: { contentOffset: { y: offset } } });
      },
    }));
    return R.createElement(RN.View, { testID: props.testID });
  });
  return Object.setPrototypeOf({ FlatList: FakeList }, RN);
});
// useTrackedScroll's worklet handler cannot run in jest: the same contract over a plain ref.
jest.mock('@/components/custom/nav/use-tracked-scroll', () => {
  const R = require('react');
  return {
    useTrackedScroll: () => {
      const y = R.useRef(0);
      return { onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => (y.current = e.nativeEvent.contentOffset.y), getOffset: () => y.current };
    },
  };
});
const mockTargets: PageScrollTarget[] = [];
// TabPages stub: renders the Settings page inside the context the real one gives it.
jest.mock('@/components/custom/nav/TabPages', () => {
  const R = require('react');
  const { PageScrollContext: Ctx } = jest.requireActual('@/components/custom/nav/page-scroll');
  return {
    __esModule: true,
    default: ({ renderPage }: { renderPage: (a: unknown) => React.ReactNode }) =>
      R.createElement(
        Ctx.Provider,
        { value: (t: PageScrollTarget) => (mockTargets.push(t), () => undefined) },
        renderPage({ pageId: 'settings', active: true, header: { scrollHandler: () => undefined, headerHeight: 0 } }),
      ),
  };
});
jest.mock('@/components/custom/you/ProfileHub', () => () => null);
jest.mock('@/components/custom/config-mera/AppPreferencesTab', () => () => null);

import FactPage from '@/components/custom/facts/FactPage';
import { YouPages } from '@/components/custom/you/YouPages';

const tick = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setImmediate(r)));
};

function fakeNavigator() {
  const stack: { name: string; key: string }[] = [];
  const router = {
    replace: () => {
      stack.length = 0;
      stack.push({ name: 'index', key: 'index-1' });
    },
    push: ({ pathname }: { pathname: string }) => {
      const name = pathname.split('/').pop()!;
      stack.push({ name, key: `${name}-${stack.length + 1}` });
    },
    back: () => stack.pop(),
  };
  const getRootState = () => ({
    index: 0,
    routes: [
      {
        name: '__root',
        state: {
          index: 0,
          routes: [
            {
              name: 'logged-in',
              state: {
                index: 0,
                routes: [{ name: 'app_container', key: 'ac', state: { index: 0, routes: [{ name: 'you', key: 'tab', state: { index: stack.length - 1, routes: stack } }] } }],
              },
            },
          ],
        },
      },
    ],
  });
  return { stack, deps: { router: () => router, navRef: () => ({ isReady: () => true, getRootState }) } };
}

const spot: ResumeSpot = {
  v: 1,
  tab: 'you',
  page: 'profile',
  tabStack: [{ route: 'fact', params: { factId: 'f1', statement: 'Rain' } }],
  rootStack: [],
  scroll: { y: 480 },
};

beforeEach(() => {
  __resetResumeSpotForTests();
  __resetAppRestartForTests();
  mockScrolls.length = 0;
  mockTargets.length = 0;
  mockPhrase = '';
});

describe('FactPage and the resume spot', () => {
  it('lands at the saved offset after a restore, hidden until it does', async () => {
    const nav = fakeNavigator();
    __setResumeSpotDepsForTests({ ...nav.deps, setPendingPage: () => undefined, arrangeOpen: () => false, probe: () => undefined, nextFrame: async () => undefined });
    expect(await restoreSpot(spot)).toBe('restored');
    mockRouteKey = nav.stack.at(-1)!.key;
    expect(isRestoreHidden(mockRouteKey)).toBe(true);
    render(<FactPage factId="f1" from="you" statement="Rain" />);
    await tick();
    expect(mockScrolls.at(-1)).toBe(480);
    expect(isRestoreHidden(mockRouteKey)).toBe(false);
  });

  it('holds a restart while the Show less of field has text, and releases on clear and unmount', () => {
    mockRouteKey = 'fact-1';
    const view = render(<FactPage factId="f1" from="you" statement="Rain" />);
    expect(activeHolds()).not.toContain('draft:show-less');
    mockPhrase = 'cricket';
    view.rerender(<FactPage factId="f1" from="you" statement="Rain" />);
    expect(activeHolds()).toContain('draft:show-less');
    mockPhrase = '   ';
    view.rerender(<FactPage factId="f1" from="you" statement="Rain" />);
    expect(activeHolds()).not.toContain('draft:show-less');
    mockPhrase = 'cricket';
    view.rerender(<FactPage factId="f1" from="you" statement="Rain" />);
    view.unmount();
    expect(activeHolds()).not.toContain('draft:show-less');
  });
});

describe('You Settings page and the page-scroll registry', () => {
  it('registers an offset getter that follows the page scroll', () => {
    const { getByTestId } = render(<YouPages />);
    expect(mockTargets).toHaveLength(1);
    fireEvent.scroll(getByTestId('settings-page'), { nativeEvent: { contentOffset: { y: 300 } } });
    expect(mockTargets[0].options.current?.getOffset?.()).toBe(300);
  });
});
