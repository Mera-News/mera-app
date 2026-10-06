/* eslint-disable @typescript-eslint/no-require-imports */
import { act, configure, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, BackHandler } from 'react-native';

configure({ defaultIncludeHiddenElements: true });

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k) }),
}));
jest.mock('react-native-gesture-handler', () => {
  const chain: any = new Proxy({}, { get: () => () => chain });
  return { Gesture: { Pan: () => chain }, GestureDetector: ({ children }: any) => children };
});
const mockShared: { value: unknown }[] = [];
let mockReduceMotion = false;
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View: (p: any) => R.createElement(View, p) },
    useSharedValue: (v: unknown) => {
      const ref = R.useRef(null);
      if (!ref.current) {
        ref.current = { value: v };
        mockShared.push(ref.current);
      }
      return ref.current;
    },
    useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
    useReducedMotion: () => mockReduceMotion,
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    cancelAnimation: () => undefined,
    // Deterministic: names the end it is nearer to, so a test can see it move.
    interpolateColor: (v: number, _in: number[], out: string[]) => (v >= 0.5 ? out[1] : out[0]),
    runOnJS: (fn: any) => fn,
  };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 54, bottom: 34, left: 0, right: 0 }) }));
jest.mock('@/components/custom/GlassSurface', () => ({ GlassPanel: ({ children }: any) => children }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/stores/display-prefs-store', () => ({
  useDisplayPrefsStore: (sel: (s: { liteMode: boolean }) => unknown) => sel({ liteMode: false }),
}));
jest.mock('@/lib/navigation/focus-target', () => ({ navigateToSetting: jest.fn() }));
jest.mock('@/components/custom/notifications/NotificationBellButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import ArrangeOverlay from '../ArrangeOverlay';
import { useCurrentSurfaceStore } from '../current-surface';
import type { ArrangeConfig, PagePill } from '../types';

const feedPages: PagePill[] = [
  { id: 'feed', label: 'Feed' },
  { id: 'interests', label: 'Interests' },
  { id: 'stories', label: 'Stories' },
];
const worldPages: PagePill[] = [
  { id: 'world', label: 'World' },
  { id: 'country:DE', label: 'Germany', flagAlpha2: 'DE' },
];

function open(pages: PagePill[], arrange: Partial<ArrangeConfig> = {}) {
  const onSave = jest.fn();
  const onClose = jest.fn();
  const onOpen = jest.fn();
  render(<ArrangeOverlay tabLabel="Feed" pages={pages} arrange={{ onSave, onOpen, ...arrange }} onClose={onClose} />);
  return { onSave, onClose, onOpen };
}

const action = (id: string, name: string) =>
  act(() => {
    screen.getByTestId(`arrange-chip-${id}`).props.onAccessibilityAction({ nativeEvent: { actionName: name } });
  });

describe('ArrangeOverlay', () => {
  it('opens as the arrange surface and closes it on unmount', () => {
    const { onOpen } = open(feedPages);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(useCurrentSurfaceStore.getState().arrangeOpen).toBe(true);
    screen.unmount();
    expect(useCurrentSurfaceStore.getState().arrangeOpen).toBe(false);
  });

  it('writes nothing on cancel', () => {
    const { onSave, onClose } = open(feedPages);
    action('stories', 'earlier');
    fireEvent.press(screen.getByTestId('arrange-cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves the draft order from Move earlier / Move later and announces it', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const { onSave, onClose } = open(feedPages);
    action('stories', 'earlier');
    action('feed', 'later');
    await act(async () => {
      fireEvent.press(screen.getByTestId('arrange-save'));
    });
    expect(onSave).toHaveBeenCalledWith({ order: ['stories', 'feed', 'interests'], removed: [], added: [] });
    expect(announce).toHaveBeenCalledWith('nav.arrange.saved');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers Move earlier only where possible', () => {
    open(feedPages);
    const names = (id: string) => screen.getByTestId(`arrange-chip-${id}`).props.accessibilityActions.map((a: any) => a.name);
    expect(names('feed')).toEqual(['later']);
    expect(names('stories')).toEqual(['earlier']);
  });

  it('Android Back cancels', () => {
    const subs: (() => boolean)[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h: any) => {
      subs.push(h);
      return { remove: jest.fn() } as any;
    });
    const { onClose, onSave } = open(feedPages);
    expect(subs[subs.length - 1]()).toBe(true);
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  describe('World', () => {
    const world = {
      search: () => [
        { alpha2: 'FR', name: 'France' },
        { alpha2: 'DE', name: 'Germany' },
        { alpha2: 'PF', name: 'French Polynesia' },
      ],
      footnoteFor: (id: string) => (id === 'country:DE' ? 'Germany comes from your places.' : null),
      removable: (id: string) => id !== 'world',
    };

    it('removes a country, adds one from search, and saves both', async () => {
      const { onSave } = open(worldPages, { world });
      expect(screen.queryByTestId('arrange-remove-world')).toBeNull();
      fireEvent.press(screen.getByTestId('arrange-remove-country:DE'));
      fireEvent.changeText(screen.getByTestId('arrange-add-input'), 'Fr');
      fireEvent.press(screen.getByTestId('arrange-add-FR'));
      await act(async () => {
        fireEvent.press(screen.getByTestId('arrange-save'));
      });
      expect(onSave).toHaveBeenCalledWith({ order: ['world', 'country:FR'], removed: ['country:DE'], added: ['FR'] });
    });

    it('search hides countries already in the draft', () => {
      open(worldPages, { world });
      fireEvent.changeText(screen.getByTestId('arrange-add-input'), 'e');
      expect(screen.queryByTestId('arrange-add-DE')).toBeNull();
      expect(screen.getByTestId('arrange-add-PF')).toBeTruthy();
    });

    it('says when nothing matches', () => {
      open(worldPages, { world: { ...world, search: () => [] } });
      fireEvent.changeText(screen.getByTestId('arrange-add-input'), 'Zz');
      expect(screen.getByTestId('arrange-no-match').props.children).toBe('nav.arrange.noMatch|{"query":"Zz"}');
    });

    it('shows the place note instead of the drag hint', () => {
      open(worldPages, { world });
      expect(screen.getByTestId('arrange-hint').props.children).toBe('Germany comes from your places.');
    });
  });

  describe('the glow', () => {
    const LAYOUT_KEYS = ['borderWidth', 'padding', 'paddingLeft', 'paddingRight', 'height', 'width', 'margin'];
    const flat = (style: any) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

    it('is the pill\'s own rounded border changing colour only; the frame draws no outline', () => {
      mockShared.length = 0;
      open(feedPages);
      const pill = () => flat(screen.getByTestId('arrange-chip-feed-pill').props.style);
      const frame = flat(screen.getByTestId('arrange-chip-feed-frame').props.style);
      expect(frame.borderWidth).toBeUndefined();
      expect(frame.borderColor).toBeUndefined();
      expect(pill().borderRadius).toBe(999);
      const before = pill();
      // The glow clock is the first shared value created at 1 (the full accent).
      const glow = mockShared.find((v) => v.value === 0 || v.value === 1);
      expect(glow).toBeDefined();
      act(() => {
        glow!.value = glow!.value === 1 ? 0 : 1;
      });
      screen.rerender(<ArrangeOverlay tabLabel="Feed" pages={feedPages} arrange={{ onSave: jest.fn() }} onClose={jest.fn()} />);
      const after = pill();
      for (const k of LAYOUT_KEYS) expect(after[k]).toBe(before[k]);
      expect(after.borderWidth).toBeGreaterThan(0);
      expect(after.borderColor).not.toBe(before.borderColor);
    });

    it('holds a static orange border under Reduce Motion', () => {
      mockReduceMotion = true;
      open(feedPages);
      expect(flat(screen.getByTestId('arrange-chip-feed-pill').props.style).borderColor).toBe('#E78A53');
      mockReduceMotion = false;
    });

    it('at rest scales nothing: the frame transform is identity', () => {
      open(feedPages);
      const t = flat(screen.getByTestId('arrange-chip-feed-frame').props.style).transform;
      expect(t).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    });
  });

  it('leaks no icon glyph into a label', () => {
    open(worldPages, {
      world: { search: () => [], footnoteFor: () => null, removable: (id) => id !== 'world' },
    });
    const { privateUseLabelLeaks } = require('@/lib/__test-helpers__/icon-glyph-a11y');
    expect(privateUseLabelLeaks(screen.root)).toEqual([]);
  });
});
