// Following a story on the cloud harness loop (onemera S3): a follow-story chat and the Mera button's
// persona chat both run the loop, stage the follow card, look stories up, and grow the card on
// "More options". Driven the way the app drives it: scripted gateway, real engine, real agents.
import i18n from '@/lib/i18n';
import { requestMoreOptions, stopChatTurn } from '@/lib/chat-session/chat-session';
import { pendingProposalView } from '@/lib/chat-session/cloud-engine-helpers';
import { deriveTrackProposal } from '@/components/custom/floating-chat/derive-proposals';
import { FollowStoryAgent } from '@/lib/llm/agents/FollowStoryAgent';
import { ArticleFeedbackAgent } from '@/lib/llm/agents/ArticleFeedbackAgent';
import { __resetRouterForTests as resetFallback } from '@/lib/llm/router';
import { FOLLOW_STORY_SURFACE } from '@/lib/news-harness/follow-story';
import type { ProposalAction, StagedProposal, TrackFeedbackSubject } from '@/lib/news-harness/core/types';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { FIXTURE_ACCOUNT, gatewayCalls, mockGateway, mockGql, server, signInFixtureAccount } from '@/test/helpers';
import { isRouteLeg, reply, resetChatModules, systemOf, toolCall, until } from '@/test/integration/chat/_helpers';
import { trackedStoryCount } from '@/test/integration/chat/tools/agents/agents-kit';
import { attachCloud, cloud, idle, personaAgent, settle, turnDone } from '../cloud-engine/kit';

jest.setTimeout(60_000);
afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFallback();
  await signInFixtureAccount();
  useFloatingChatStore.setState({ isExpanded: true, proposal: null, resolvedProposals: {}, toolCallResults: {} });
});

const store = () => useFloatingChatStore.getState();
const followAgent = () => new FollowStoryAgent(FIXTURE_ACCOUNT.userId);
const OPTIONS = [
  { label: 'Dutch Cabinet Talks', search: 'dutch cabinet formation talks' },
  { label: 'Dutch Coalition Politics', search: 'netherlands coalition politics' },
];
const route = reply('One moment.', toolCall('load_skill', { id: 'conversation/follow-story' }));
const stageCard = (options = OPTIONS) => reply('Pick the stories to follow below.', toolCall('proposeTrack', { options }));

/** First leg routes, the next stages a card, any leg after a tool result closes. */
const stagingGateway = (options = OPTIONS) =>
  mockGateway((c) => {
    if (isRouteLeg(c)) return route;
    if (c.messages.some((m) => m.content.includes('proposeTrack:'))) return 'Pick the stories to follow below.';
    return stageCard(options);
  });

