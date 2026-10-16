// lib/hooks/useCloudPersonaChat.ts (the cloud engine) and lib/llm/completeLocal.ts: the arms only
// legacy suites reached.
//  - a single-shot agent answering in prose (one call, no second pass),
//  - a single-shot turn stopped before any text arrived.
// Driven the way the app drives a turn (createConversation, attachChatSession, engine.send, the
// Send button's stopChatTurn) against the gateway mock.
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { completeLocal } from '@/lib/llm/completeLocal';
import type { IAgent } from '@/lib/llm/types';
import logger from '@/lib/logger';
import { disposeModel, initBaseModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { installLlama, resetChatModules, resetFileSystem, until } from '@/test/integration/chat/_helpers';
import { articleAgent, attachCloud, cloud, idle, settle, turnDone } from './kit';

// Hoisted above the imports by babel-jest. Only the completeLocal case loads a model.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

jest.setTimeout(60_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await signInFixtureAccount();
  useFloatingChatStore.setState({ isExpanded: true });
});

const answerOf = () => cloud().messages.find((m) => m.role === 'assistant' && !m.id.endsWith('-ack'));

describe('a single-shot agent answering in prose', () => {
  const plainAgent = (): IAgent => ({
    id: 'plain-agent-1',
    buildSystemPrompt: async () => 'You are a plain test agent. Answer in one sentence.',
    executeTool: async () => ({ result: {} }) as never,
  });

  it('answers in prose and ends the turn with no second call', async () => {
    server.use(...mockGateway(() => 'A plain answer.'));
    const { engine } = await attachCloud(plainAgent());

    engine.send('Say something');
    await turnDone();

    expect(cloud().error).toBeNull();
    expect(answerOf()?.content).toBe('A plain answer.');
    await new Promise((r) => setTimeout(r, 500));
    expect(gatewayCalls('chat')).toHaveLength(1);
  });
});

describe('stop on a single-shot agent before any text', () => {
  it('marks the empty answer slot stopped and puts no assistant message on the wire', async () => {
    server.use(...mockGateway(() => ({ chunks: ['Too late.'], headerDelayMs: 3000 })));
    const { engine } = await attachCloud(articleAgent());

    engine.send('Explain the EU AI Act');
    await until(() => gatewayCalls('chat').length === 1, 10_000, 'the call is in flight');
    stopChatTurn();
    await until(idle, 5000, 'busy clears after stop');

    expect(cloud().error).toBeNull();
    expect(answerOf()).toMatchObject({ content: '', stopped: true });
    // Nothing was seen, so there is no partial to carry into history: the wire still ends on the user.
    expect(cloud().wireMessages.map((m) => m.role)).toEqual(['user']);
    // Past the mock's header delay, so nothing of this call is left running into the next test.
    await new Promise((r) => setTimeout(r, 3500));
    expect(answerOf()?.content).toBe('');
  });
});

describe('completeLocal truncation warning with the call defaults', () => {
  it('reports the default token ceiling and thinking off when the caller set neither', async () => {
    installLlama({ tokens: ['["a","b"'], truncated: true });
    await disposeModel();
    useMeraProtocolStore.getState().setModelState('downloaded');
    await initBaseModel();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      await expect(completeLocal({ systemPrompt: 'sys', prompt: 'user' })).resolves.toBe('["a","b"');

      expect(warn).toHaveBeenCalledWith('[completeLocal] output truncated at the token ceiling', {
        maxTokens: 512,
        outputLength: 8,
        enableThinking: false,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
