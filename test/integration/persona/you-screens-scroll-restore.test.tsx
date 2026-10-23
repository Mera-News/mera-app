// The Facts and Sources You screens join the resume spot: a fake navigator at the router edge rebuilds the
// stack, and each pushed screen lands at the saved offset and clears its hidden state.
import { act, render } from '@testing-library/react-native';
import React from 'react';

import {
  __resetResumeSpotForTests,
  __setResumeSpotDepsForTests,
  isRestoreHidden,
  restoreSpot,
  type ResumeSpot,
} from '@/lib/navigation/resume-spot';

let mockRouteKey = 'none';
const mockScrolls: number[] = [];

jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ key: mockRouteKey }) }));
jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: RN.View },
    useSharedValue: (v: number) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withTiming: (v: number) => v,
  };
});
jest.mock('@/lib/motion-gate', () => ({ useMotionAllowed: () => false }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/lib/theme/tokens', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/lib/navigation/tab-bar', () => ({ useListEndClearance: () => 0 }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), captureException: jest.fn() } }));
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => ({ __esModule: true, default: () => null, SUBPAGE_TOP_GAP: 0 }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => () => null);
jest.mock('@/components/custom/tutorials/open-tutorial', () => ({ openTutorial: jest.fn() }));
jest.mock('@/components/custom/mera-button/open-mera-chat', () => ({ openMeraChat: jest.fn() }));
jest.mock('@/components/custom/you/rows', () => ({ Group: () => null, Row: () => null }));
jest.mock('@/components/custom/you/use-hub-data', () => ({
  useHubFacts: () => [{ id: 'f1', statement: 'Rain' }],
  useActiveTopicTexts: () => [],
}));
jest.mock('@/components/custom/facts/open-fact-page', () => ({ openFactPage: jest.fn() }));
jest.mock('@/components/custom/publication-preferences/use-adjusted-sources', () => ({
  useAdjustedSources: () => ({ publications: [], scopes: [], isLoading: false }),
}));
jest.mock('@/components/custom/publication-preferences/SourceSearch', () => () => null);
jest.mock('@/components/custom/publication-preferences/PublicationPrefRow', () => () => null);
jest.mock('@/components/custom/publication-page/PublicationListRow', () => () => null);
jest.mock('@/components/custom/publication-page/open-publication-page', () => ({ openPublicationPage: jest.fn() }));
jest.mock('@/lib/database/services/publication-pref-ui-actions', () => ({ setSourcePrefFromUi: jest.fn() }));

// A ScrollView and a FlatList that behave like real ones for the resume spot: scrolling moves them and reports through onScroll.
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const R = require('react');
  const fake = (method: 'scrollTo' | 'scrollToOffset') =>
    R.forwardRef((props: { onScroll?: (e: unknown) => void; testID?: string }, ref: React.Ref<unknown>) => {
      R.useImperativeHandle(ref, () => ({
        [method]: (p: { offset?: number; y?: number }) => {
          const y = (p.offset ?? p.y) as number;
          mockScrolls.push(y);
          props.onScroll?.({ nativeEvent: { contentOffset: { y } } });
        },
      }));
      return R.createElement(RN.View, { testID: props.testID });
    });
  return Object.setPrototypeOf({ ScrollView: fake('scrollTo'), FlatList: fake('scrollToOffset') }, RN);
});

import FactsScreen from '@/components/custom/facts/FactsScreen';
import PublicationPreferencesScreen from '@/components/custom/publication-preferences/PublicationPreferencesScreen';

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

const spotFor = (route: string): ResumeSpot => ({
  v: 1,
  tab: 'you',
  page: 'profile',
  tabStack: [{ route, params: {} }],
  rootStack: [],
  scroll: { y: 360 },
});

beforeEach(() => {
  __resetResumeSpotForTests();
  mockScrolls.length = 0;
});

describe.each([
  ['facts', () => <FactsScreen onBack={() => undefined} />],
  ['sources', () => <PublicationPreferencesScreen onBack={() => undefined} />],
])('You %s screen and the resume spot', (route, screen) => {
  it('lands at the saved offset after a restore, hidden until it does', async () => {
    const nav = fakeNavigator();
    __setResumeSpotDepsForTests({ ...nav.deps, setPendingPage: () => undefined, arrangeOpen: () => false, probe: () => undefined, nextFrame: async () => undefined });
    expect(await restoreSpot(spotFor(route))).toBe('restored');
    mockRouteKey = nav.stack.at(-1)!.key;
    expect(isRestoreHidden(mockRouteKey)).toBe(true);
    render(screen());
    await tick();
    expect(mockScrolls.at(-1)).toBe(360);
    expect(isRestoreHidden(mockRouteKey)).toBe(false);
  });
});
