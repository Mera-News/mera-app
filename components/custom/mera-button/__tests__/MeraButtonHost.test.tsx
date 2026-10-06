// When the button shows at all, where it sits, the drag to a corner, and the
// You fade.

jest.mock('react-native-gesture-handler', () => require('./gesture-recorder').mock);
let mockReduce = false;
const mockSpringDone: Array<(done: boolean) => void> = [];
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
    useAnimatedStyle: (f: () => object) => f(),
    useReducedMotion: () => mockReduce,
    useSharedValue: (v: unknown) => {
      const ref = R.useRef(null);
      if (!ref.current) ref.current = { value: v };
      return ref.current;
    },
    // Lands at once; the settle callback is kept so a test can fire it.
    withSpring: (to: number, _cfg: unknown, done?: (d: boolean) => void) => {
      if (done) mockSpringDone.push(done);
      return to;
    },
    runOnJS: (fn: any) => fn,
  };
});
let mockButtonProps: Record<string, any> = {};
jest.mock('../MeraButton', () => {
  const { View } = require('react-native');
  const R = require('react');
  return (p: Record<string, any>) => {
    mockButtonProps = p;
    return R.createElement(View, { testID: `button-${p.page}` });
  };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
const mockSettings = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: async (k: string) => mockSettings.get(k) ?? null,
  setSetting: async (k: string, v: string) => {
    mockSettings.set(k, v);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 54, bottom: 85, left: 0, right: 0 }),
}));
jest.mock('@/lib/hooks/use-feed-status-mode', () => ({ useFeedStatusMode: () => 'idle' }));
let mockFocused = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));
jest.mock('@/lib/navigation/page-order', () => ({ usePageOrder: () => ['profile', 'settings'] }));
jest.mock('@/lib/navigation/tab-bar', () => ({ MERA_BUTTON_SIZE: 62, useMeraButtonBottom: () => 98 }));
jest.mock('@/components/custom/nav/swipe-progress', () => ({ tabSwipeProgress: () => ({ value: 0 }) }));
jest.mock('@/components/custom/nav/current-surface', () => {
  const { create } = require('zustand');
  const store = create(() => ({ surface: null, arrangeOpen: false }));
  return {
    useCurrentSurfaceStore: store,
    useCurrentSurface: () => store((s: { surface: string | null }) => s.surface),
    useArrangeOpen: () => store((s: { arrangeOpen: boolean }) => s.arrangeOpen),
    useHeaderBottom: () => store((s: { headerBottom?: number | null }) => s.headerBottom ?? null),
  };
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Keyboard, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';
import type { SurfaceId } from '@/components/custom/nav/page-registry';
import { hapticLight } from '@/lib/haptics';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import {
  DRAG_ACTIVATION,
  MERA_BUTTON_CORNER_KEY,
  resetMeraButtonCorner,
  useMeraCornerStore,
} from '../corner';
import MeraButtonHost, { youFade } from '../MeraButtonHost';
import { detected, drag } from './gesture-recorder';

// The overlay is the tab's content area: 390 x 800.
const W = 390;
const H = 800;
// Today's spot: 14 from the right, 98 above the bottom.
const BR = { x: W - 14 - 62, y: H - 98 - 62 };
// Top corners: safe area 54 + header 52 + gap 12.
const TOP_Y = 54 + 52 + 12;

function on(surface: string | null, arrangeOpen = false) {
  act(() => useCurrentSurfaceStore.setState({ surface: surface as SurfaceId | null, arrangeOpen }));
}

const flush = () => act(async () => {});

/** Renders the host, lets the corner hydrate and lays the overlay out. */
async function mount(tab: 'feed' | 'world' | 'library' | 'you', extra?: React.ReactNode) {
  const view = render(
    <>
      {extra}
      <MeraButtonHost tab={tab} />
    </>,
  );
  await flush();
  const overlay = screen.queryByTestId('mera-button-overlay');
  if (overlay) {
    fireEvent(overlay, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: W, height: H } } });
  }
  return view;
}

function placed() {
  const node = screen.getByTestId(/^button-/).parent!;
  // The Placed wrapper's transform carries the position.
  let n: any = node;
  while (n && !StyleSheet.flatten(n.props?.style)?.transform) n = n.parent;
  const t = StyleSheet.flatten(n.props.style).transform as Array<Record<string, number>>;
  return { x: t[0].translateX, y: t[1].translateY };
}

beforeEach(() => {
  mockFocused = true;
  mockReduce = false;
  mockSpringDone.length = 0;
  mockSettings.clear();
  detected.clear();
  (hapticLight as jest.Mock).mockClear();
  resetMeraButtonCorner();
  useFloatingChatStore.getState().reset();
  on(null);
  useCurrentSurfaceStore.setState({ headerBottom: null } as never);
});

