/* eslint-disable @typescript-eslint/no-require-imports */
// The on-device chat flows (D27, D31) on the phone's built-in model: each flow's structured reply
// mapped to the existing executors, the story options staged as the same proposeTrack proposal the
// cloud stages, the conversation trimmed to the engine's window, and the prompts themselves (the
// identity line, the instruction size, no real-world example entities). Real engine, chat session,
// agents, executors, stores and database; the native module (Apple Foundation Models / Gemini
// Nano) and the file system are faked.
import { createAgentForContext } from '@/components/custom/floating-chat/agent-registry';
import { useLocalChatStore } from '@/lib/chat-session/local-chat-store';
import { ArticleFeedbackOnDeviceAgent } from '@/lib/llm/agents/on-device/ArticleFeedbackOnDeviceAgent';
import { FollowStoryOnDeviceAgent } from '@/lib/llm/agents/on-device/FollowStoryOnDeviceAgent';
import type { ConversationMessage, OnDeviceAgent, StagedProposal } from '@/lib/llm/types';
import { __resetTextEngineForTests, setTextEngine } from '@/lib/mera-protocol-toolkit/core/text-engine';
import { FOLLOW_STORY_SURFACE } from '@/lib/news-harness/follow-story';
import { countTokens, IDENTITY_LINE } from '@/lib/news-harness/on-device/shared';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { FIXTURE_ACCOUNT } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls, type OnDeviceLlmCall } from '@/test/helpers/on-device-llm';
import { resetFileSystem, setProcessingMode } from '@/test/integration/chat/_helpers';
import {
  attachLocal,
  expectNothingLeftTheDevice,
  lastAssistant,
  local,
  personaAgent,
  settle,
  turnDone,
  tutorialAgent,
} from '@/test/integration/chat/local-engine/kit';
import {
  activeTopicTexts,
  resetAgentWorld,
  seedFactWithTopics,
  seedSuggestion,
} from '@/test/integration/chat/tools/agents/agents-kit';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

const USER = FIXTURE_ACCOUNT.userId;

beforeEach(async () => {
  resetFileSystem();
  await resetAgentWorld();
  await setProcessingMode('on-device');
  installOnDeviceLlm();
  await setTextEngine('afm');
});
afterEach(async () => {
  await settle();
  __resetTextEngineForTests();
});

/** The built-in model answers every structured call with this value. */
const answer = (value: object) => installOnDeviceLlm({ reply: JSON.stringify(value) });

async function turn(agent: OnDeviceAgent, text: string): Promise<void> {
  const { engine } = await attachLocal(agent);
  engine.send(text);
  await turnDone();
}

const lastCall = (): OnDeviceLlmCall => onDeviceLlmCalls().at(-1)!;
const proposal = (): StagedProposal | null => useFloatingChatStore.getState().proposal;
const toolNamesOfReply = () => (lastAssistant()?.toolCalls ?? []).map((t) => t.name);

describe('the agent registry', () => {
  it('gives the on-device engine its own agents, with the cloud agents ids, and the cloud its own', () => {
    const contexts = [
      { kind: 'persona' as const },
      { kind: 'follow-story' as const },
      { kind: 'generic' as const, route: 'tutorials/a/b' },
      { kind: 'article-suggestion' as const, articleId: 'art-1' },
    ];
    for (const context of contexts) {
      const onDevice = createAgentForContext(context as never, USER, 'CONFIG', 'local');
      const cloud = createAgentForContext(context as never, USER, 'CONFIG');
      expect(onDevice.onDevice).toBe(true);
      expect('buildSystemPrompt' in onDevice).toBe(false);
      expect(typeof cloud.buildSystemPrompt).toBe('function');
      expect(onDevice.id).toBe(cloud.id);
    }
  });
});