describe('a follow-story chat runs the harness loop', () => {
  it('puts the reader\'s exact words first and the corrected form second, past the parser cap', async () => {
    const options = [
      { label: 'Ajax Feyenoord match riots', search: 'Ajax Feyenoord match riots' },
      { label: 'Dutch Football Violence', search: 'Netherlands football violence' },
      { label: 'Eredivisie Crowd Trouble', search: 'Eredivisie crowd trouble' },
      { label: 'Stadium Safety Rules', search: 'Netherlands stadium safety' },
    ];
    server.use(...stagingGateway(options));
    const { engine } = await attachCloud(followAgent());
    engine.send('keep me updated on ajax feyenord match riots');
    await turnDone();

    const live = store().proposal!;
    const labels = (actions: typeof live.actions) => actions.map((a) => (a as { label: string }).label);
    expect(labels(live.actions)).toEqual([
      'ajax feyenord match riots',
      'Ajax Feyenoord match riots',
      'Dutch Football Violence',
      'Eredivisie Crowd Trouble',
    ]);
    // The thread rebuilds the card from the staged result, not the model's arguments.
    const assistant = cloud().messages.find((m) => m.toolCalls?.some((c) => c.name === 'proposeTrack'))!;
    const call = assistant.toolCalls!.find((c) => c.name === 'proposeTrack')!;
    expect(labels(deriveTrackProposal(call)!.actions)).toEqual(labels(live.actions));
    expect(call.result).toMatchObject({
      phraseRoles: { 'ajax feyenord match riots': 'exact', 'ajax feyenoord match riots': 'corrected' },
      defaultTick: 'ajax feyenoord match riots',
    });
  });

  it('adds nothing when the message only points back', async () => {
    server.use(...stagingGateway());
    const { engine } = await attachCloud(followAgent());
    engine.send('follow this');
    await turnDone();
    expect(store().proposal?.actions.map((a) => (a as { label: string }).label)).toEqual(OPTIONS.map((o) => o.label));
  });

  it('reaches the router with the surface hint, and every leg runs thinking off', async () => {
    server.use(...stagingGateway());
    const { engine } = await attachCloud(followAgent());
    engine.send('the dutch cabinet formation talks');
    await turnDone();

    const calls = gatewayCalls('chat');
    expect(isRouteLeg(calls[0])).toBe(true);
    expect(calls[0].messages.some((m) => m.content.includes('<surface>') && m.content.includes('Followed stories page'))).toBe(true);
    expect(store().proposal?.actions).toHaveLength(3);
    expect(store().proposal?.actions[0]).toMatchObject({ type: 'track_story', subject: { surface: FOLLOW_STORY_SURFACE } });
    expect(pendingProposalView()).toMatchObject({ multiSelect: true, appliable: false });
  });

  it('a typed yes applies a one-option card', async () => {
    let turn = 1;
    server.use(
      ...mockGateway((c) => {
        if (isRouteLeg(c)) return route;
        if (turn === 1) {
          return c.messages.some((m) => m.content.includes('proposeTrack:')) ? 'Pick below.' : stageCard([OPTIONS[0]]);
        }
        return c.messages.some((m) => m.content.includes('applyProposal:')) ? 'Following it.' : reply('On it.', toolCall('applyProposal'));
      }),
    );
    const { engine } = await attachCloud(followAgent());
    engine.send('follow this');
    await turnDone();
    expect(pendingProposalView()).toMatchObject({ multiSelect: false, appliable: true });

    turn = 2;
    engine.send('yes');
    await turnDone();
    expect(await trackedStoryCount()).toBe(1);
  });

  it('a two-option card is told to be ticked, and applyProposal is not offered', async () => {
    server.use(...stagingGateway());
    const { engine } = await attachCloud(followAgent());
    engine.send('the dutch cabinet formation talks');
    await turnDone();

    engine.send('yes');
    await turnDone();
    const skillLeg = gatewayCalls('chat').filter((c) => c.messages.some((m) => m.content === 'yes') && !isRouteLeg(c))[0];
    expect(systemOf(skillLeg)).not.toContain('<name>applyProposal</name>');
    expect(JSON.stringify(skillLeg.messages)).toContain('tap the ones they want');
    expect(await trackedStoryCount()).toBe(0);
  });

  it('a card that grew to three refuses a typed yes even when its first staging held one', async () => {
    const grown: StagedProposal = {
      id: 'track-1', explanation: '', expectedEffects: '',
      actions: ['A', 'B', 'C'].map((label): ProposalAction => ({
        type: 'track_story', label, searchText: label, subject: { origin: 'article', surface: FOLLOW_STORY_SURFACE, articleId: '', title: '' } as TrackFeedbackSubject,
      })),
    };
    store().setProposal(grown);
    expect(pendingProposalView()).toMatchObject({ multiSelect: true, appliable: false });
    const res = await followAgent().executeTool('applyProposal', {});
    expect(res.result).toMatchObject({ applied: 0, awaitingUserConfirmation: true });
    expect(await trackedStoryCount()).toBe(0);
  });

  it('a turn that ends with nothing to say shows the no-answer line', async () => {
    // The replayed "see-less" row: facts legs that stage nothing, then silence, then an empty closing leg.
    const legs = [
      reply('Got it.', toolCall('load_skill', { id: 'facts/interest' })),
      reply('', toolCall('find_similar_facts', { kind: 'generic' })),
      reply('', toolCall('saveExtractedFacts', { extracted_user_information: [] })),
      reply('', toolCall('saveExtractedFacts', { extracted_user_information: [{ statement: 'Does not want topics about Bollywood', questionnaire_attribute: 'topics: general interests' }] })),
    ];
    server.use(...mockGateway((c) => legs[c.index] ?? ''));
    const { engine } = await attachCloud(personaAgent());
    await i18n.changeLanguage('de');
    try {
      engine.send('Do not show me anything about Bollywood');
      await turnDone();
    } finally {
      await i18n.changeLanguage('en');
    }
    // German, not the harness's English constant: the line is translated at the call site.
    expect(cloud().messages.some((m) => m.content === 'Das konnte ich nicht. Frag noch einmal anders.')).toBe(true);
  });
});

