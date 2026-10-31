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
async function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  await act(() => RN.Dimensions.set({ window, screen: window }));
}

beforeAll(initI18nEn);
beforeEach(() => resetChatModules());
afterEach(() => setFontScale(2));

const list = (v: Awaited<ReturnType<typeof render>>) => v.container.queryAll((n) => n.type === 'RCTScrollView')[0];

it('remounts the list when the OS text size changes, and only then', async () => {
  await setFontScale(1);
  const view = await render(<ChatThread {...props} />);
  const first = list(view);

  await view.rerender(<ChatThread {...props} />);
  expect(list(view)).toBe(first);

  await setFontScale(1.6);
  expect(list(view)).not.toBe(first);
  expect(view.getByText('Hello')).toBeTruthy();
});
