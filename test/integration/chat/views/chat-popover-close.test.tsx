// X, backdrop and swipe-down all go through requestClose. It used to start the close inside a
// setPhase updater and leave the store expanded, so the open effect read 'closing' + expanded as a
// reopen and pinged the model again. A close must leave the store collapsed and ping nothing.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View } from 'react-native';
import ChatPopover from '@/components/custom/floating-chat/ChatPopover';
import * as prewarm from '@/lib/llm/prewarm';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { initI18nEn } from '@/test/helpers';
import { resetChatModules, setProcessingMode } from '@/test/integration/chat/_helpers';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true, withTiming: (v: unknown) => v, makeMutable: (v: unknown) => ({ value: v }) };
});
jest.mock('@/components/custom/floating-chat/AboutMeraModal', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

beforeAll(initI18nEn);
beforeEach(() => resetChatModules());

it('tapping X collapses the store and does not reopen or ping again', async () => {
  await setProcessingMode('cloud');
  const ping = jest.spyOn(prewarm, 'prewarmCloudChat').mockImplementation(() => {});
  const view = await render(
    <GestureHandlerRootView>
      <ChatPopover>
        <View />
      </ChatPopover>
    </GestureHandlerRootView>,
  );
  await act(() => useFloatingChatStore.getState().expand());
  expect(ping).toHaveBeenCalledTimes(1);
  // The popover's own re-render (the badge going Ready) is the last render on its fiber.
  await act(() => prewarm.useChatReadiness.setState({ status: 'ready' }));

  await act(() => fireEvent.press(view.getByTestId('chat-header-close')));

  expect(useFloatingChatStore.getState().isExpanded).toBe(false);
  expect(ping).toHaveBeenCalledTimes(1);

  // The close animation ends (the mocked timing never calls back), then reopening pings once more.
  await act(() => useFloatingChatStore.getState().collapse());
  await act(() => useFloatingChatStore.getState().expand());
  expect(useFloatingChatStore.getState().isExpanded).toBe(true);
  expect(ping).toHaveBeenCalledTimes(2);
});
