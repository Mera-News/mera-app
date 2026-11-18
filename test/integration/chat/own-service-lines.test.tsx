// The chat view when the paired server or the own AI service is not answering: the line is a link to
// that mode's page. The own news server never shows here. Faked at the network edge only.
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import ChatThread from '@/components/custom/floating-chat/ChatThread';
import { cloudBatchComplete, cloudComplete } from '@/lib/llm/cloudComplete';
import { useOwnAiHealth } from '@/lib/own-services/ai-health';
import { useOwnNewsHealth } from '@/lib/own-services/news-latch';
import { ownAiState, recordOwnAiCheck, saveOwnAiFields, setOwnAiOn } from '@/lib/own-services/own-ai-state';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { PodError } from '@/lib/own-services/pod-client';
import { recordPodError, recordPodOk, resetPodHealth } from '@/lib/own-services/pod-health';
import { forgetPairing, podState, savePairing, type PodPairing } from '@/lib/own-services/pod-state';
import { http, HttpResponse, initI18nEn, POD_URL, server } from '@/test/helpers';
import { fakeClock, resetTransport, run } from '@/test/integration/chat/transport/transport-kit';
import '@/lib/apollo-client';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));

const AI_LINE = "Your AI service isn't answering. Check it in Mera Protocol.";
const NEWS_LINE = "Your news server isn't answering.";
const POD_LINE = "Can't reach your server.";
const AI_URL = 'https://ai.own.test/v1/chat/completions';
const pairing: PodPairing = { v: 1, baseUrl: POD_URL, deviceId: 'device-1', token: 'pod-token-abcdef123456', podName: 'Home pod', pairedAt: 1 };

const Thread = ({ blockedMessage = null, onRetry }: { blockedMessage?: string | null; onRetry?: () => void } = {}) => (
  <ChatThread
    onRetry={onRetry}
    items={[]}
    isStreaming={false}
    onLoadOlder={() => {}}
    hasOlder={false}
    isLoadingOlder={false}
    showHistoryButton={false}
    onRevealHistory={() => {}}
    starterChips={[]}
    onChipPress={() => {}}
    blockedMessage={blockedMessage}
    bannerBlocksInput={false}
    showUnblockControls={false}
    unblockPending={false}
    onRequestUnblock={() => {}}
    onRefreshBlockStatus={() => {}}
    isRefreshingBlockStatus={false}
    onSend={() => {}}
    isInputDisabled={false}
  />
);

const callAi = (status: number) => {
  server.use(
    http.post(AI_URL, () =>
      status === 200 ? HttpResponse.json({ choices: [{ message: { content: 'own reply' } }] }) : new HttpResponse('no', { status }),
    ),
  );
  return act(async () => {
    fakeClock();
    await run(cloudComplete({ systemPrompt: 's', prompt: 'p' }).catch(() => undefined));
  });
};
const turnOnAi = async () => {
  await saveOwnAiFields({ baseUrl: 'https://ai.own.test/v1', model: 'own-model', key: 'own-ai-key-12345678' });
  await recordOwnAiCheck('connected');
  await setOwnAiOn(true, { at: 1, privacyVersion: null });
};
const line = () => screen.queryByTestId('chat-service-line');

beforeAll(initI18nEn);
beforeEach(async () => {
  await resetTransport({ signIn: false });
  ownAiState.resetMemory();
  ownNewsState.resetMemory();
  podState.resetMemory();
  useOwnAiHealth.setState({ health: null });
  useOwnNewsHealth.setState({ health: null });
  resetPodHealth();
  (router.push as jest.Mock).mockClear();
});

it('no own mode on and not paired: no line, whatever stale health says', async () => {
  useOwnAiHealth.setState({ health: 'down' });
  recordPodError(new PodError('unreachable'));
  await render(<Thread />);
  expect(line()).toBeNull();
});

it('own AI service: a 503 shows the line, pressing it opens its page, the next 200 clears it', async () => {
  await turnOnAi();
  await render(<Thread />);
  expect(line()).toBeNull();
  await callAi(503);
  expect(within(line()!).getByText(AI_LINE)).toBeTruthy();
  expect(line()).toHaveProp('accessibilityRole', 'link');
  await fireEvent.press(line()!);
  expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-ai');
  await callAi(200);
  expect(line()).toBeNull();
});

it('own AI service: a 429 does not show it, and turning the mode off clears it', async () => {
  await turnOnAi();
  await render(<Thread />);
  await callAi(429);
  expect(line()).toBeNull();
  await callAi(401);
  expect(within(line()!).getByText(AI_LINE)).toBeTruthy();
  await act(async () => {
    await setOwnAiOn(false);
  });
  expect(line()).toBeNull();
});

it('paired: the line shows from the paired-server health, opens its page, and clears on success and on unpair', async () => {
  await savePairing(pairing);
  await render(<Thread />);
  await act(async () => recordPodError(new PodError('unreachable')));
  expect(within(line()!).getByText(POD_LINE)).toBeTruthy();
  await fireEvent.press(line()!);
  expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-pod');
  await act(async () => recordPodOk());
  expect(line()).toBeNull();
  await act(async () => recordPodError(new PodError('refused')));
  expect(within(line()!).getByText(POD_LINE)).toBeTruthy();
  await act(async () => {
    await forgetPairing();
  });
  expect(line()).toBeNull();
});

it('is announced when it appears', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  await savePairing(pairing);
  await render(<Thread />);
  await act(async () => recordPodError(new PodError('unreachable')));
  expect(announce).toHaveBeenCalledWith(POD_LINE);
  announce.mockRestore();
});

it('the own news server never shows in chat', async () => {
  await saveOwnNewsFields({ baseUrl: 'https://news.own.test', key: 'own-news-key-12345678' });
  await recordOwnNewsCheck('connected', null);
  await setOwnNewsOn(true, { at: 1, privacyVersion: null });
  await render(<Thread />);
  await act(async () => useOwnNewsHealth.setState({ health: 'unreachable' }));
  expect(line()).toBeNull();
  expect(screen.queryByText(NEWS_LINE)).toBeNull();
});

it('a failed turn while the own AI service is down shows one banner: the service line, with Retry kept', async () => {
  await turnOnAi();
  await callAi(503);
  await render(<Thread blockedMessage="Something went wrong." onRetry={() => {}} />);
  expect(screen.queryByText('Something went wrong.')).toBeNull();
  expect(screen.getAllByText(AI_LINE)).toHaveLength(1);
  expect(screen.getByTestId('chat-retry-turn')).toBeTruthy();
  await fireEvent.press(line()!);
  expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-ai');
});

// A batch keeps each failure as text on its row; this pins the installed client's wording.
it('a batch that the own AI service answers with 503 sets it down', async () => {
  await turnOnAi();
  server.use(http.post(AI_URL, () => new HttpResponse('no', { status: 503 })));
  await act(async () => {
    fakeClock();
    await run(cloudBatchComplete([{ id: 'a', systemPrompt: 's', prompt: 'p' }] as never).catch(() => undefined));
  });
  expect(useOwnAiHealth.getState().health).toBe('down');
});
