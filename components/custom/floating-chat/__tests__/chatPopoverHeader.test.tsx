// ux2 H: the header reads [bug] [new chat] [close], bug LEFT of New chat.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/llm/prewarm', () => ({ prewarmCloudChat: jest.fn() }));
jest.mock('../chat-bug-report', () => ({ openChatBugReport: jest.fn(), currentChatTranscript: () => '' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-native-keyboard-controller', () => ({
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
jest.mock('react-native-gesture-handler', () => {
  const R = require('react');
  const chain: any = new Proxy({}, { get: () => () => chain });
  return { Gesture: { Pan: () => chain }, GestureDetector: (p: any) => R.createElement(R.Fragment, null, p.children) };
});
jest.mock('react-native-reanimated', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => R.createElement(RN.View, p, p.children) },
    Extrapolation: { CLAMP: 'clamp' },
    interpolate: () => 0,
    runOnJS: (f: any) => f,
    useAnimatedStyle: (f: () => unknown) => f(),
    useSharedValue: (v: unknown) => ({ value: v }),
    withSpring: (v: unknown) => v,
    withTiming: (v: unknown) => v,
  };
});

import ChatPopover from '../ChatPopover';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';
import { StyleSheet } from 'react-native';

const HEADER = ['chat-header-report-bug', 'chat-header-new-chat', 'chat-header-close'];

it('puts Report a bug to the LEFT of New chat', () => {
  act(() => useFloatingChatStore.getState().expand());
  const { toJSON } = render(<ChatPopover><></></ChatPopover>);
  const order = JSON.stringify(toJSON()).match(/chat-header-(report-bug|new-chat|close)/g);
  expect(order).toEqual(HEADER);
});

it('every header button is a childless, labelled 44x44 frame sized by number (ux2 batch 26)', () => {
  // NativeWind inlines rem at 14, so `w-11 h-11` rendered 38.5pt, which is
  // what the device measured. Only a numeric style is 44.
  act(() => useFloatingChatStore.getState().expand());
  const { getByTestId } = render(<ChatPopover><></></ChatPopover>);
  const labels = ['preferences.reportBug', 'floatingChat.newChat', 'floatingChat.close'];
  HEADER.forEach((id, i) => {
    const button = getByTestId(id);
    const flat = StyleSheet.flatten(button.props.style) ?? {};
    expect(flat.width).toBe(44);
    expect(flat.height).toBe(44);
    expect(button.props.accessibilityLabel).toBe(labels[i]);
    // Childless: nothing drawn (and no glyph) sits under the accessible element.
    expect(button.findAll((n: any) => typeof n.type === 'string' && n !== button)).toHaveLength(0);
  });
});

it('no header icon is its own StaticText (ux2 batch 26)', () => {
  act(() => useFloatingChatStore.getState().expand());
  const { UNSAFE_root } = render(<ChatPopover><></></ChatPopover>);
  const glyphs = UNSAFE_root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children)));
  expect(glyphs.length).toBe(3);
  expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
});
