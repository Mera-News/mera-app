// The app's one always-mounted chat host warms the cloud chat when the reader is known to be
// entitled: the first time it also pings the model (and refreshes the routing table), so the first
// chat turn after an app open meets a warm model; a later entitlement change warms without a ping.
import { render } from '@testing-library/react-native';
import React from 'react';
import * as prewarm from '@/lib/llm/prewarm';

jest.mock('@/components/custom/floating-chat/ChatPopover', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/floating-chat/MeraChatSession', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/chat-session/use-chat-session', () => ({ useChatPanelHold: () => {} }));
// `mock`-prefixed so the hoisted factory may read it.
let mockAccess = 'unknown';
jest.mock('@/lib/stores/subscription-store', () => ({ useAiAccess: () => mockAccess }));

it('pings the model once per app open, when entitlement is confirmed', async () => {
  const FloatingChatHost = (require('@/components/custom/floating-chat/FloatingChatHost') as typeof import('@/components/custom/floating-chat/FloatingChatHost')).default;
  const warm = jest.spyOn(prewarm, 'prewarmCloudChat').mockImplementation(() => {});

  const view = await render(<FloatingChatHost />);
  expect(warm).not.toHaveBeenCalled();

  mockAccess = 'entitled';
  await view.rerender(<FloatingChatHost />);
  expect(warm.mock.calls).toEqual([[{ ping: true, routing: true }]]);

  // Entitlement flips away and back: the two fetches are warmed again, the model is not pinged again.
  mockAccess = 'unknown';
  await view.rerender(<FloatingChatHost />);
  mockAccess = 'entitled';
  await view.rerender(<FloatingChatHost />);
  expect(warm.mock.calls).toEqual([[{ ping: true, routing: true }], [{}]]);
});
