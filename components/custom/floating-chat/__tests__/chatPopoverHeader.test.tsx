// ux2 H: the header reads [bug] [new chat] [close], bug LEFT of New chat.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const RN = require('react-native');
  return { MaterialIcons: (p: any) => R.createElement(RN.View, { testID: `icon-${p.name}` }) };
});
jest.mock('@/components/ui/button', () => {
  const R = require('react');
  const RN = require('react-native');
  return { Button: (p: any) => R.createElement(RN.Pressable, p, p.children) };
});
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

it('puts Report a bug to the LEFT of New chat', () => {
  act(() => useFloatingChatStore.getState().expand());
  const { toJSON } = render(<ChatPopover><></></ChatPopover>);
  const order = JSON.stringify(toJSON()).match(/icon-(bug-report|add-comment|close)/g);
  expect(order).toEqual(['icon-bug-report', 'icon-add-comment', 'icon-close']);
});

it('every header button has a 44pt frame (ux2 batch 25)', () => {
  act(() => useFloatingChatStore.getState().expand());
  const { getAllByLabelText } = render(<ChatPopover><></></ChatPopover>);
  for (const label of ['preferences.reportBug', 'floatingChat.newChat', 'floatingChat.close']) {
    // The header button, not the backdrop that shares the close label.
    const buttons = getAllByLabelText(label).filter((n) => typeof n.props.className === 'string');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.className).toMatch(/\bw-11\b.*\bh-11\b/);
  }
});
