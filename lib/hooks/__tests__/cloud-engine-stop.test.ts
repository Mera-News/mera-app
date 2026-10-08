// The cloud engine's Stop: the stream is aborted, the partial reply stays and is
// marked stopped, no error banner, no tool runs, busy clears.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), captureMessage: jest.fn(), addBreadcrumb: jest.fn() },
}));
jest.mock('../../database/services/setting-service', () => ({}));
jest.mock('../../chat-tools/agent-device-port', () => ({
  makeAgentDeps: jest.fn(),
  buildAgentPersona: jest.fn(),
  logAgentTurn: jest.fn(),
  isPersonaAgent: (id: string) => id.startsWith('persona-'),
}));
jest.mock('../../llm/cloudComplete', () => {
  const actual = jest.requireActual('../../llm/cloudComplete');
  return { ...actual, cloudChatStream: jest.fn() };
});

import { CallerAbortError, cloudChatStream } from '../../llm/cloudComplete';
import { useCloudChatStore } from '../../stores/cloud-chat-store';
import type { IAgent } from '../../llm/types';
import { createCloudEngine } from '../useCloudPersonaChat';

const mockStream = cloudChatStream as jest.Mock;

const agent = {
  id: 'article-feedback-test',
  buildSystemPrompt: async () => 'sys',
  getToolDefinitions: () => [],
} as unknown as IAgent;

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  useCloudChatStore.getState().reset();
  mockStream.mockReset();
});

it('stop aborts the stream on its signal, keeps the partial reply as stopped, shows no error and clears busy', async () => {
  let signal: AbortSignal | undefined;
  mockStream.mockImplementation(async function* (req: { signal?: AbortSignal }) {
    signal = req.signal;
    yield { type: 'text-delta', delta: 'Half an ans' };
    await new Promise<void>((_, reject) =>
      req.signal?.addEventListener('abort', () => reject(new CallerAbortError('stopped'))),
    );
  });

  const engine = createCloudEngine(agent);
  engine.send('tell me something');
  await flush();
  expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(true);

  engine.stop();
  await flush();

  expect(signal?.aborted).toBe(true);
  const state = useCloudChatStore.getState();
  expect(state.error).toBeNull();
  expect(state.status).toBe('idle');
  expect(state.agentTurnState?.turnActive).toBe(false);
  const reply = state.messages.find((m) => m.role === 'assistant');
  expect(reply?.content).toContain('Half an ans');
  expect(reply?.stopped).toBe(true);
  expect(reply?.toolCalls).toBeUndefined();
  // Only the one request: no continuation, no forced pass.
  expect(mockStream).toHaveBeenCalledTimes(1);
});

it('the reader can send again at once after a stop', async () => {
  mockStream.mockImplementationOnce(async function* (req: { signal?: AbortSignal }) {
    await new Promise<void>((_, reject) =>
      req.signal?.addEventListener('abort', () => reject(new CallerAbortError('stopped'))),
    );
    yield { type: 'finish', reason: 'stop' };
  });
  mockStream.mockImplementationOnce(async function* () {
    yield { type: 'text-delta', delta: 'Second answer' };
    yield { type: 'finish', reason: 'stop' };
  });
  const engine = createCloudEngine(agent);
  engine.send('first');
  await flush();
  engine.stop();
  await flush();
  engine.send('second');
  await flush();
  const texts = useCloudChatStore.getState().messages.map((m) => m.content);
  expect(texts.some((c) => c.includes('Second answer'))).toBe(true);
});

it('what the reader saw before Stop is history for the next turn', async () => {
  mockStream.mockImplementationOnce(async function* (req: { signal?: AbortSignal }) {
    yield { type: 'text-delta', delta: 'The AI Act sorts systems by risk' };
    await new Promise<void>((_, reject) =>
      req.signal?.addEventListener('abort', () => reject(new CallerAbortError('stopped'))),
    );
  });
  const engine = createCloudEngine(agent);
  engine.send('Explain the EU AI Act');
  await flush();
  engine.stop();
  await flush();

  const wire = useCloudChatStore.getState().wireMessages;
  expect(wire.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(wire[1].content).toContain('sorts systems by risk');
});
