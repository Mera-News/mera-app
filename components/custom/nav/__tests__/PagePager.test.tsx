/* eslint-disable @typescript-eslint/no-require-imports */
// The page swipe. RNGH and Reanimated are mocked inline: each gesture records
// its configuration and callbacks, animated styles read shared values live,
// and timing callbacks run at once.
import { act, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
  const R = require('react/jsx-runtime');
  return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const R = require('react/jsx-dev-runtime');
  return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

const mockPan: Record<string, any> = {};
const mockScroller: Record<string, any> = {};
jest.mock('react-native-gesture-handler', () => {
  const chainFor = (store: Record<string, any>) => {
    const chain: any = new Proxy(
      {},
      {
        get: (_t, key: string) => (arg: unknown) => {
          store[key] = arg;
          return chain;
        },
      },
    );
    return chain;
  };
  return {
    Gesture: { Pan: () => chainFor(mockPan), Manual: () => chainFor(mockScroller) },
    GestureDetector: ({ children }: any) => children,
  };
});
let mockReduceMotion = false;
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View: (p: any) => R.createElement(View, p) },
    useSharedValue: (v: unknown) => R.useRef({ value: v }).current,
    useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
    useReducedMotion: () => mockReduceMotion,
    withSpring: (v: number, _c?: unknown, cb?: (f: boolean) => void) => {
      cb?.(true);
      return v;
    },
    withTiming: (v: number, _c: unknown, cb?: (f: boolean) => void) => {
      cb?.(true);
      return v;
    },
    runOnJS: (fn: any) => fn,
  };
});
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));

import PagePager from '../PagePager';
import { useSwipeTabsBlocker } from '../swipe-blocker';

const KEYS = ['feed', 'interests', 'stories', 'extra'];

function setup(over: Partial<React.ComponentProps<typeof PagePager>> = {}) {
  const onIndexChange = jest.fn();
  const onTabStep = jest.fn();
  const progress = { value: 0 } as any;
  const mounts: Record<string, number> = {};
  const Panel = ({ id }: { id: string }) => {
    React.useEffect(() => {
      mounts[id] = (mounts[id] ?? 0) + 1;
    }, [id]);
    return null;
  };
  const props = {
    index: 0,
    count: 3,
    keyOf: (i: number) => KEYS[i],
    renderPanel: (i: number) => <Panel id={KEYS[i]} />,
    keep: [0],
    onIndexChange,
    onTabStep,
    nextTabLabel: 'World',
    enabled: true,
    progress,
    testID: 'pp',
    ...over,
  };
  const r = render(<PagePager {...props} />);
  act(() => {
    r.getByTestId('pp').props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
  });
  return { r, props, onIndexChange, onTabStep, mounts };
}

const touches = (x: number, y = 300) => ({ allTouches: [{ absoluteX: x, absoluteY: y }] });
const stateMgr = () => ({ activate: jest.fn(), fail: jest.fn() });

beforeEach(() => {
  for (const k of Object.keys(mockPan)) delete mockPan[k];
  mockReduceMotion = false;
});

