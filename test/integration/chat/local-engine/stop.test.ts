// The Stop button on the on-device engine: stopChatTurn() while text is arriving.
// The token loop leaves, the toolkit halts llama and awaits it BEFORE it frees the inference lock,
// the partial reply stays, and the turn's tool calls are dropped.
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import '@/test/helpers';
import {
  installLlama,
  llamaCalls,
  llamaReleases,
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
  saveFactsCall,
  settle,
  streamHolds,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

jest.setTimeout(30_000);

afterEach(async () => {
  await settle();
  await inferenceQueue.stop();
});

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
});

/** A long reply on a slow stream: `n` words, 10 ms apart, so a stop lands between tokens. */
const longReply = (n = 60) => ({ tokens: Array.from({ length: n }, (_, i) => `w${i} `), tokenDelayMs: 10 });
const firstCallThen = (first: ReturnType<typeof longReply> | string[], later: string[]) => (call: object) =>
  llamaCalls().indexOf(call as never) === 0 ? first : later;

describe('stopChatTurn', () => {
  it('keeps the partial text as stopped, halts llama, releases the lock, the hold and the queue', async () => {
    installLlama(firstCallThen(longReply(), ['Next one.']));
    await inferenceQueue.start();
    const { engine, conversationId } = await attachLocal();
    const watch = sampleLocal();

    engine.send('tell me everything');
    await until(() => (lastAssistant()?.content ?? '').split(' ').length > 4, 5000, 'a few tokens');
    expect(inferenceQueue.getState()).toBe('paused');
    useFloatingChatStore.setState({ isExpanded: true });
    stopChatTurn();
    await turnDone();
    watch.stop();

    const partial = lastAssistant()!;
    expect(partial.stopped).toBe(true);
    expect(partial.content.startsWith('w0 w1 w2')).toBe(true);
    expect(partial.content.split(' ').length).toBeLessThan(60);
    expect(partial.toolCalls).toBeUndefined();
    // llama was told to stop, and no token reached the engine after it left the loop.
    expect(llamaCalls()[0].stopped).toBe(true);
    expect(llamaCalls()[0].delivered.length).toBeLessThan(60);
    // The turn is over everywhere.
    expect(local()).toMatchObject({ status: 'idle', turnBusy: false, error: null });
    expect(streamHolds()).toBe(0);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    // No "answer ready" ring for a turn the reader stopped.
    expect(useFloatingChatStore.getState().answerUnread).toBe(false);
    expect(inferenceQueue.getState()).toBe('running');
    expect(watch.samples.at(-1)).toMatchObject({ busy: false, generating: false, held: 0 });

    // The partial reply is what gets written.
    await settle();
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rows[1].content).toBe(partial.content);

    // The lock was freed: a following turn runs to the end.
    engine.send('and now?');
    await turnDone();
    expect(llamaCalls()).toHaveLength(2);
    expect(lastAssistant()).toMatchObject({ content: 'Next one.' });
    expect(lastAssistant()?.stopped).toBeUndefined();
    expectNothingLeftTheDevice();
  });

  it('drops a tool call that was already parsed from the partial text', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `w${i} `);
    installLlama({ tokens: ['Saving. ', saveFactsCall(), ...filler], tokenDelayMs: 10 });
    const { engine } = await attachLocal();
    const watch = sampleLocal();

    engine.send('I live in Porto');
    await until(() => (lastAssistant()?.toolCalls?.length ?? 0) > 0, 5000, 'the call parsed');
    stopChatTurn();
    await turnDone();
    watch.stop();

    expect(lastAssistant()).toMatchObject({ stopped: true, toolCalls: undefined });
    // The call was never run: no sample ever showed it done, and nothing was staged or written.
    expect(watch.samples.flatMap((s) => s.tools).map((t) => t.status)).not.toContain('done');
    expect(await getFacts()).toEqual([]);
    expect(llamaCalls()[0].stopped).toBe(true);
  });

  it('does nothing when no turn is running: the next turn is not pre-stopped', async () => {
    installLlama(['Hello', ' there', '.']);
    const { engine } = await attachLocal();

    stopChatTurn();
    engine.send('hi');
    await turnDone();

    expect(lastAssistant()).toMatchObject({ content: 'Hello there.' });
    expect(lastAssistant()?.stopped).toBeUndefined();
    expect(llamaCalls()[0].stopped).toBe(false);
  });

  it('a stop leaves the model loaded: the next turn does not reload it', async () => {
    installLlama(firstCallThen(longReply(), ['Next one.']));
    const { engine } = await attachLocal();

    engine.send('tell me everything');
    await until(() => (lastAssistant()?.content ?? '').length > 6, 5000, 'a few tokens');
    stopChatTurn();
    await turnDone();
    engine.send('and now?');
    await turnDone();

    expect(llamaReleases()).toBe(0);
  });
});