describe('follow a story', () => {
  it('asks which story while none is named: no options, nothing staged', async () => {
    answer({ reply: 'Which story would you like to follow?', options: [] });

    await turn(new FollowStoryOnDeviceAgent(USER), 'I want to follow a story');

    expect(lastCall().kind).toBe('structured');
    // An asking turn must be possible: the schema never forces options.
    const schema = JSON.parse(lastCall().schemaJson!);
    expect(schema.properties.options).toMatchObject({ type: 'array', maxItems: 4 });
    expect(schema.properties.options.minItems).toBeUndefined();
    expect(lastAssistant()).toMatchObject({ content: 'Which story would you like to follow?', toolCalls: [] });
    expect(proposal()).toBeNull();
    expectNothingLeftTheDevice();
  });

  it('stages the options as the cloud proposeTrack proposal: single-select, nothing followed until a tap', async () => {
    answer({
      reply: 'Pick the story to follow below.',
      options: [
        { label: 'One Narrow Event In A Named Town Today', search: 'Named Town event with named people and many more words' },
        { label: 'The Wider Story', search: 'Named Region wider story' },
        { label: 'The Broad Theme', search: 'broad theme' },
      ],
    });

    await turn(new FollowStoryOnDeviceAgent(USER), 'the story about <event>');

    expect(lastAssistant()?.content).toBe('Pick the story to follow below.');
    expect(lastAssistant()?.toolCalls?.map((t) => [t.name, t.status])).toEqual([['proposeTrack', 'done']]);
    const staged = proposal()!;
    expect(staged.chooseOne).toBe(true);
    expect(staged.actions.map((a) => a.type === 'track_story' && [a.label, a.searchText, a.subject.surface])).toEqual([
      // Labels are capped at 6 words and searches at 8.
      ['One Narrow Event In A Named', 'Named Town event with named people and many', FOLLOW_STORY_SURFACE],
      ['The Wider Story', 'Named Region wider story', FOLLOW_STORY_SURFACE],
      ['The Broad Theme', 'broad theme', FOLLOW_STORY_SURFACE],
    ]);
    // The persisted record carries what the resumed card is rebuilt from.
    expect(lastAssistant()?.toolCalls?.[0].result).toMatchObject({ staged: true, chooseOne: true, proposalId: staged.id });
    expect(await activeTopicTexts()).toEqual([]);
  });

  it('describes a card still on screen in the next prompt', async () => {
    answer({ reply: 'Pick one.', options: [{ label: 'The Wider Story', search: 'Named Region story' }, { label: 'The Broad Theme', search: 'theme' }] });
    const { engine } = await attachLocal(new FollowStoryOnDeviceAgent(USER));
    engine.send('the story about <event>');
    await turnDone();
    engine.send('what is the difference?');
    await turnDone();

    expect(lastCall().prompt).toContain('A card on screen offers: The Wider Story; The Broad Theme. The user picks one by tapping it');
  });
});

