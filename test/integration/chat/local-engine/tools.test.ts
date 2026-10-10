// The on-device tool phase: the stream parser, the end-of-response rescan, think stripping and
// the tool call record's life, all through the real engine, toolkit and chat session.
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { initBaseModel } from '@/lib/mera-protocol-toolkit';
import '@/test/helpers';
import {
  installLlama,
  llamaCalls,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
} from '@/test/integration/chat/_helpers';
import {
  attachLocal,
  expectNothingLeftTheDevice,
  lastAssistant,
  local,
  localToolCall,
  sampleLocal,
  saveFactsCall,
  settle,
  tokensOf,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

jest.setTimeout(30_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
});

const stagedFacts = () => {
  const tc = lastAssistant()?.toolCalls?.find((t) => t.name === 'saveExtractedFacts');
  return (tc?.result as { pendingFacts?: { options: string[] }[] } | undefined)?.pendingFacts;
};

describe('a tool call in the stream', () => {
  beforeEach(async () => {
    installLlama(tokensOf(`Saving that. ${saveFactsCall()}`, 4));
    await initBaseModel();
  });

  it('status goes idle before the tool runs while turnBusy stays true; the record goes pending then done as a fresh object', async () => {
    const { engine } = await attachLocal();
    const watch = sampleLocal();

    engine.send('I live in Porto');
    await turnDone();
    watch.stop();

    // The composer is released at the tool phase: a sample with idle status, busy turn, pending call.
    const toolPhase = watch.samples.find((s) => s.status === 'idle' && s.busy);
    expect(toolPhase).toBeDefined();
    expect(toolPhase!.tools.map((t) => t.status)).toEqual(['pending']);
    // ...and busy (hence the restart hold and the generating mirror) holds through it.
    for (const s of watch.samples) {
      if (s.busy) expect(s.generating).toBe(true);
    }
    expect(watch.samples.filter((s) => s.busy).every((s) => s.held === 1)).toBe(true);

    // Pending -> done, and the done record is a different object (a memoised row sees the change).
    const records = watch.samples.flatMap((s) => s.tools);
    const pending = records.find((t) => t.status === 'pending')!;
    const done = records.find((t) => t.status === 'done')!;
    expect(done.record).not.toBe(pending.record);
    expect(watch.samples.at(-1)).toMatchObject({ status: 'idle', busy: false, generating: false, held: 0 });
    expect(local().turnBusy).toBe(false);
    expectNothingLeftTheDevice();
  });

  it('stages the fact on the call: pendingFacts in the result, nothing written to the facts table', async () => {
    const { engine } = await attachLocal();
    engine.send('I live in Porto');
    await turnDone();

    expect(lastAssistant()?.content).toBe('Saving that. ');
    expect(lastAssistant()?.toolCalls).toHaveLength(1);
    expect(lastAssistant()?.toolCalls?.[0]).toMatchObject({ name: 'saveExtractedFacts', status: 'done' });
    const result = lastAssistant()?.toolCalls?.[0].result as { factsSaved: number };
    expect(result.factsSaved).toBe(0);
    expect(stagedFacts()?.[0].options).toEqual(['Lives in Porto']);
    // Propose-then-save: nothing is committed until a tap on the card.
    expect(await getFacts()).toEqual([]);
  });

  it('runs a streamed call once, though the end-of-response rescan sees the same text again', async () => {
    const { engine } = await attachLocal();
    engine.send('I live in Porto');
    await turnDone();
    expect(lastAssistant()?.toolCalls).toHaveLength(1);
    expect(stagedFacts()).toHaveLength(1);
  });
});

describe('a closing tag split across tokens', () => {
  const callJson = JSON.stringify({
    name: 'saveExtractedFacts',
    arguments: { extracted_user_information: [{ statement: 'Lives in Porto' }] },
  });
  const splitClose = ['Saving. ', '<tool_call>', callJson, '</tool', '_call>', ' All done.'];

  it('keeps the prose that follows the call', async () => {
    installLlama(splitClose);
    const { engine } = await attachLocal();

    engine.send('I live in Porto');
    await turnDone();

    expect(lastAssistant()?.content).toBe('Saving.  All done.');
    expect(lastAssistant()?.toolCalls?.map((t) => [t.name, t.status])).toEqual([['saveExtractedFacts', 'done']]);
    expect(stagedFacts()?.[0].options).toEqual(['Lives in Porto']);
  });

  it('with the closing tag in one token the prose after the call is kept', async () => {
    installLlama(['Saving. ', '<tool_call>', callJson, '</tool_call>', ' All done.']);
    const { engine } = await attachLocal();

    engine.send('I live in Porto');
    await turnDone();

    expect(lastAssistant()?.content).toBe('Saving.  All done.');
    expect(lastAssistant()?.toolCalls).toHaveLength(1);
  });
});