describe('the Mera button persona chat can follow a story', () => {
  it('stages a track_story card with the tracked-stories-chat subject', async () => {
    server.use(...stagingGateway());
    const { engine } = await attachCloud(personaAgent());
    engine.send('I want to follow the dutch cabinet talks');
    await turnDone();
    expect(store().proposal?.actions[0]).toMatchObject({ type: 'track_story', subject: { surface: 'tracked-stories-chat' } });
  });

  it('looks stories up in Mera\'s own index', async () => {
    let queried = false;
    server.use(
      mockGql('SearchNews', () => { queried = true; return { searchNews: [] }; }),
      ...mockGateway((c) => {
        if (isRouteLeg(c)) return route;
        if (c.messages.some((m) => m.content.includes('searchNews:'))) return 'Nothing new.';
        return reply('', toolCall('searchNews', { query: 'dutch cabinet' }));
      }),
    );
    const { engine } = await attachCloud(personaAgent());
    engine.send('follow the dutch cabinet talks');
    await turnDone();
    expect(queried).toBe(true);
  });
});

describe('"user followed" (A8)', () => {
  /** A thread whose follow card held three rows and grew a fourth: two followed, one ticked off, one grown. */
  const seedFollowedCard = () =>
    cloud().setMessages([
      {
        id: 'asst-1', role: 'assistant', content: '',
        toolCalls: [{ id: 't1', name: 'proposeTrack', input: { options: [] }, status: 'done',
          result: { staged: true, proposalId: 'track-1', options: [{ label: 'Alpha', search: 'alpha' }, { label: 'Beta', search: 'beta' }, { label: 'Gamma', search: 'gamma' }] } }],
      },
    ] as never);
  const overrideCard = () =>
    store().setToolCallResult('asst-1::0', {
      staged: true, proposalId: 'track-1',
      options: [{ label: 'Alpha', search: 'alpha' }],
      cardOptions: [
        { label: 'Alpha', search: 'alpha' }, { label: 'Beta', search: 'beta' },
        { label: 'Gamma', search: 'gamma' }, { label: 'Delta', search: 'delta' },
      ],
      followed: { alpha: 'following', beta: 'already', gamma: 'failed' },
    });

  it('the harness legs carry the followed labels, not the failed or grown ones', async () => {
    server.use(...mockGateway((c) => (isRouteLeg(c) ? route : 'Okay.')));
    seedFollowedCard();
    overrideCard();
    const { engine } = await attachCloud(followAgent());
    engine.send('something else');
    await turnDone();
    const text = JSON.stringify(gatewayCalls('chat')[0].messages);
    expect(text).toContain('user followed: Alpha, Beta');
    expect(text).not.toContain('Gamma');
    expect(text).not.toContain('Delta');
  });

  it('the single-shot context carries them too', async () => {
    server.use(...mockGateway(() => 'Okay.'));
    seedFollowedCard();
    overrideCard();
    const { engine } = await attachCloud(new ArticleFeedbackAgent(FIXTURE_ACCOUNT.userId, { articleId: 'art-1', suggestionId: 'sug-1' }, null));
    engine.send('why was this shown?');
    await turnDone();
    expect(JSON.stringify(gatewayCalls('chat')[0].messages)).toContain('user followed: Alpha, Beta');
  });
});

