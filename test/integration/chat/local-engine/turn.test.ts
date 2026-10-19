// The on-device chat engine driven through the chat session: the real createLocalEngine, the real
// mera-protocol-toolkit (model manager, inference lock), the real inference queue, the in-memory DB
// and the real stores. Only llama.rn (scripted) and expo-file-system (in-memory) are faked.
// Replaces the on-device half of lib/chat-session/__tests__/chat-session.test.ts and proves what
// its mocked engines could not: that a real on-device turn produces the busy window, the hold and
// the rows the session promises.
import { activeHolds } from '@/lib/app-restart';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { enqueueJob, getQueueStats } from '@/lib/database/services/inference-job-service';
import { __setJobHandlerForTests, inferenceQueue } from '@/lib/inference/InferenceQueue';
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import {
  decide,
  disposeModel,
  initBaseModel,
  isTextModelResident,
  RELEVANCE_MODEL,
  TEXT_MODEL,
} from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import '@/test/helpers';
import { llamaLoads, llamaMaxLive } from '@/test/helpers/llama';
import {
  installLlama,
  llamaCalls,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
  until,
} from '@/test/integration/chat/_helpers';
import {
  attachLocal,
  expectNothingLeftTheDevice,
  lastAssistant,
  local,
  sampleLocal,
  samplePhases,
  settle,
  streamHolds,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

const initLlama = () => (jest.requireMock('llama.rn') as { initLlama: jest.Mock }).initLlama;

jest.setTimeout(30_000);

afterEach(async () => {
  await settle();
  __setJobHandlerForTests('topic_gen', undefined);
  await inferenceQueue.stop();
});

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
});

describe('a plain turn', () => {
  beforeEach(async () => {
    installLlama(['Hello', ' there', '.']);
    await initBaseModel();
  });

  it('streams into the assistant bubble; status is streaming then idle; turnBusy and the hold span the turn', async () => {
    const { engine } = await attachLocal();
    const watch = sampleLocal();

    engine.send('hi');
    // Synchronously busy: the hold is taken and the busy flag mirrored before any await.
    expect(local().status).toBe('streaming');
    expect(local().turnBusy).toBe(true);
    expect(useFloatingChatStore.getState().isGenerating).toBe(true);
    expect(streamHolds()).toBe(1);

    await turnDone();
    watch.stop();

    expect(lastAssistant()?.content).toBe('Hello there.');
    expect(local().messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there.'],
    ]);
    expect(local().status).toBe('idle');
    expect(local().error).toBeNull();

    // The bubble grows token by token.
    const texts = [...new Set(watch.samples.map((s) => s.text))].filter(Boolean);
    expect(texts[0]).toBe('Hello');
    expect(texts.at(-1)).toBe('Hello there.');
    expect(texts.length).toBeGreaterThan(1);

    // Status never went idle while busy (no tool phase), and the mirror is exact on every change.
    for (const s of watch.samples) expect(s.generating).toBe(s.busy || s.status === 'streaming');
    expect(watch.samples.some((s) => s.status === 'streaming' && s.busy)).toBe(true);
    expect(watch.samples.at(-1)).toMatchObject({ status: 'idle', busy: false, generating: false, held: 0 });
    // One acquire and one release of the restart hold.
    expect(Math.max(...watch.samples.map((s) => s.held))).toBe(1);
    expect(streamHolds()).toBe(0);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    expectNothingLeftTheDevice();
  });

  it('writes the user message and the finished reply as rows, once each', async () => {
    // A few ms between tokens: rows are ordered by created_at (id breaks ties), so a turn
    // faster than a millisecond would order them by their random ids.
    installLlama({ tokens: ['Hello', ' there', '.'], tokenDelayMs: 5 });
    const { engine, conversationId } = await attachLocal();
    engine.send('hi');
    await turnDone();
    await settle();

    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there.'],
    ]);
  });

  it('a turn that ends with the chat closed marks the answer unread; with the chat open it does not', async () => {
    const closed = await attachLocal();
    expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    closed.engine.send('hi');
    await turnDone();
    expect(useFloatingChatStore.getState().answerUnread).toBe(true);

    resetChatModules();
    useFloatingChatStore.setState({ isExpanded: true });
    const open = await attachLocal();
    open.engine.send('hi');
    await turnDone();
    expect(useFloatingChatStore.getState().answerUnread).toBe(false);
  });

  it('a new conversation disposes the engine: it no longer writes, and the old turn cannot touch the new thread', async () => {
    const first = await attachLocal();
    await attachLocal();
    first.engine.send('into the void');
    expect(local().messages).toEqual([]);
    expect(local().turnBusy).toBe(false);
    expect(llamaCalls()).toHaveLength(0);
  });
});

describe('the wait line', () => {
  it('a cold model publishes deviceLoading until the first token; inferStream loads the text model once and chat writes no model state', async () => {
    installLlama(['Hello', ' there', '.']);
    await disposeModel();
    const states: string[] = [];
    const unsub = useMeraProtocolStore.subscribe((s) => {
      if (states.at(-1) !== s.modelState) states.push(s.modelState);
    });
    const phases = samplePhases();
    const { engine } = await attachLocal();

    engine.send('hi');
    await turnDone();
    unsub();
    phases.stop();

    expect(phases.seen).toEqual(['deviceLoading', 'released']);
    expect(llamaLoads()).toEqual([TEXT_MODEL.modelId]);
    expect(states).toEqual([]);
    expect(lastAssistant()?.content).toBe('Hello there.');
    expectNothingLeftTheDevice();
  });

  it('a loaded model skips deviceLoading and leaves the model state alone', async () => {
    installLlama(['Hello', ' there', '.']);
    await initBaseModel();
    const states: string[] = [];
    const unsub = useMeraProtocolStore.subscribe((s) => states.push(s.modelState));
    const phases = samplePhases();
    const { engine } = await attachLocal();

    engine.send('hi');
    await turnDone();
    unsub();
    phases.stop();

    expect(phases.seen).toEqual(['devicePreparing', 'deviceThinking', 'released']);
    expect(states).toEqual([]);
  });
});