describe('the rescan', () => {
  it('catches a call the stream parser never closed (no </tool_call>)', async () => {
    const text = `On it. ${saveFactsCall().replace('</tool_call>', '')}`;
    installLlama(tokensOf(text, 5));
    const { engine } = await attachLocal();

    engine.send('I live in Porto');
    await turnDone();

    expect(lastAssistant()?.toolCalls?.map((t) => [t.name, t.status])).toEqual([['saveExtractedFacts', 'done']]);
    expect(stagedFacts()?.[0].options[0]).toBe('Lives in Porto');
  });

  it('falls back to bare JSON when the unclosed call carries trailing text', async () => {
    const text = `On it. ${saveFactsCall().replace('</tool_call>', '')} and that is all`;
    installLlama(tokensOf(text, 5));
    const { engine } = await attachLocal();

    engine.send('I live in Porto');
    await turnDone();

    expect(lastAssistant()?.toolCalls?.map((t) => [t.name, t.status])).toEqual([['saveExtractedFacts', 'done']]);
  });

  it('refuses a name that is no tool of this agent (the rescan checks the name; nothing runs)', async () => {
    installLlama(tokensOf(`Sure. ${localToolCall('launchMissiles', { target: 'x' }).replace('</tool_call>', '')}`, 5));
    const { engine } = await attachLocal();

    engine.send('hello');
    await turnDone();

    expect(lastAssistant()?.toolCalls ?? []).toEqual([]);
  });

  it('a malformed call in the stream is skipped and the turn still ends', async () => {
    installLlama(['Hmm. ', '<tool_call>{"name": oops', '</tool_call>', ' Done.']);
    const { engine } = await attachLocal();

    engine.send('hello');
    await turnDone();

    expect(lastAssistant()?.toolCalls ?? []).toEqual([]);
    expect(lastAssistant()?.content).toBe('Hmm.  Done.');
    expect(local().error).toBeNull();
  });
});

describe('reasoning tags', () => {
  it('a <tool_call> inside <think>...</think> never runs and never shows', async () => {
    installLlama(tokensOf(`<think>I could call ${saveFactsCall()} but should not.</think>The answer is Bhopal.`, 4));
    const { engine } = await attachLocal();
    const watch = sampleLocal();

    engine.send('capital of MP?');
    await turnDone();
    watch.stop();

    expect(lastAssistant()?.content).toBe('The answer is Bhopal.');
    expect(lastAssistant()?.toolCalls ?? []).toEqual([]);
    expect(watch.samples.every((s) => s.tools.length === 0)).toBe(true);
    expect(watch.samples.every((s) => !s.text.includes('think'))).toBe(true);
    expect(await getFacts()).toEqual([]);
  });

  it('a stray </think> does not swallow the reply', async () => {
    installLlama(tokensOf('Bhopal is the capital.</think> It sits on two lakes.', 4));
    const { engine } = await attachLocal();

    engine.send('capital of MP?');
    await turnDone();

    expect(lastAssistant()?.content).toBe('Bhopal is the capital. It sits on two lakes.');
  });

  it('a call after a stray </think> still runs', async () => {
    installLlama(tokensOf(`Noted.</think> ${saveFactsCall()}`, 4));
    const { engine } = await attachLocal();

    engine.send('I live in Porto');
    await turnDone();

    expect(lastAssistant()?.content).toBe('Noted. ');
    expect(stagedFacts()?.[0].options[0]).toBe('Lives in Porto');
  });
});

describe('the prompt', () => {
  it('carries the system prompt built with the local tool format and the persons message', async () => {
    installLlama(['Hello.']);
    const { engine } = await attachLocal();

    engine.send('I live in Porto');
    await turnDone();

    const [system, user, ...rest] = llamaCalls()[0].messages;
    expect(rest).toEqual([]);
    expect(system.role).toBe('system');
    // The local tool format is in the prompt text itself (no native tools field on this path).
    expect(system.content).toContain('<tool_call>');
    expect(system.content).toContain('saveExtractedFacts');
    expect(user.role).toBe('user');
    expect(user.content.startsWith('User: ')).toBe(true);
    expect(user.content.endsWith('I live in Porto')).toBe(true);
  });

  it('flattens the history as User:/Assistant: (calls replayed inline) and ends on the last user turn', async () => {
    installLlama((call) => (llamaCalls().indexOf(call) === 0 ? tokensOf(`Saving. ${saveFactsCall()}`, 6) : ['Anything else?']));
    const { engine } = await attachLocal();

    engine.send('I live in Porto');
    await turnDone();
    engine.send('thanks');
    await turnDone();

    const prompt = llamaCalls()[1].messages[1].content;
    const turns = prompt.split('\n\n');
    expect(turns[0]).toBe('User: I live in Porto');
    expect(turns[1]).toContain('Assistant: Saving. ');
    expect(prompt).toContain(
      `<tool_call>${JSON.stringify({ name: 'saveExtractedFacts', arguments: { extracted_user_information: [{ statement: 'Lives in Porto' }] } })}</tool_call>`,
    );
    expect(turns.at(-1)!.endsWith('thanks')).toBe(true);
    expect(prompt.lastIndexOf('User: ')).toBeGreaterThan(prompt.lastIndexOf('Assistant: '));
  });

  it('a hidden turn is a user turn to the model and never shown or written', async () => {
    installLlama(['Understood.']);
    const { engine, conversationId } = await attachLocal();

    engine.sendHidden('The reader discarded the topics.');
    await turnDone();
    await settle();

    const prompt = llamaCalls()[0].messages[1].content;
    expect(prompt.startsWith('User: ')).toBe(true);
    expect(prompt.endsWith('The reader discarded the topics.')).toBe(true);
    expect(local().messages[0]).toMatchObject({ role: 'user', hidden: true });
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.map((m) => m.role)).toEqual(['assistant']);
  });
});
