// The Mera button: hint in the label always, tooltip only for the first 10 s
// of a visit, web hints skipped while web search is off, reading shown as
// motion or (Reduce Motion) a still ring, and a tap opens the page's chat.

jest.mock('react-native-gesture-handler', () => require('./gesture-recorder').mock);
let mockReduce = false;
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
    FadeOut: { duration: () => ({}) },
    useReducedMotion: () => mockReduce,
  };
});
const mockLogo = jest.fn();
jest.mock('@/components/custom/MeraLogo', () => (props: unknown) => {
  mockLogo(props);
  return null;
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(async () => undefined) }));
let mockWeb = true;
jest.mock('@/lib/stores/mera-protocol-store', () => ({ useWebSearchInChat: () => mockWeb }));
const mockTake = jest.fn(async (_pool: string, _len: number) => 1);
jest.mock('@/lib/navigation/hint-cursor', () => ({
  takeHintIndex: (pool: string, len: number) => mockTake(pool, len),
}));
jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: async () => [{ id: 'f1', statement: 'Supports Bayer Leverkusen' }],
}));
// Opening a fact-editing chat opens the facts draft (it reaches WatermelonDB).
jest.mock('@/lib/services/facts-draft-service', () => ({
  openFactsDraft: async () => undefined,
  settleProfileChatClose: async () => undefined,
}));
jest.mock('@/components/custom/nav/current-surface', () => {
  const { create } = require('zustand');
  return { useCurrentSurfaceStore: create(() => ({ surface: null, arrangeOpen: false })) };
});
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts ? `${key}|${Object.values(opts).join('|')}` : key,
  }),
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { tap } from './gesture-recorder';
import React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';
import type { SurfaceId } from '@/components/custom/nav/page-registry';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import MeraButton from '../MeraButton';
import { TOOLTIP_MS } from '../tooltip-visit';

const flush = () => act(async () => {});

function visit(surface: string) {
  act(() => useCurrentSurfaceStore.setState({ surface: surface as SurfaceId }));
}

beforeEach(() => {
  jest.useFakeTimers();
  mockReduce = false;
  mockWeb = true;
  mockLogo.mockClear();
  mockTake.mockClear();
  useFloatingChatStore.getState().reset();
  useCurrentSurfaceStore.setState({ surface: null });
});
afterEach(() => jest.useRealTimers());

it('shows the session hint as a tooltip, then only in the label after 10 s', async () => {
  visit('facts');
  render(<MeraButton surface="facts" page="facts" mode="idle" />);
  await flush();
  expect(mockTake).toHaveBeenCalledWith('facts', 2);
  expect(screen.getByTestId('mera-button-tooltip', { includeHiddenElements: true })).toBeTruthy();
  const label = 'meraButton.a11yLabel|meraHints.facts.remove';
  expect(screen.getByLabelText(label)).toBeTruthy();

  act(() => jest.advanceTimersByTime(TOOLTIP_MS));
  expect(screen.queryByTestId('mera-button-tooltip', { includeHiddenElements: true })).toBeNull();
  expect(screen.getByLabelText(label)).toBeTruthy();
});

it('a remount later in the same visit does not bring the tooltip back', async () => {
  visit('feed');
  const first = render(<MeraButton surface="feed" page="feed" mode="idle" />);
  await flush();
  act(() => jest.advanceTimersByTime(TOOLTIP_MS + 1));
  first.unmount();
  render(<MeraButton surface="feed" page="feed" mode="idle" />);
  await flush();
  expect(screen.queryByTestId('mera-button-tooltip', { includeHiddenElements: true })).toBeNull();
});

it('the tooltip is hidden from screen readers', async () => {
  visit('feed');
  render(<MeraButton surface="feed" page="feed" mode="idle" />);
  await flush();
  expect(screen.queryByTestId('mera-button-tooltip')).toBeNull();
});

it('web search off: an all-web pool shows no tooltip and the label is plain', async () => {
  mockWeb = false;
  visit('checks');
  render(<MeraButton surface="checks" page="checks" mode="idle" />);
  await flush();
  expect(mockTake).not.toHaveBeenCalled();
  expect(screen.queryByTestId('mera-button-tooltip', { includeHiddenElements: true })).toBeNull();
  expect(screen.getByLabelText('floatingChat.title')).toBeTruthy();
});

