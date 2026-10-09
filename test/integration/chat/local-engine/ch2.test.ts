// CH2: the on-device engine accepts a send during the tool phase.
//
// `status` goes idle BEFORE the tool loop runs (the composer is released while tools work), but
// `turnBusy` is still true. The engine's own guard reads `isStreamingRef`, which is released at the
// same point as `status`, so a second send starts a second turn on top of the first turn's tools.
// Decided behaviour (DECISIONS.md, "Behaviour choices for P3 fixes"): refuse it, the same as
// during streaming.
//
// The tool is held with a web search whose HTTP reply waits on a gate the test opens.
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { initBaseModel } from '@/lib/mera-protocol-toolkit';
import { http, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import {
  installLlama,
  llamaCalls,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
  setWebSearchInChat,
  until,
} from '@/test/integration/chat/_helpers';
import {
  attachLocal,
  expectNothingLeftTheDevice,
  local,
  localToolCall,
  settle,
  streamHolds,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

jest.setTimeout(30_000);

let openGate: () => void;
let searchStarted: boolean;

afterEach(async () => {
  openGate();
  await settle();
  await inferenceQueue.stop();
});

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await signInFixtureAccount();
  await setProcessingMode('on-device');
  await setWebSearchInChat(true);
  searchStarted = false;
  const gate = new Promise<void>((r) => (openGate = r));
  server.use(
    http.post('*/v1/web-search', async () => {
      searchStarted = true;
      await gate;
      return HttpResponse.json({ results: [{ title: 'Mera', url: 'https://mera.news', snippet: 'News.' }] });
    }),
  );
  // Turn 1 calls the search tool; every later completion is a plain reply.
  installLlama((call) =>
    llamaCalls().indexOf(call) === 0
      ? ['Looking it up. ', localToolCall('webSearch', { query: 'mera news today' })]
      : ['Second reply.'],
  );
  await initBaseModel();
  await inferenceQueue.start();
});

/** Sends the first message and returns once its tool is in flight: status idle, turn busy. */
async function reachToolPhase() {
  const session = await attachLocal();
  session.engine.send('first');
  await until(() => searchStarted, 10_000, 'the web search in flight');
  expect(local()).toMatchObject({ status: 'idle', turnBusy: true });
  expect(local().messages.at(-1)?.toolCalls?.[0]).toMatchObject({ name: 'webSearch', status: 'pending' });
  return session;
}

const userTexts = () => local().messages.filter((m) => m.role === 'user').map((m) => m.content);

describe('a send while the first turn runs its tools', () => {
  test.failing('is refused, the same as during streaming', async () => {
    const { engine } = await reachToolPhase();

    engine.send('second');
    await new Promise((r) => setTimeout(r, 150));

    // Refused: no second completion, no second user message, and the turn is still busy.
    expect(llamaCalls()).toHaveLength(1);
    expect(userTexts()).toEqual(['first']);
    expect(local().turnBusy).toBe(true);
    expect(streamHolds()).toBe(1);

    openGate();
    await turnDone();
    expect(llamaCalls()).toHaveLength(1);
    expect(local().messages.find((m) => m.role === 'assistant')?.toolCalls?.[0].status).toBe('done');
  });

  it('(pins today) starts a second turn on top of the tools, whose cleanup clears the first turn busy flag and hold', async () => {
    const { engine } = await reachToolPhase();
    const toolOf = () => local().messages.find((m) => m.role === 'assistant')?.toolCalls?.[0];

    engine.send('second');
    // The second completion ran and finished while the first turn's search is still in flight.
    await until(() => llamaCalls().length === 2 && !local().turnBusy, 10_000, 'the second turn to end');
    expect(userTexts()).toEqual(['first', 'second']);
    expect(local().messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Second reply.' });
    // Turn 2's cleanup cleared the flags that turn 1 still needs: busy, the restart hold, the
    // generating mirror and the queue pause all say the whole thing is over.
    expect(toolOf()?.status).toBe('pending');
    expect(local().turnBusy).toBe(false);
    expect(streamHolds()).toBe(0);
    expect(inferenceQueue.getState()).toBe('running');

    openGate();
    await until(() => toolOf()?.status === 'done', 10_000, 'the first turn tool to finish');
    expectNothingLeftTheDevice();
  });
});
