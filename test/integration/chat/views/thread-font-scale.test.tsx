// chatfix P5 device finding (07b/07c): after a LIVE OS text-size change every
// row stayed clipped at its old height until the chat reopened, while a fresh
// mount drew them right. The thread list remounts on a new font scale.
import { act, render } from '@testing-library/react-native';
import React from 'react';
import * as RN from 'react-native';
import ChatThread from '@/components/custom/floating-chat/ChatThread';
import type { ChatThreadProps } from '@/components/custom/floating-chat/types';
import { initI18nEn } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';

// ChatThread reads the popover's phase context, whose module pulls the native keyboard library.
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));

const noop = () => {};
const props: ChatThreadProps = {
  items: [{ kind: 'message', key: 'm1', message: { id: 'm1', role: 'assistant', content: 'Hello' } }],
  isStreaming: false,
  onLoadOlder: noop,
  hasOlder: false,
  isLoadingOlder: false,
  showHistoryButton: false,
  onRevealHistory: noop,
  starterChips: [],
  onChipPress: noop,
  blockedMessage: null,
  bannerBlocksInput: false,
  showUnblockControls: false,
  unblockPending: false,
  onRequestUnblock: noop,
  onRefreshBlockStatus: noop,
  isRefreshingBlockStatus: false,
  onSend: noop,
  isInputDisabled: false,
};

/** The OS text size, the way a live change reaches useWindowDimensions. */
function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  act(() => RN.Dimensions.set({ window, screen: window }));
}

beforeAll(initI18nEn);
beforeEach(() => resetChatModules());
afterEach(() => setFontScale(2));

it('remounts the list when the OS text size changes, and only then', () => {
  setFontScale(1);
  const view = render(<ChatThread {...props} />);
  const first = view.UNSAFE_getByType(RN.FlatList);

  view.rerender(<ChatThread {...props} />);
  expect(view.UNSAFE_getByType(RN.FlatList)).toBe(first);

  setFontScale(1.6);
  expect(view.UNSAFE_getByType(RN.FlatList)).not.toBe(first);
  expect(view.getByText('Hello')).toBeTruthy();
});