describe('visibility', () => {
  it('shows on a page of its own tab', async () => {
    on('country:DE');
    await mount('world');
    expect(screen.getByTestId('button-world')).toBeTruthy();
  });

  it('shows on a page pushed inside its tab', async () => {
    on('interest:f1');
    await mount('feed');
    expect(screen.getByTestId('button-interest')).toBeTruthy();
  });

  it.each([
    ['settings', 'you'],
    ['settings:notifications', 'you'],
    ['search', 'world'],
    ['feed', 'world'],
  ] as const)('hidden on %s from the %s tab', async (surface, tab) => {
    on(surface);
    await mount(tab);
    expect(screen.queryByTestId(/^button-/)).toBeNull();
  });

  it('hidden while its tab is not focused', async () => {
    mockFocused = false;
    on('feed');
    await mount('feed');
    expect(screen.queryByTestId(/^button-/)).toBeNull();
  });

  it('hidden while the chat is open', async () => {
    on('feed');
    await mount('feed');
    act(() => useFloatingChatStore.getState().expand());
    expect(screen.queryByTestId(/^button-/)).toBeNull();
  });

  it('hidden while Arrange is open', async () => {
    on('feed', true);
    await mount('feed');
    expect(screen.queryByTestId(/^button-/)).toBeNull();
  });

  it('hidden while the keyboard is up', async () => {
    const listeners: Record<string, () => void> = {};
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((e: string, cb: () => void) => {
      listeners[e] = cb;
      return { remove: jest.fn() };
    }) as never);
    on('feed');
    await mount('feed');
    expect(screen.getByTestId('button-feed')).toBeTruthy();
    act(() => listeners.keyboardDidShow());
    expect(screen.queryByTestId(/^button-/)).toBeNull();
    act(() => listeners.keyboardDidHide());
    expect(screen.getByTestId('button-feed')).toBeTruthy();
    spy.mockRestore();
  });

  it('draws nothing until the stored corner is known (no flash at the default)', async () => {
    useMeraCornerStore.setState({ hydrated: false });
    on('feed');
    render(<MeraButtonHost tab="feed" />);
    expect(screen.queryByTestId('mera-button-overlay')).toBeNull();
    await flush();
    expect(screen.getByTestId('mera-button-overlay')).toBeTruthy();
  });
});

describe('corners', () => {
  it('starts bottom right, today’s spot, with the tooltip to its left', async () => {
    on('feed');
    await mount('feed');
    expect(placed()).toEqual(BR);
    expect(mockButtonProps.tooltipSide).toBe('left');
  });

  it('restores the stored corner on launch', async () => {
    mockSettings.set(MERA_BUTTON_CORNER_KEY, 'tl');
    on('feed');
    await mount('feed');
    expect(placed()).toEqual({ x: 14, y: TOP_Y });
    expect(mockButtonProps.tooltipSide).toBe('right');
  });

  it('top corners sit under the header the page reports, else the fallback', async () => {
    mockSettings.set(MERA_BUTTON_CORNER_KEY, 'tr');
    on('feed');
    act(() => useCurrentSurfaceStore.setState({ headerBottom: 160 } as never));
    const view = await mount('feed');
    expect(placed()).toEqual({ x: BR.x, y: 160 + 12 });
    act(() => useCurrentSurfaceStore.setState({ headerBottom: null } as never));
    await flush();
    // The move is a shared-value write (UI thread on device); re-render so
    // the mocked animated style reads it.
    // Same tree shape as mount(), so this updates rather than remounts.
    view.rerender(
      <>
        {undefined}
        <MeraButtonHost tab="feed" />
      </>,
    );
    expect(placed()).toEqual({ x: BR.x, y: TOP_Y });
  });

  it('a drop snaps to the nearest corner, remembers it, and a haptic lands on the snap', async () => {
    on('feed');
    await mount('feed');
    // From bottom right to near the top left.
    act(() => drag('mera-button-pan', -300, -500));
    await flush();
    expect(placed()).toEqual({ x: 14, y: TOP_Y });
    expect(useMeraCornerStore.getState().corner).toBe('tl');
    expect(mockSettings.get(MERA_BUTTON_CORNER_KEY)).toBe('tl');
    expect(hapticLight).not.toHaveBeenCalled();
    act(() => mockSpringDone.forEach((done) => done(true)));
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('a short drag snaps back to where it was', async () => {
    on('feed');
    await mount('feed');
    act(() => drag('mera-button-pan', -40, -30));
    await flush();
    expect(placed()).toEqual(BR);
    expect(useMeraCornerStore.getState().corner).toBe('br');
  });

  it('Reduce Motion: jumps to the corner with no spring, haptic at once', async () => {
    mockReduce = true;
    on('feed');
    await mount('feed');
    act(() => drag('mera-button-pan', -300, 0));
    await flush();
    expect(placed()).toEqual({ x: 14, y: BR.y });
    expect(mockSpringDone).toHaveLength(0);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('one corner for every tab: a drop on Feed moves the button on World too', async () => {
    on('feed');
    const feed = await mount('feed');
    act(() => drag('mera-button-pan', 0, -500));
    await flush();
    feed.unmount();
    on('world');
    await mount('world');
    expect(placed()).toEqual({ x: BR.x, y: TOP_Y });
  });

  it('a press or a small wobble stays a tap: the drag starts only past 8pt', async () => {
    on('feed');
    await mount('feed');
    expect(DRAG_ACTIVATION).toBe(8);
    expect(detected.get('mera-button-pan')!.config.minDistance).toEqual([DRAG_ACTIVATION]);
  });

  it('dragging the button never drives a page swipe beside it', async () => {
    const pagerEnd = jest.fn();
    const pagerUpdate = jest.fn();
    const pager = Gesture.Pan().onUpdate(pagerUpdate).onEnd(pagerEnd).withTestId('pager-pan');
    on('feed');
    await mount(
      'feed',
      <GestureDetector gesture={pager}>
        <></>
      </GestureDetector>,
    );
    act(() => drag('mera-button-pan', -300, 0));
    await flush();
    expect(pagerUpdate).not.toHaveBeenCalled();
    expect(pagerEnd).not.toHaveBeenCalled();
    expect(useMeraCornerStore.getState().corner).toBe('bl');
  });
});

it('fades on You with the swipe towards Settings, wherever Settings sits', () => {
  expect(youFade(0, 1)).toBe(1);
  expect(youFade(0.5, 1)).toBe(0.5);
  expect(youFade(1, 1)).toBe(0);
  expect(youFade(1, 0)).toBe(1);
  expect(youFade(0.25, -1)).toBe(1);
});