describe('PagePager', () => {
  it('mounts the active page first, its neighbours, and the kept Feed', () => {
    const { r } = setup({ index: 2, count: 4 });
    const panels = r.UNSAFE_root.findAll((n: any) => typeof n.props.testID === 'string' && n.props.testID.startsWith('pp-panel-'));
    const ids = [...new Set(panels.map((n: any) => n.props.testID))];
    expect(ids).toEqual(['pp-panel-stories', 'pp-panel-interests', 'pp-panel-extra', 'pp-panel-feed']);
  });

  it('never remounts a kept page when the window moves or the order changes', () => {
    const { r, props, mounts } = setup({ index: 0, count: 4 });
    r.rerender(<PagePager {...props} index={3} />);
    r.rerender(<PagePager {...props} index={3} keyOf={(i: number) => ['interests', 'feed', 'stories', 'extra'][i]} keep={[1]} />);
    expect(mounts.feed).toBe(1);
  });

  it('decides a touch on its first horizontal movement (manual activation)', () => {
    setup();
    expect(mockPan.manualActivation).toBe(true);
    const s = stateMgr();
    mockPan.onTouchesDown(touches(200));
    mockPan.onTouchesMove(touches(195), s);
    expect(s.activate).not.toHaveBeenCalled();
    mockPan.onTouchesMove(touches(185), s);
    expect(s.activate).toHaveBeenCalledTimes(1);
  });

  it('inside a registered scroller, fails mid-scroller and activates at its edge', () => {
    let blocker: any = null;
    const Probe = () => {
      blocker = useSwipeTabsBlocker();
      return null;
    };
    setup({ renderPanel: () => <Probe /> });
    expect(blocker.gesture).toBeDefined();
    act(() => blocker.setEdge({ start: false, end: false }));
    mockScroller.onTouchesDown();
    const mid = stateMgr();
    mockPan.onTouchesDown(touches(200));
    mockPan.onTouchesMove(touches(180), mid);
    expect(mid.fail).toHaveBeenCalled();

    act(() => blocker.setEdge({ start: false, end: true }));
    const edge = stateMgr();
    mockPan.onTouchesDown(touches(200));
    mockPan.onTouchesMove(touches(180), edge);
    expect(edge.activate).toHaveBeenCalled();
    mockScroller.onFinalize();
  });

  // B4, captured on device: Stats with 2 cards, on card 2 (the last), a RIGHT
  // fling (back toward card 1) changed the PAGE instead of the card. At the
  // end only a drag toward the end (left in LTR) may hand off.
  describe('edge release follows the drag\'s own direction (B4)', () => {
    let blocker: any;
    const Probe = () => {
      blocker = useSwipeTabsBlocker();
      return null;
    };
    const drag = (dx: number) => {
      const s = stateMgr();
      // Touch DOWN inside the scroller comes first; the decision follows on
      // the first move, before the scroll view's own pan has begun.
      mockScroller.onTouchesDown();
      mockPan.onTouchesDown(touches(200));
      mockPan.onTouchesMove(touches(200 + dx), s);
      mockScroller.onTouchesUp({ numberOfTouches: 0 });
      return s;
    };

    it('on the last card a right drag stays in the pager; a left drag hands off', () => {
      setup({ renderPanel: () => <Probe /> });
      act(() => blocker.setEdge({ start: false, end: true }));
      const back = drag(20);
      expect(back.fail).toHaveBeenCalled();
      expect(back.activate).not.toHaveBeenCalled();
      const on = drag(-20);
      expect(on.activate).toHaveBeenCalled();
    });

    it('on the first card a left drag stays in the pager; a right drag hands off', () => {
      setup({ renderPanel: () => <Probe /> });
      act(() => blocker.setEdge({ start: true, end: false }));
      expect(drag(-20).fail).toHaveBeenCalled();
      expect(drag(20).activate).toHaveBeenCalled();
    });

    it('a one-card pager hands off both ways', () => {
      setup({ renderPanel: () => <Probe /> });
      act(() => blocker.setEdge({ start: true, end: true }));
      expect(drag(20).activate).toHaveBeenCalled();
      expect(drag(-20).activate).toHaveBeenCalled();
    });

    it('a touch outside the scroller is not taken for one inside it after a scroller touch ended', () => {
      setup({ renderPanel: () => <Probe /> });
      act(() => blocker.setEdge({ start: false, end: true }));
      drag(-20);
      const s = stateMgr();
      mockPan.onTouchesDown(touches(200));
      mockPan.onTouchesMove(touches(220), s);
      expect(s.activate).toHaveBeenCalled();
    });
  });

  it('commits a page past the threshold', () => {
    const { onIndexChange } = setup();
    act(() => mockPan.onEnd({ translationX: -250, velocityX: 0 }));
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('hands off to the next tab past the last page, but not on a flick', () => {
    const { onTabStep, onIndexChange } = setup({ index: 2 });
    act(() => mockPan.onEnd({ translationX: -80, velocityX: -3000 }));
    expect(onTabStep).not.toHaveBeenCalled();
    act(() => mockPan.onEnd({ translationX: -260, velocityX: 0 }));
    expect(onTabStep).toHaveBeenCalledWith(1);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('shows the next tab label only on the last page, and none before the first without a previous tab', () => {
    // The label is decorative (hidden from accessibility): query hidden too.
    const hidden = { includeHiddenElements: true };
    const first = setup({ index: 0 });
    expect(first.r.queryByTestId('pp-edge-next', hidden)).toBeNull();
    expect(first.r.queryByTestId('pp-edge-prev', hidden)).toBeNull();
    first.r.unmount();
    const last = setup({ index: 2 });
    expect(last.r.getByTestId('pp-edge-next', hidden)).toBeTruthy();
  });

  it('turns the swipe off while Arrange is open', () => {
    setup({ enabled: false });
    expect(mockPan.enabled).toBe(false);
  });
});
