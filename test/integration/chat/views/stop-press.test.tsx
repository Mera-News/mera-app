// THE STOP BUTTON, PRESSED. Every other Stop test calls stopChatTurn or abort directly. These render
// the real surface (MeraChatSession down to PromptInput, real session, real engine, real gateway
// mock) and press `chat-stop` during a busy turn, on the persona loop and on the article chat.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import MeraChatSession from '@/components/custom/floating-chat/MeraChatSession';
import * as cloudCompleteModule from '@/lib/llm/cloudComplete';
import { resetChatSession } from '@/lib/chat-session/chat-session';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useFloatingChatStore, type ChatContext } from '@/lib/stores/floating-chat-store';
import { defaultResponder, gatewayCalls, initI18nEn, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { isRouteLeg, resetChatModules, seedFacts, toolCall, until } from '@/test/integration/chat/_helpers';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.setTimeout(60_000);

const ANSWER = 'The full answer.';
const ARTICLE = { kind: 'article-suggestion', articleId: 'a1', suggestionId: 's1' } as ChatContext;
const cloud = () => useCloudChatStore.getState();
const texts = () => cloud().messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('');

let legs: jest.SpyInstance;
/** The signal the leg ran under. `aborted` on a mock call is not it: a reader cancel can beat the
 *  fetch abort, and then the request's own signal never fires. */
const expectLegSignalsAborted = () => {
  expect(legs.mock.calls.length).toBeGreaterThan(0);
  for (const [request] of legs.mock.calls) expect(request.signal.aborted).toBe(true);
};

async function openChat(context: ChatContext) {
  useFloatingChatStore.setState({ context, isExpanded: true });
  await render(<MeraChatSession />);
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy(), { timeout: 10_000 });
}

async function sendToModel() {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('chat-input'), 'What happened in Oslo today?');
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('chat-send'));
  });
}

async function sendAndPressStop(when: () => boolean) {
  await sendToModel();
  await waitFor(() => expect(when()).toBe(true), { timeout: 15_000 });
  const stop = await screen.findByTestId('chat-stop');
  await act(async () => {
    fireEvent.press(stop);
  });
}

beforeAll(initI18nEn);
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  await seedFacts(['Lives in Oslo']);
  // The reanimated mock's makeMutable is a bare number, so MeraLogo's running clock throws under it.
  useDisplayPrefsStore.setState({ liteMode: true });
  legs = jest.spyOn(cloudCompleteModule, 'cloudChatStream');
});
afterEach(async () => {
  legs.mockRestore();
  resetChatSession();
  await new Promise((r) => setTimeout(r, 100));
});

const stalledLeg = () =>
  server.use(...mockGateway((call) => (call.route === 'chat' ? { chunks: ['Looking ', 'never'], stallAfter: 1 } : defaultResponder(call))));

/** Route leg, then a webSearch that hangs past the test, then an answer nobody should see. */
function hangingSearch(onSearch: () => void) {
  server.use(
    ...mockGateway((call) => {
      if (call.route === 'web-search') {
        onSearch();
        return { chunks: ['[]'], headerDelayMs: 16_000 };
      }
      if (call.route !== 'chat') return defaultResponder(call);
      if (isRouteLeg(call)) return toolCall('load_skill', { id: 'conversation/question' });
      const hasResult = call.messages.some((m) => m.content.includes('webSearch:'));
      return hasResult ? ANSWER : toolCall('webSearch', { queries: ['oslo news'] });
    }),
  );
}

const endsNow = async () => {
  await until(() => !useFloatingChatStore.getState().isGenerating, 3000, 'busy clears');
  const legs = gatewayCalls('chat').length;
  await new Promise((r) => setTimeout(r, 1000));
  expect(gatewayCalls('chat')).toHaveLength(legs);
  expect(texts()).not.toContain(ANSWER);
  expect(cloud().error).toBeNull();
  expect(screen.queryByTestId('chat-stopped')).toBeTruthy();
};

describe('pressing chat-stop', () => {
  it('persona chat, model leg stalled: the leg is cut and no answer lands', async () => {
    stalledLeg();
    await openChat({ kind: 'persona' });
    await sendAndPressStop(() => texts().includes('Looking'));

    await endsNow();
    expectLegSignalsAborted();
  });

  it('persona chat, panel closed and reopened mid-turn: the mounted surface still stops the running engine', async () => {
    stalledLeg();
    await openChat({ kind: 'persona' });
    await sendToModel();
    await until(() => texts().includes('Looking'), 10_000, 'partial text');
    await screen.unmount();
    await render(<MeraChatSession />);

    await act(async () => {
      fireEvent.press(await waitFor(() => screen.getByTestId('chat-stop')));
    });

    await endsNow();
    expectLegSignalsAborted();
  });

  it('persona chat, during a web search: the search ends at once and no later leg runs', async () => {
    let searched = false;
    hangingSearch(() => {
      searched = true;
    });
    await openChat({ kind: 'persona' });
    await sendAndPressStop(() => searched);

    await endsNow();
  });

  it('article chat, model leg stalled: the leg is cut and no answer lands', async () => {
    stalledLeg();
    await openChat(ARTICLE);
    await sendAndPressStop(() => texts().includes('Looking'));

    await until(() => !useFloatingChatStore.getState().isGenerating, 3000, 'busy clears');
    expectLegSignalsAborted();
    expect(texts()).not.toContain(ANSWER);
  });

  it('article chat, during a web search: the search ends at once and no later leg runs', async () => {
    let searched = false;
    server.use(
      ...mockGateway((call) => {
        if (call.route === 'web-search') {
          searched = true;
          return { chunks: ['[]'], headerDelayMs: 16_000 };
        }
        if (call.route !== 'chat') return defaultResponder(call);
        return searched ? ANSWER : toolCall('webSearch', { queries: ['oslo news'] });
      }),
    );
    await openChat(ARTICLE);
    await sendAndPressStop(() => searched);

    await until(() => !useFloatingChatStore.getState().isGenerating, 3000, 'busy clears');
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(texts()).not.toContain(ANSWER);
  });
});
