// The Stop button on the on-device engine: stopChatTurn() while text is arriving.
// The token loop leaves, the toolkit cancels the built-in model's stream before it frees the
// inference lock, the partial reply stays, and a structured reply that lands after Stop is dropped.
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
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
  personaAgent,
  sampleLocal,
  saveFactReply,
  settle,
  streamHolds,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

afterEach(async () => {
  await settle();
  await inferenceQueue.stop();
});

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
  // Kev on disk; the text comes from the built-in model. A llama.rn completion fails the test.
  installLlama(() => ({ tokens: [], error: 'llama.rn completion on Kev' }));
});

/** Scripts the built-in model's replies. */
const text = (reply: NonNullable<Parameters<typeof installOnDeviceLlm>[0]>['reply']) => installOnDeviceLlm({ reply });

/** A long reply on a slow stream: `n` words, 10 ms apart, so a stop lands between tokens. */
const longReply = (n = 60) => ({ tokens: Array.from({ length: n }, (_, i) => `w${i} `), tokenDelayMs: 10 });
const firstCallThen = (first: ReturnType<typeof longReply> | string[], later: string[]) => (call: object) =>
  onDeviceLlmCalls().indexOf(call as never) === 0 ? first : later;

describe('stopChatTurn', () => {
  it('keeps the partial text as stopped, cancels the stream, releases the lock, the hold and the queue', async () => {
    text(firstCallThen(longReply(), ['Next one.']));
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
    // The stream was cancelled, and no token reached the engine after it left the loop.
    expect(onDeviceLlmCalls()[0].cancelled).toBe(true);
    expect(onDeviceLlmCalls()[0].delivered.length).toBeLessThan(60);
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
    expect(onDeviceLlmCalls()).toHaveLength(2);
    expect(llamaCalls()).toHaveLength(0);
    expect(lastAssistant()).toMatchObject({ content: 'Next one.' });
    expect(lastAssistant()?.stopped).toBeUndefined();
    expectNothingLeftTheDevice();
  });

  // A structured turn cannot be cut short: the reply lands after Stop and must be dropped whole.
  it('drops a structured reply that lands after Stop: nothing staged, nothing run', async () => {
    text({ tokens: [saveFactReply()], tokenDelayMs: 300 });
    const { engine } = await attachLocal(personaAgent());
    const watch = sampleLocal();

    engine.send('I live somewhere new');
    await until(() => onDeviceLlmCalls().some((c) => c.kind === 'structured'), 5000, 'the structured call started');
    stopChatTurn();
    await turnDone();
    expect(local()).toMatchObject({ status: 'idle', turnBusy: false });
    // The reply arrives after the turn ended, and changes nothing.
    await until(() => onDeviceLlmCalls().find((c) => c.kind === 'structured')!.delivered.length === 1, 5000, 'the late reply');
    await settle();
    watch.stop();

    expect(lastAssistant()).toMatchObject({ content: '', stopped: true, toolCalls: undefined });
    expect(watch.samples.flatMap((s) => s.tools)).toEqual([]);
    expect(useFloatingChatStore.getState().proposal).toBeNull();
    expect(await getFacts()).toEqual([]);
  });

  it('does nothing when no turn is running: the next turn is not pre-stopped', async () => {
    text(['Hello', ' there', '.']);
    const { engine } = await attachLocal();

    stopChatTurn();
    engine.send('hi');
    await turnDone();

    expect(lastAssistant()).toMatchObject({ content: 'Hello there.' });
    expect(lastAssistant()?.stopped).toBeUndefined();
    expect(onDeviceLlmCalls()[0].cancelled).toBe(false);
  });

  it('a stop leaves Kev alone: nothing is released or reloaded', async () => {
    text(firstCallThen(longReply(), ['Next one.']));
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