describe('the article chat', () => {
  async function articleAgent(opts: { trackSubject?: boolean } = {}) {
    const { topics } = await seedFactWithTopics('Lives in <place>', ['<place> local news', '<place> transport']);
    const seeded = await seedSuggestion({
      articleId: 'art-1',
      title_en: 'A <place> headline',
      publication_name: 'The Example Times',
      matchedTopics: topics,
      relevance: 0.8,
    });
    return new ArticleFeedbackOnDeviceAgent(
      USER,
      { articleId: seeded.articleId, suggestionId: seeded.suggestionId },
      opts.trackSubject
        ? { origin: 'suggestion', surface: 'detail', articleId: seeded.articleId, title: 'A <place> headline' }
        : null,
    );
  }

  it('reads the article context: title, publication, matched topics and the facts behind them', async () => {
    answer({ intent: 'answer', reply: 'It matches where you live.' });
    await turn(await articleAgent(), 'why did I get this?');

    const { prompt, instructions } = lastCall();
    expect(prompt).toContain('Title: A <place> headline');
    expect(prompt).toContain('Publication: The Example Times');
    expect(prompt).toContain('Relevance: 8.0 out of 10.');
    expect(prompt).toContain('- <place> local news');
    expect(prompt).toContain('- Lives in <place>');
    expect(instructions).toContain('Fact checks and web searches need Private cloud');
    expect(lastAssistant()).toMatchObject({ content: 'It matches where you live.', toolCalls: [] });
  });

  it('track: stages the options against this article', async () => {
    answer({
      intent: 'track',
      reply: 'Pick the story to follow below.',
      options: [{ label: 'The Local Story', search: 'Place local story' }, { label: 'The Wider Story', search: 'Region story' }],
    });
    await turn(await articleAgent({ trackSubject: true }), 'follow this story');

    expect(toolNamesOfReply()).toEqual(['proposeTrack']);
    const actions = proposal()!.actions;
    expect(actions.map((a) => a.type === 'track_story' && [a.label, a.subject.articleId])).toEqual([
      ['The Local Story', 'art-1'],
      ['The Wider Story', 'art-1'],
    ]);
  });

  it('less: a choose-one card on a matched topic (the model named none of them, so the first)', async () => {
    answer({ intent: 'less', reply: 'Here is how far to go.', change: { topicText: 'something else', expected_effects: 'Fewer of these.' } });
    await turn(await articleAgent(), 'less of this');

    expect(toolNamesOfReply()).toEqual(['proposeChanges']);
    expect(proposal()).toMatchObject({
      explanation: 'Here is how far to go.',
      expectedEffects: 'Fewer of these.',
      chooseOne: true,
      actions: [
        { type: 'set_topic_weight', topicText: '<place> local news', delta: -0.3 },
        { type: 'retire_topic', topicText: '<place> local news' },
      ],
    });
  });

  it('more: one nudge on the topic the model named', async () => {
    answer({ intent: 'more', reply: 'More of this?', change: { topicText: '<place> transport', expected_effects: 'More of these.' } });
    await turn(await articleAgent(), 'more like this');

    expect(proposal()?.actions).toEqual([{ type: 'set_topic_weight', topicText: '<place> transport', delta: 0.3 }]);
    expect(proposal()?.chooseOne).toBeUndefined();
  });

  it('mute: the article publication, whatever the model wrote', async () => {
    answer({ intent: 'mute', reply: 'Mute this publication?' });
    await turn(await articleAgent(), 'stop showing me this source');

    expect(proposal()?.actions).toEqual([
      { type: 'set_publication_pref', publicationId: 'The Example Times', publicationPref: 'mute' },
    ]);
  });

  it('confirm applies a waiting change through the executor; cancel discards one', async () => {
    const agent = await articleAgent();
    answer({ intent: 'mute', reply: 'Mute The Example Times?' });
    const { engine } = await attachLocal(agent);
    engine.send('stop showing me this source');
    await turnDone();
    const staged = proposal()!;

    answer({ intent: 'confirm', reply: 'Done.' });
    engine.send('yes');
    await turnDone();

    expect(lastCall().prompt).toContain("A change is waiting for the user's yes or no: Mute The Example Times?");
    expect(toolNamesOfReply()).toEqual(['applyProposal']);
    expect(lastAssistant()?.toolCalls?.[0].result).toMatchObject({ applied: 1, errors: [] });
    expect(proposal()).toBeNull();
    expect(useFloatingChatStore.getState().resolvedProposals[staged.id]).toBe('applied');

    answer({ intent: 'cancel', reply: 'Nothing to cancel.' });
    engine.send('no');
    await turnDone();
    expect(toolNamesOfReply()).toEqual([]);
  });
});