describe('the relevance model swapped in between turns', () => {
  beforeEach(async () => {
    await disposeModel();
  });

  it('the second turn completes on the text context; kev completion() is never called and two contexts are never live', async () => {
    installLlama(['Hello', ' there', '.']);
    const { engine } = await attachLocal();
    engine.send('hi');
    await turnDone();
    expect(llamaLoads()).toEqual([TEXT_MODEL.modelId]);

    // A scoring pass steps in between the turns and leaves kev resident.
    await decide({ state: {}, questions: { rel: { type: 'score' } } } as never);
    expect(llamaLoads()).toEqual([TEXT_MODEL.modelId, RELEVANCE_MODEL.modelId]);
    expect(isTextModelResident()).toBe(false);

    engine.send('again');
    await turnDone();

    expect(local().error).toBeNull();
    expect(lastAssistant()?.content).toBe('Hello there.');
    expect(llamaCalls()).toHaveLength(2);
    expect(llamaLoads()).toEqual([TEXT_MODEL.modelId, RELEVANCE_MODEL.modelId, TEXT_MODEL.modelId]);
    expect(llamaMaxLive()).toBe(1);
  });

  it('Stop pressed during the text-model load starts no completion, ends the turn stopped, and the next turn runs', async () => {
    installLlama(['Fine', '.']);
    const real = initLlama().getMockImplementation()!;
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    initLlama().mockImplementationOnce(async (p: unknown) => {
      await gate;
      return real(p);
    });
    const { engine } = await attachLocal();

    engine.send('hi');
    await until(() => initLlama().mock.calls.length === 1, 5000, 'model load started');
    stopChatTurn();
    openGate();
    await turnDone();

    expect(llamaCalls()).toHaveLength(0);
    expect(local()).toMatchObject({ status: 'idle', turnBusy: false });
    expect(streamHolds()).toBe(0);
    expect(inferenceQueue.getState()).not.toBe('paused');

    engine.send('again');
    await turnDone();
    expect(lastAssistant()?.content).toBe('Fine.');
    expect(llamaCalls()).toHaveLength(1);
    expect(llamaMaxLive()).toBe(1);
  });
});

describe('the inference queue', () => {
  it('is paused for the turn and resumed after: a job enqueued mid-turn runs only once the turn is over', async () => {
    // Slow tokens on real timers keep the turn open long enough to enqueue behind it.
    installLlama({ tokens: ['One', ' two', ' three'], tokenDelayMs: 150 });
    await initBaseModel();
    const order: string[] = [];
    __setJobHandlerForTests('topic_gen', async () => {
      order.push(`job (busy=${local().turnBusy}, completions=${llamaCalls().length})`);
      return {};
    });
    await inferenceQueue.start();
    expect(inferenceQueue.getState()).toBe('running');
    const { engine } = await attachLocal();

    engine.send('hi');
    expect(inferenceQueue.getState()).toBe('paused');
    await until(() => local().messages.some((m) => m.role === 'assistant' && m.content !== ''), 5000, 'first token');
    await enqueueJob('topic_gen', {});
    inferenceQueue.notify();
    // The loop wakes, sees the pause and leaves the job alone.
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual([]);
    expect(inferenceQueue.getState()).toBe('paused');
    expect(local().turnBusy).toBe(true);

    await turnDone();
    expect(inferenceQueue.getState()).toBe('running');
    await until(() => order.length > 0, 5000, 'job run after the turn');
    expect(order).toEqual(['job (busy=false, completions=1)']);
    await settle();
    expect(await getQueueStats()).toMatchObject({ pending: 0 });
  });
});

describe('a failing completion', () => {
  it('sets the error, releases the line, clears busy, resumes the queue, and the next turn still runs', async () => {
    installLlama((call) => (llamaCalls().indexOf(call) === 0 ? { tokens: [], error: 'boom' } : ['Fine.']));
    await initBaseModel();
    await inferenceQueue.start();
    const phases = samplePhases();
    const { engine } = await attachLocal();

    engine.send('hi');
    await turnDone();
    phases.stop();

    expect(local().error).toBe('Inference failed: boom');
    expect(local().status).toBe('idle');
    expect(local().turnBusy).toBe(false);
    expect(phases.seen.at(-1)).toBe('released');
    expect(inferenceQueue.getState()).toBe('running');
    expect(streamHolds()).toBe(0);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    expect(activeHolds()).not.toContain('local-inference');

    // The lock was released: a following turn streams, and starting it clears the error.
    engine.send('again');
    expect(local().error).toBeNull();
    await turnDone();
    expect(lastAssistant()?.content).toBe('Fine.');
    expectNothingLeftTheDevice();
  });

  // A completion that rejects in the same tick as its last token has no waiting reader to reject;
  // the failure must still surface as an error, not as a finished half reply.
  test('a completion that fails right after its last token is reported as an error', async () => {
    installLlama({ tokens: ['Half', ' a'], error: 'boom' });
    await initBaseModel();
    const { engine } = await attachLocal();

    engine.send('hi');
    await turnDone();

    expect(local().error).toBe('Inference failed: boom');
  });
});
