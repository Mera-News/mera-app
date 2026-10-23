// TabPages and the resume spot: it notes the active page, and its one scroll target delegates to the ACTIVE
// page's list (not the last one mounted). The pager, header and native/animation edges are faked; TabPages,
// page-scroll and resume-spot are real.
import { render } from '@testing-library/react-native';
import React, { useRef } from 'react';

import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';
import TabPages from '@/components/custom/nav/TabPages';
import { __resetResumeSpotForTests, type ResumeScrollTarget } from '@/lib/navigation/resume-spot';

const mockNote = jest.fn();
let mockTarget: ResumeScrollTarget | null = null;
jest.mock('@/lib/navigation/resume-spot', () => {
  const actual = jest.requireActual('@/lib/navigation/resume-spot');
  return {
    ...actual,
    noteActivePage: (...a: unknown[]) => mockNote(...a),
    registerScrollTarget: (key: string, t: ResumeScrollTarget) => {
      mockTarget = t;
      return actual.registerScrollTarget(key, t);
    },
  };
});
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ isFocused: () => true }),
  useRoute: () => ({ key: 'library-1' }),
}));
jest.mock('@/lib/hooks/use-collapsible-header', () => ({
  useCollapsibleHeader: () => ({
    scrollHandler: () => {},
    headerStyle: {},
    onHeaderLayout: () => {},
    headerHeight: 0,
    reveal: () => {},
    resetScrollOrigin: () => {},
    hidden: { value: false },
  }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: { View }, useAnimatedScrollHandler: () => () => {}, makeMutable: (v: unknown) => ({ value: v }) };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/haptics', () => ({ hapticSelection: jest.fn() }));
jest.mock('@/lib/motion-gate', () => ({ useMotionAllowed: () => false }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => () => null);
jest.mock('@/components/custom/nav/HeaderGlass', () => () => null);
jest.mock('@/components/custom/nav/PageStrip', () => ({
  __esModule: true,
  default: () => null,
  HEADER_BOTTOM_PAD: 0,
  HEADER_SIDE_PAD: 0,
  HEADER_TOP_PAD: 0,
}));
jest.mock('@/components/custom/nav/PageExplainerSheet', () => () => null);
jest.mock('@/components/custom/nav/ArrangeOverlay', () => () => null);
jest.mock('@/components/custom/nav/RestoreReveal', () => ({ children }: { children: React.ReactNode }) => children);
jest.mock('@/components/custom/nav/PagePager', () => ({
  __esModule: true,
  default: ({ count, index, renderPanel }: { count: number; index: number; renderPanel: (i: number, a: boolean) => React.ReactNode }) => {
    const { View } = require('react-native');
    // The LAST page mounts after the first, as a warm neighbour would.
    return <View>{Array.from({ length: count }, (_, i) => <View key={i}>{renderPanel(i, i === index)}</View>)}</View>;
  },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const scrolled: Record<string, number[]> = { saved: [], checks: [] };
function Page({ id, offset }: { id: string; offset: number }) {
  const ref = useRef<{ scrollToOffset: (p: { offset: number }) => void }>({
    scrollToOffset: ({ offset: y }) => scrolled[id].push(y),
  });
  usePageScrollTarget(ref, { getOffset: () => offset });
  return null;
}

const pages = [
  { id: 'saved', label: 'Saved' },
  { id: 'checks', label: 'Checks' },
] as never;

describe('TabPages resume spot', () => {
  beforeEach(() => {
    __resetResumeSpotForTests();
    mockNote.mockClear();
    mockTarget = null;
    scrolled.saved = [];
    scrolled.checks = [];
  });

  it('notes the active page and delegates the offset and landing to it, not to the last mounted page', () => {
    render(
      <TabPages
        tab="library"
        pages={pages}
        renderPage={({ pageId }) => <Page id={pageId} offset={pageId === 'saved' ? 120 : 900} />}
      />,
    );
    expect(mockNote).toHaveBeenCalledWith('library', 'saved');
    expect(mockTarget).not.toBeNull();
    expect(mockTarget!.getOffset()).toBe(120);
    mockTarget!.scrollTo(300);
    expect(scrolled.saved).toEqual([300]);
    expect(scrolled.checks).toEqual([]);
  });
});
