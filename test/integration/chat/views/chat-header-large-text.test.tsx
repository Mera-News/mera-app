// chatfix P5 device finding (07): at the largest accessibility text size the
// chat header squeezed the title to one letter per line and pushed the thread
// off screen. From fontScale 1.3 (or once the title wraps) the buttons move to
// a second row and the title block, which carries the Art. 50 notice, gets the
// full width. Every button keeps a 44pt frame.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import ChatPopover from '@/components/custom/floating-chat/ChatPopover';
import { useChatReadiness } from '@/lib/llm/prewarm';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { initI18nEn } from '@/test/helpers';
import { resetChatModules, setProcessingMode } from '@/test/integration/chat/_helpers';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
// Reduce Motion: the panel opens without a timed morph, as the bottom-sheet suite does.
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
// The About Mera sheet is a native Modal the jest preset cannot load; it is not under test here.
jest.mock('@/components/custom/floating-chat/AboutMeraModal', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

type Style = Record<string, unknown>;
const style = (node: { props: { style?: unknown } }): Style => (StyleSheet.flatten(node.props.style as never) ?? {}) as Style;

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  act(() => Dimensions.set({ window, screen: window }));
}

async function open(fontScale: number) {
  setFontScale(fontScale);
  await setProcessingMode('cloud');
  useChatReadiness.setState({ status: 'ready' });
  const view = render(
    <ChatPopover>
      <View />
    </ChatPopover>,
  );
  act(() => useFloatingChatStore.getState().expand());
  return view;
}

beforeAll(initI18nEn);
beforeEach(() => resetChatModules());
afterEach(() => setFontScale(2));

it('at fontScale 3 the buttons sit on a second row under a full-width title block', async () => {
  const view = await open(3);

  expect(style(view.getByTestId('chat-header')).flexDirection).toBe('column');
  expect(style(view.getByTestId('chat-header-buttons')).alignSelf).toBe('flex-end');
  // The title block (Art. 50 line) is never width-capped and its subtitle never truncates.
  const title = style(view.getByTestId('chat-header-about'));
  expect(title.width ?? title.maxWidth).toBeUndefined();
  expect(view.getByTestId('chat-header-ai-subtitle').props.numberOfLines).toBeUndefined();
});

it('at fontScale 1 the header stays one row', async () => {
  const view = await open(1);
  expect(style(view.getByTestId('chat-header')).flexDirection).toBe('row');
  expect(style(view.getByTestId('chat-header-buttons')).alignSelf).toBeUndefined();
});

it('a title that wraps beside the buttons stacks them, and stays stacked once it fits', async () => {
  const view = await open(1);
  const title = view.getByText('Mera');

  fireEvent(title, 'textLayout', { nativeEvent: { lines: [{}, {}] } });
  expect(style(view.getByTestId('chat-header')).flexDirection).toBe('column');
  fireEvent(title, 'textLayout', { nativeEvent: { lines: [{}] } });
  expect(style(view.getByTestId('chat-header')).flexDirection).toBe('column');
});

it.each([1, 3])('at fontScale %s New chat and close keep 44pt frames and the badge has no fixed height', async (scale) => {
  const view = await open(scale);
  for (const id of ['chat-header-new-chat', 'chat-header-close']) {
    expect(style(view.getByTestId(id))).toMatchObject({ width: 44, height: 44 });
  }
  // The pill is drawn only (hidden from the accessibility tree): the title block's label carries it.
  const badge = style(view.getByTestId('chat-header-readiness', { includeHiddenElements: true }));
  expect(badge.height).toBeUndefined();
  expect(badge.minHeight).toBe(22);
});