describe('More options', () => {
  const SUBJECT: TrackFeedbackSubject = {
    origin: 'article', surface: FOLLOW_STORY_SURFACE, articleId: '', title: 'stamped', pubDate: null, stableClusterId: null, publicationName: null,
  };
  const shown = OPTIONS.map((o): ProposalAction => ({ type: 'track_story', label: o.label, searchText: o.search, subject: SUBJECT }));

  it('keeps only new options, stamps the subject and writes nothing', async () => {
    server.use(
      ...mockGateway(() =>
        reply('', toolCall('proposeTrack', { options: [
          OPTIONS[0],
          { label: 'Reworded', search: ' Netherlands  Coalition POLITICS ' },
          { label: 'Dutch Budget Fight', search: 'dutch budget 2027' },
          { label: 'Dutch Housing Plan', search: 'dutch housing plan' },
        ] })),
      ),
    );
    await attachCloud(followAgent());
    const res = await requestMoreOptions('track-1', shown);

    expect(res.actions.map((a) => a.label)).toEqual(['Dutch Budget Fight', 'Dutch Housing Plan']);
    expect(res.actions.every((a) => a.subject === SUBJECT || a.subject.title === 'stamped')).toBe(true);
    expect(store().proposal).toBeNull();
    expect(cloud().messages).toEqual([]);
    expect(cloud().wireMessages).toEqual([]);
  });

  it('works without structuredClone (Hermes) and leaves the conversation turn state alone', async () => {
    let turn = 0;
    server.use(
      ...mockGateway((call) => {
        if (call.route !== 'chat') return '';
        turn += 1;
        if (turn === 1) return reply('The Dutch cabinet talks.', toolCall('load_skill', { id: 'conversation/follow-story' }));
        if (turn === 2) return reply('Pick the stories to follow below.', toolCall('proposeTrack', { options: OPTIONS }));
        return reply('', toolCall('proposeTrack', { options: [{ label: 'Dutch Budget Fight', search: 'dutch budget fight' }] }));
      }),
    );
    const { engine } = await attachCloud(followAgent());
    engine.send('the dutch cabinet formation talks');
    await turnDone();
    const before = JSON.stringify(cloud().agentTurnState);
    const saved = globalThis.structuredClone;
    // @ts-expect-error: simulating a runtime without it
    delete globalThis.structuredClone;
    try {
      const res = await requestMoreOptions('track-1', shown);
      expect(res.actions.map((a) => a.label)).toEqual(['Dutch Budget Fight']);
    } finally {
      globalThis.structuredClone = saved;
    }
    expect(JSON.stringify(cloud().agentTurnState)).toBe(before);
  });

  it('answers none when nothing new came back', async () => {
    server.use(...mockGateway(() => reply('', toolCall('proposeTrack', { options: [OPTIONS[0]] }))));
    await attachCloud(followAgent());
    await expect(requestMoreOptions('track-1', shown)).resolves.toEqual({ actions: [], reason: 'none' });
  });

  it('answers busy while a turn runs', async () => {
    server.use(...mockGateway(() => ({ chunks: ['One moment '], stallAfter: 1 })));
    const { engine } = await attachCloud(followAgent());
    engine.send('the dutch cabinet formation talks');
    await until(() => gatewayCalls('chat').length > 0, 15_000, 'turn started');
    await expect(engine.moreOptions!({ proposalId: 'track-1', shown: [], room: 3, subject: SUBJECT })).resolves.toEqual({
      actions: [], reason: 'busy',
    });
    stopChatTurn();
    await until(idle, 10_000, 'turn ends');
  });

  it('no turn starts while it runs: a send is refused and a hidden turn waits for it', async () => {
    server.use(
      ...mockGateway((call) => (call.route === 'chat' && gatewayCalls('chat').length <= 1
        ? reply('', toolCall('proposeTrack', { options: [{ label: 'Dutch Budget Fight', search: 'dutch budget fight' }] }))
        : reply('Noted.'))),
    );
    const { engine } = await attachCloud(followAgent());
    const pending = requestMoreOptions('track-1', shown);
    engine.send('the dutch cabinet formation talks');
    engine.sendHidden('a hidden note');
    expect(cloud().messages).toEqual([]);
    await expect(pending).resolves.toMatchObject({ actions: [expect.objectContaining({ label: 'Dutch Budget Fight' })] });
    expect(gatewayCalls('chat')).toHaveLength(1);
    // The hidden turn was queued, not dropped: it runs once More options is over.
    await until(() => gatewayCalls('chat').length > 1, 15_000, 'hidden turn after More options');
    await until(idle, 15_000, 'hidden turn ends');
    expect(cloud().messages.filter((m) => m.role === 'user')).toEqual([]);
  });

  it('is stopped by the Stop button, which shows while it runs', async () => {
    server.use(...mockGateway(() => ({ chunks: ['One moment '], stallAfter: 1 })));
    await attachCloud(followAgent());
    const pending = requestMoreOptions('track-1', shown);
    await until(() => store().isGenerating && gatewayCalls('chat').length > 0, 15_000, 'More options running');
    expect(cloud().agentTurnState?.turnActive ?? false).toBe(false);
    stopChatTurn();
    await expect(pending).resolves.toEqual({ actions: [], reason: 'stopped' });
    expect(store().isGenerating).toBe(false);
  });
});