describe('tutorial help', () => {
  it('streams plain text: no schema, no tools', async () => {
    installOnDeviceLlm({ reply: ['It shows ', 'your feed.'] });
    await turn(tutorialAgent(), 'what is this card?');

    expect(onDeviceLlmCalls().map((c) => c.kind)).toEqual(['stream']);
    expect(lastCall().schemaJson).toBeUndefined();
    expect(lastAssistant()).toMatchObject({ content: 'It shows your feed.', toolCalls: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------------------------

/** Names the cloud prompts carry (or carried) as examples, which a small model copies verbatim. */
const EXAMPLE_ENTITIES = [
  'Ukraine', 'Russia', 'cricket', 'Delhi', 'Amsterdam', 'DeepMind', 'Brixton', 'Lisbon', 'Bengaluru', 'Chhindwara',
  'Nieuw-West', 'Hungarian', 'Grand Prix', 'India', 'Google', 'Stripe', 'Berlin', 'Paris', 'Porto', 'Times of India',
  'Jordaan', 'Brooklyn', 'London', 'Sporting', 'Bhopal', 'Formula', 'Apple',
];

/** One turn of every flow, each with a neutral message; returns the calls the model saw. */
async function oneTurnOfEachFlow(): Promise<OnDeviceLlmCall[]> {
  const calls: OnDeviceLlmCall[] = [];
  const run = async (agent: OnDeviceAgent, reply: object | string[]) => {
    installOnDeviceLlm({ reply: Array.isArray(reply) ? reply : JSON.stringify(reply) });
    await turn(agent, 'hello');
    calls.push(...onDeviceLlmCalls());
  };
  await run(new FollowStoryOnDeviceAgent(USER), { reply: 'Which story?', options: [] });
  await run(new ArticleFeedbackOnDeviceAgent(USER, { articleId: 'none' }), { intent: 'answer', reply: 'Hi.' });
  await run(personaAgent('CONFIG'), { reply: 'Hi.', save: [] });
  await run(personaAgent('ONBOARDING'), { reply: 'Hi.', save: [] });
  await run(tutorialAgent(), ['Hi.']);
  return calls;
}

describe('every on-device prompt', () => {
  it('opens with the identity line and keeps its instructions under 150 words', async () => {
    const calls = await oneTurnOfEachFlow();
    expect(calls).toHaveLength(5);
    for (const { instructions } of calls) {
      expect(instructions.startsWith(IDENTITY_LINE)).toBe(true);
      expect(instructions.split(/\s+/).filter(Boolean).length).toBeLessThan(150);
    }
  });

  it('carries no real-world example entity, in the instructions or the prompt', async () => {
    const calls = await oneTurnOfEachFlow();
    for (const { instructions, prompt, schemaJson } of calls) {
      const text = `${instructions}\n${prompt}\n${schemaJson ?? ''}`;
      for (const name of EXAMPLE_ENTITIES) {
        expect({ name, found: new RegExp(`\\b${name}\\b`, 'i').test(text) }).toEqual({ name, found: false });
      }
    }
  });

  it('never carries the <tool_call> text format', async () => {
    for (const { instructions, prompt } of await oneTurnOfEachFlow()) {
      expect(`${instructions}${prompt}`).not.toContain('tool_call');
    }
  });
});

describe('the conversation is trimmed to the engine window', () => {
  const history = (n: number): ConversationMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i} ${'words that take up room '.repeat(8)}`.trim(),
    }));

  async function longTurn(contextSize: number | null) {
    installOnDeviceLlm({ reply: JSON.stringify({ reply: 'Ok.', save: [] }), contextSize });
    const { engine } = await attachLocal(personaAgent());
    useLocalChatStore.setState({ messages: history(40) });
    engine.send('the newest question');
    await turnDone();
    return lastCall();
  }

  it('drops the oldest turns first, keeps the newest and ends on the last user turn', async () => {
    const call = await longTurn(1500);

    expect(call.prompt.endsWith('User: the newest question')).toBe(true);
    expect(call.prompt).toContain('Mera: turn 39 ');
    expect(call.prompt).not.toContain('User: turn 0 ');
    // Everything sent fits the window less the reply: instructions, schema and prompt.
    const sent = countTokens(call.instructions) + countTokens(call.schemaJson!) + countTokens(call.prompt);
    expect(sent).toBeLessThanOrEqual(1500 - 512);
    expect(local().error).toBeNull();
  });

  it('a bigger window carries more of the conversation, never past 4,000 input tokens', async () => {
    const small = (await longTurn(1500)).prompt;
    const big = await longTurn(null);
    expect(big.prompt.length).toBeGreaterThan(small.length);
    expect(big.prompt).toContain('User: turn 0 ');
    const sent = countTokens(big.instructions) + countTokens(big.schemaJson!) + countTokens(big.prompt);
    expect(sent).toBeLessThan(4000);
  });
});
