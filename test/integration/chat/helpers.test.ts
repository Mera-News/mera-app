// The chat helpers do what the chat seam tests rely on: scripted tool calls parse with the app's
// own parser, the module reset clears what it claims, and the built-in model + file-system fakes run
// the real on-device engine end to end with zero network.
import { attachChatSession } from '@/lib/chat-session/chat-session';
import { useLocalChatStore } from '@/lib/chat-session/local-chat-store';
import { createConversation, fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { TutorialHelpOnDeviceAgent } from '@/lib/llm/agents/on-device/TutorialHelpOnDeviceAgent';
import { getCachedAttestation, setCachedAttestation } from '@/lib/e2ee/e2ee-cache';
import { parseToolCallsFromText } from '@/lib/llm/text-tool-protocol';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { FIXTURE_ACCOUNT, gatewayCalls, attestationRequests } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import {
  installLlama,
  personMessage,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
  toolCall,
  until,
} from './_helpers';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

beforeEach(() => {
  resetChatModules();
  resetFileSystem();
});

describe('toolCall', () => {
  it('builds calls the app parser reads back whole, string and JSON arguments alike', () => {
    const text = `Let me save that.\n${toolCall('saveExtractedFacts', {
      extracted_user_information: [{ statement: 'Lives in Porto' }],
    })}\n${toolCall('load_skill', { id: 'facts/residence' })}`;
    const { calls } = parseToolCallsFromText(text, undefined, 'xml');
    expect(calls.map((c) => [c.name, JSON.parse(c.argumentsRaw)])).toEqual([
      ['saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Porto' }] }],
      ['load_skill', { id: 'facts/residence' }],
    ]);
  });

  it('personMessage skips the loop-written turns', () => {
    const call = {
      route: 'chat' as const, model: 'm', stream: false, algo: 'ed25519' as const, headers: {}, index: 0, aborted: false,
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: '<state>x</state>' },
        { role: 'user', content: '<known_facts>\n(none)\n</known_facts>' },
        { role: 'user', content: 'I live in Porto' },
      ],
    };
    expect(personMessage(call)).toBe('I live in Porto');
  });
});

describe('resetChatModules', () => {
  it('clears the attestation cache and the floating chat store', () => {
    setCachedAttestation('m', { publicKey: 'aa'.repeat(32), algo: 'ed25519' });
    useFloatingChatStore.getState().setGenerating(true);
    resetChatModules();
    expect(getCachedAttestation('m')).toBeNull();
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
  });
});

describe('on-device fakes', () => {
  it('run the real local engine through the chat session with zero network', async () => {
    await setProcessingMode('on-device');
    installLlama([]);
    installOnDeviceLlm({ reply: ['Hello', ' there', '.'] });
    const conversationId = await createConversation('CONFIG' as never);
    const engine = attachChatSession({
      conversationId,
      kind: 'local',
      agent: new TutorialHelpOnDeviceAgent(FIXTURE_ACCOUNT.userId, null),
      persistedIds: [],
    });

    engine.send('hi');
    await until(() => useLocalChatStore.getState().turnBusy === false && onDeviceLlmCalls().length > 0, 10_000, 'turn end');

    const last = useLocalChatStore.getState().messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'Hello there.' });
    expect(onDeviceLlmCalls()).toHaveLength(1);
    expect(onDeviceLlmCalls()[0].prompt).toContain('hi');
    expect(gatewayCalls()).toHaveLength(0);
    expect(attestationRequests()).toBe(0);
    await until(() => true);
    const stored = await fetchMessagesForConversation(conversationId);
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there.'],
    ]);
  });
});