describe('an interest with no stake, through the real engine', () => {
  const KEY = 'topics: general interests';
  const noStake = { statement: 'Follows Rally Finland', questionnaire_attribute: KEY, has_stake: false, story_subject: 'Rally Finland' };
  const gateway = (subject: string | null = 'Rally Finland') =>
    mockGateway((c) => {
      if (isRouteLeg(c)) return reply('Nice.', toolCall('load_skill', { id: 'facts/interest' }));
      if (systemOf(c).includes('Follow a story') || c.messages.some((m) => m.content.includes('story to follow'))) {
        return stageCard([{ label: 'WRC Results', search: 'World Rally Championship results' }]);
      }
      return toolCall('saveExtractedFacts', { extracted_user_information: [{ ...noStake, story_subject: subject }] });
    });

  it('a persona chat stages the follow card with the subject first and ticked, and no reader phrase', async () => {
    server.use(...gateway());
    const { engine } = await attachCloud(personaAgent());
    engine.send("I'm into rally finland");
    await turnDone();
    const labels = store().proposal!.actions.map((a) => (a as { label: string }).label);
    expect(labels).toEqual(['Rally Finland', 'WRC Results']);
    expect(labels.join(' ')).not.toContain("I'm");
    const facts = cloud().messages.flatMap((m) => m.toolCalls ?? []).filter((t) => t.name === 'proposeTrack');
    expect(facts[0].result).toMatchObject({ storySubjects: ['Rally Finland'], profileOffer: [{ statement: 'Follows Rally Finland' }] });
  });

  it('the impact question joins the thread with no model call, and the next turn reads it', async () => {
    server.use(...gateway());
    const { engine } = await attachCloud(personaAgent());
    engine.send("I'm into rally finland");
    await turnDone();
    const before = gatewayCalls().length;
    await engine.askImpact!('Before I add it, how does this affect you?');
    expect(gatewayCalls()).toHaveLength(before);
    const last = cloud().messages[cloud().messages.length - 1];
    expect(last).toMatchObject({ role: 'assistant', content: 'Before I add it, how does this affect you?' });
    expect(cloud().agentTurnState).toMatchObject({ lastSkill: 'facts/interest', impactAsked: true, lastQuestion: 'Before I add it, how does this affect you?' });
  });
});