it('carries the feed status as its accessibility value', async () => {
  render(<MeraButton surface="feed" page="feed" mode="limited" />);
  await flush();
  expect(screen.getByTestId('mera-button').props.accessibilityValue).toEqual({
    text: 'feedStatus.modeLimited',
  });
});

it('rests as a white circle with the dark mark, still, and no ring', async () => {
  render(<MeraButton surface="feed" page="feed" mode="idle" />);
  await flush();
  const style = StyleSheet.flatten(screen.getByTestId('mera-button').props.style);
  expect(style.backgroundColor).toBe('#FFFFFF');
  expect(mockLogo).toHaveBeenLastCalledWith(
    expect.objectContaining({ color: '#121113', animated: false, scrollCards: false }),
  );
  expect(screen.queryByTestId('mera-button-ring')).toBeNull();
});

it('moves while Mera reads', async () => {
  render(<MeraButton surface="feed" page="feed" mode="processing" />);
  await flush();
  expect(mockLogo).toHaveBeenLastCalledWith(
    expect.objectContaining({ color: '#121113', animated: true, scrollCards: true }),
  );
  expect(screen.queryByTestId('mera-button-ring')).toBeNull();
});

it('Reduce Motion: a still ring instead of the motion', async () => {
  mockReduce = true;
  render(<MeraButton surface="feed" page="feed" mode="processing" />);
  await flush();
  expect(mockLogo).toHaveBeenLastCalledWith(
    expect.objectContaining({ animated: false, scrollCards: false }),
  );
  const ring = screen.getByTestId('mera-button-ring');
  expect(StyleSheet.flatten(ring.props.style).borderColor).toBe('#E78A53');
});

it('announces updating and up to date, and nothing for the capped state', async () => {
  const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  const view = render(<MeraButton surface="feed" page="feed" mode="idle" />);
  await flush();
  view.rerender(<MeraButton surface="feed" page="feed" mode="processing" />);
  view.rerender(<MeraButton surface="feed" page="feed" mode="idle" />);
  view.rerender(<MeraButton surface="feed" page="feed" mode="limited" />);
  expect(spy.mock.calls.map((c) => c[0])).toEqual([
    'feedStatus.modeProcessing',
    'feedStatus.idle',
  ]);
  spy.mockRestore();
});

it('a tap opens the page chat', async () => {
  render(<MeraButton surface="world" page="world" mode="idle" />);
  await flush();
  act(() => tap('mera-button-tap'));
  await flush();
  const s = useFloatingChatStore.getState();
  expect(s.isExpanded).toBe(true);
  expect(s.context).toEqual({ kind: 'persona', page: 'world' });
});

it('on One interest the chat carries the fact', async () => {
  render(<MeraButton surface="interest:f1" page="interest" mode="idle" />);
  await flush();
  act(() => tap('mera-button-tap'));
  await flush();
  expect(useFloatingChatStore.getState().context).toEqual({
    kind: 'persona',
    page: 'interest',
    origin: 'profile',
    subject: 'Supports Bayer Leverkusen',
  });
});

it('a screen reader activates it the same way a tap does', async () => {
  render(<MeraButton surface="feed" page="feed" mode="idle" />);
  await flush();
  fireEvent(screen.getByTestId('mera-button'), 'accessibilityAction', {
    nativeEvent: { actionName: 'activate' },
  });
  await flush();
  expect(useFloatingChatStore.getState().isExpanded).toBe(true);
});

it('the tooltip sits on the side facing the middle, its pointer at the button', async () => {
  visit('feed');
  const view = render(<MeraButton surface="feed" page="feed" mode="idle" tooltipSide="left" />);
  await flush();
  const lane = () =>
    StyleSheet.flatten(
      screen.getByTestId('mera-button-tooltip-lane', { includeHiddenElements: true }).props.style,
    );
  expect(lane().right).toBeDefined();
  expect(lane().left).toBeUndefined();
  view.rerender(<MeraButton surface="feed" page="feed" mode="idle" tooltipSide="right" />);
  expect(lane().left).toBeDefined();
  expect(lane().right).toBeUndefined();
});

it('the tooltip steps aside while the button is dragged', async () => {
  visit('feed');
  render(<MeraButton surface="feed" page="feed" mode="idle" dragging />);
  await flush();
  expect(screen.queryByTestId('mera-button-tooltip', { includeHiddenElements: true })).toBeNull();
});
