// When the button shows at all, and the You fade.

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
    useAnimatedStyle: (f: () => object) => f(),
  };
});
jest.mock('../MeraButton', () => {
  const { View } = require('react-native');
  const R = require('react');
  return (p: { page: string }) => R.createElement(View, { testID: `button-${p.page}` });
});
jest.mock('@/lib/hooks/use-feed-status-mode', () => ({ useFeedStatusMode: () => 'idle' }));
let mockFocused = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));
jest.mock('@/lib/navigation/page-order', () => ({ usePageOrder: () => ['profile', 'settings'] }));
jest.mock('@/lib/navigation/tab-bar', () => ({ useMeraButtonBottom: () => 98 }));
jest.mock('@/components/custom/nav/swipe-progress', () => ({ tabSwipeProgress: () => ({ value: 0 }) }));
jest.mock('@/components/custom/nav/current-surface', () => {
  const { create } = require('zustand');
  const store = create(() => ({ surface: null, arrangeOpen: false }));
  return {
    useCurrentSurfaceStore: store,
    useCurrentSurface: () => store((s: { surface: string | null }) => s.surface),
    useArrangeOpen: () => store((s: { arrangeOpen: boolean }) => s.arrangeOpen),
  };
});

import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Keyboard } from 'react-native';
import { useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';
import type { SurfaceId } from '@/components/custom/nav/page-registry';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import MeraButtonHost, { youFade } from '../MeraButtonHost';

function on(surface: string | null, arrangeOpen = false) {
  act(() => useCurrentSurfaceStore.setState({ surface: surface as SurfaceId | null, arrangeOpen }));
}

beforeEach(() => {
  mockFocused = true;
  useFloatingChatStore.getState().reset();
  on(null);
});

it('shows on a page of its own tab', () => {
  on('country:DE');
  render(<MeraButtonHost tab="world" />);
  expect(screen.getByTestId('button-world')).toBeTruthy();
});

it('shows on a page pushed inside its tab', () => {
  on('interest:f1');
  render(<MeraButtonHost tab="feed" />);
  expect(screen.getByTestId('button-interest')).toBeTruthy();
});

it.each([
  ['settings', 'you'],
  ['settings:notifications', 'you'],
  ['search', 'world'],
  ['feed', 'world'],
] as const)('hidden on %s from the %s tab', (surface, tab) => {
  on(surface);
  render(<MeraButtonHost tab={tab} />);
  expect(screen.queryByTestId(/^button-/)).toBeNull();
});

it('hidden while its tab is not focused', () => {
  mockFocused = false;
  on('feed');
  render(<MeraButtonHost tab="feed" />);
  expect(screen.queryByTestId(/^button-/)).toBeNull();
});

it('hidden while the chat is open', () => {
  on('feed');
  render(<MeraButtonHost tab="feed" />);
  act(() => useFloatingChatStore.getState().expand());
  expect(screen.queryByTestId(/^button-/)).toBeNull();
});

it('hidden while Arrange is open', () => {
  on('feed', true);
  render(<MeraButtonHost tab="feed" />);
  expect(screen.queryByTestId(/^button-/)).toBeNull();
});

it('hidden while the keyboard is up', () => {
  const listeners: Record<string, () => void> = {};
  const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((e: string, cb: () => void) => {
    listeners[e] = cb;
    return { remove: jest.fn() };
  }) as never);
  on('feed');
  render(<MeraButtonHost tab="feed" />);
  expect(screen.getByTestId('button-feed')).toBeTruthy();
  act(() => listeners.keyboardDidShow());
  expect(screen.queryByTestId(/^button-/)).toBeNull();
  act(() => listeners.keyboardDidHide());
  expect(screen.getByTestId('button-feed')).toBeTruthy();
  spy.mockRestore();
});

it('fades on You with the swipe towards Settings, wherever Settings sits', () => {
  expect(youFade(0, 1)).toBe(1);
  expect(youFade(0.5, 1)).toBe(0.5);
  expect(youFade(1, 1)).toBe(0);
  expect(youFade(1, 0)).toBe(1);
  expect(youFade(0.25, -1)).toBe(1);
});
