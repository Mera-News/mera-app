// executeProposalActions: what a confirmed proposal card does, against the real fact, topic,
// suppression and tracked-story tables. The rails-backed actions run the real executor (each
// mints its own change-log row); the cloud-only ones run on the gateway mock.
import { getFacts } from '@/lib/database/services/fact-service';
import * as factService from '@/lib/database/services/fact-service';
import { createTopics, getAllByNormalizedText } from '@/lib/database/services/topic-service';
import * as suppressions from '@/lib/database/services/suppression-service';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { getScoringOverrides } from '@/lib/database/services/calibration-service';
import { findActiveTrackedId } from '@/lib/database/services/tracked-story-service';
import * as trackActions from '@/lib/tracking/track-actions';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import { useDialogQueue } from '@/lib/dialog';
import { stopAskedFactCheckPollerForTest } from '@/lib/fact-check/fact-check-graphql-client';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import * as Sentry from '@sentry/react-native';
import { gatewayCalls, initI18nEn, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, seedFacts, setProcessingMode } from '@/test/integration/chat/_helpers';
import { pollUntil, queuedJobs } from './kit';

// Sentry is the one mockable edge here: submitFeatureRequest only files feedback when init ran.
let mockSentryEnabled = true;
jest.mock('@/lib/sentry-init', () => ({
  __esModule: true,
  get SENTRY_ENABLED() {
    return mockSentryEnabled;
  },
}));

jest.setTimeout(30_000);

const NOTHING = { applied: 0, errors: [], summaries: [], changeLogIds: [] };
const factVersion = () => useFloatingChatStore.getState().factMutationVersion;

beforeEach(async () => {
  resetChatModules();
  await setProcessingMode('cloud');
  mockSentryEnabled = true;
  useDialogQueue.setState({ queue: [] });
  await initI18nEn();
  await signInFixtureAccount();
});

afterEach(() => {
  jest.restoreAllMocks();
  // fact_check_claim starts the asked-check poller; the last test would leave it running past teardown.
  stopAskedFactCheckPollerForTest();
  useDialogQueue.setState({ queue: [] });
});

describe('fact actions', () => {
  it('add_fact adds the fact and starts its topic generation', async () => {
    const result = await executeProposalActions([{ type: 'add_fact', statement: 'Likes AI news' }]);

    const [fact] = await getFacts();
    expect(fact.statement).toBe('Likes AI news');
    expect((await queuedJobs('topic_gen')).map((j) => j.payload)).toEqual([
      { factId: fact.id, factStatement: 'Likes AI news', useCloud: true },
    ]);
    expect(result).toEqual({ ...NOTHING, applied: 1 });
  });

  it('add_fact with a blank statement is an error and writes nothing', async () => {
    const result = await executeProposalActions([{ type: 'add_fact', statement: '   ' }]);

    expect(result.applied).toBe(0);
    expect(result.errors).toEqual(['add_fact: empty statement']);
    expect(await getFacts()).toEqual([]);
  });

  it('update_fact rewrites the statement and regenerates that fact\'s own topics, isolated', async () => {
    const [fact] = await seedFacts(['old']);

    const result = await executeProposalActions([{ type: 'update_fact', fact_id: fact.id, new_statement: 'new statement' }]);

    expect((await getFacts())[0].statement).toBe('new statement');
    expect((await queuedJobs('topic_gen')).map((j) => j.payload)).toEqual([
      { factId: fact.id, factStatement: 'new statement', useCloud: true },
    ]);
    expect(result).toEqual({ ...NOTHING, applied: 1 });
  });

  it('update_fact with a blank new statement is an error', async () => {
    const [fact] = await seedFacts(['old']);

    const result = await executeProposalActions([{ type: 'update_fact', fact_id: fact.id, new_statement: ' ' }]);

    expect(result.errors).toEqual([`update_fact: empty statement for ${fact.id}`]);
    expect((await getFacts())[0].statement).toBe('old');
  });

  it('delete_fact deletes an existing fact', async () => {
    const [fact] = await seedFacts(['gone soon']);

    const result = await executeProposalActions([{ type: 'delete_fact', fact_id: fact.id }]);

    expect(await getFacts()).toEqual([]);
    expect(result).toEqual({ ...NOTHING, applied: 1 });
  });

  it('add_topics merges and dedupes onto the fact metadata', async () => {
    const fact = await factService.addFact('s', { topics: ['a', 'b'] });

    const result = await executeProposalActions([{ type: 'add_topics', fact_id: fact.id, topics: ['b', 'c'] }]);

    expect((await getFacts())[0].metadata).toEqual({ topics: ['a', 'b', 'c'] });
    expect(result).toEqual({ ...NOTHING, applied: 1 });
  });

  it('remove_topics drops matching topics; a topic that is not there is a no-op', async () => {
    const fact = await factService.addFact('s', { topics: ['a', 'b', 'c'] });

    const result = await executeProposalActions([{ type: 'remove_topics', fact_id: fact.id, topics: ['b', 'zzz'] }]);

    expect((await getFacts())[0].metadata).toEqual({ topics: ['a', 'c'] });
    expect(result).toEqual({ ...NOTHING, applied: 1 });
  });

  it('notifies the fact mutation once after all actions', async () => {
    const [fact] = await seedFacts(['x']);
    const before = factVersion();

    await executeProposalActions([{ type: 'delete_fact', fact_id: fact.id }]);

    expect(factVersion()).toBe(before + 1);
  });
});

describe('missing fact_id', () => {
  it('an unknown update_fact id is a descriptive error and applies nothing', async () => {
    const result = await executeProposalActions([{ type: 'update_fact', fact_id: 'missing', new_statement: 'x' }]);

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('missing');
    expect(await getFacts()).toEqual([]);
  });

  it('reports an error for each missing id across delete, add_topics and remove_topics', async () => {
    const result = await executeProposalActions([
      { type: 'delete_fact', fact_id: 'a' },
      { type: 'add_topics', fact_id: 'b', topics: ['t'] },
      { type: 'remove_topics', fact_id: 'c', topics: ['t'] },
    ]);

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(3);
  });
});

describe('partial failure', () => {
  it('runs the valid actions and collects an error for the invalid one', async () => {
    const [existing] = await seedFacts(['exists']);

    const result = await executeProposalActions([
      { type: 'add_fact', statement: 'Added fact' },
      { type: 'delete_fact', fact_id: 'nope' },
      { type: 'update_fact', fact_id: existing.id, new_statement: 'updated' },
    ]);

    expect((await getFacts()).map((f) => f.statement).sort()).toEqual(['Added fact', 'updated']);
    expect(result.applied).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('nope');
  });

  it('a database failure on one action is collected and the next action still runs', async () => {
    const [second, first] = await seedFacts(['a', 'b']);
    // Fault injection on one call of the real service (R23): the first delete throws.
    jest.spyOn(factService, 'deleteFact').mockRejectedValueOnce(new Error('db boom'));

    const result = await executeProposalActions([
      { type: 'delete_fact', fact_id: first.id },
      { type: 'delete_fact', fact_id: second.id },
    ]);

    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('db boom');
    expect((await getFacts()).map((f) => f.id)).toEqual([first.id]);
  });
});

describe('submit_feature_request', () => {
  const request = { type: 'submit_feature_request' as const, title: 'Dark mode widgets', summary: 'Add a dark widget option.' };

  it('files the request as user feedback, once, and applies', async () => {
    const result = await executeProposalActions([request]);

    expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
    expect(Sentry.captureFeedback).toHaveBeenCalledWith({
      message: '[Feature Request] Dark mode widgets\n\nAdd a dark widget option.',
      tags: { 'feedback.source': 'mera-agent' },
    });
    expect(result).toEqual({ ...NOTHING, applied: 1 });
  });

  it('records an error when Sentry is not enabled in this build', async () => {
    mockSentryEnabled = false;

    const result = await executeProposalActions([request]);

    expect(Sentry.captureFeedback).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('feedback submission unavailable');
  });

  it('needs no fact: no lookup error and no fact write on an empty fact table', async () => {
    const result = await executeProposalActions([request]);

    expect(result.errors).toHaveLength(0);
    expect(await getFacts()).toEqual([]);
  });
});

describe('rails-backed actions (real executor, source "user")', () => {
  it('add_negative_topic mints the negative topic and a change-log row', async () => {
    const result = await executeProposalActions([{ type: 'add_negative_topic', topicText: 'Delhi crime' }]);

    const rows = await getAllByNormalizedText('delhi crime');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'Delhi crime', status: 'active', provenance: 'feedback' });
    expect(rows[0].weight).toBeLessThan(0);
    expect(result.applied).toBe(1);
    expect(result.summaries).toEqual(['Added negative topic: Delhi crime']);
    expect(result.changeLogIds).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('set_publication_pref maps the publication and pref onto the preference table', async () => {
    const result = await executeProposalActions([
      { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
    ]);

    expect(await getPreferenceKind('Times of India')).toBe('mute');
    expect(result.summaries).toEqual(['Set publication preference: Times of India → mute']);
    expect(result.changeLogIds).toHaveLength(1);
  });

  it('add_suppression stores the pattern with its keywords and strength', async () => {
    const result = await executeProposalActions([
      { type: 'add_suppression', suppressionPattern: 'lottery results', suppressionKeywords: ['lottery'], suppressionStrength: 0.9 },
    ]);

    const [row] = await suppressions.getActive();
    expect(row).toMatchObject({ pattern: 'lottery results', strength: 0.9, source: 'user' });
    expect(row.keywords).toEqual(['lottery']);
    expect(result.summaries).toEqual(['Suppressed: lottery results']);
  });

  it('add_suppression keeps a structured filter\'s kind and value instead of flattening it to a keyword', async () => {
    await executeProposalActions([
      { type: 'add_suppression', suppressionPattern: 'No Daily Mail', suppressionKind: 'publication', suppressionValue: 'Daily Mail' },
    ]);

    const [row] = await suppressions.getActive();
    expect(suppressions.kindOf(row)).toBe('publication');
    expect(row.value).toBe('Daily Mail');
  });

  it('set_topic_weight resolves the topic TEXT to its ACTIVE id, then nudges that one', async () => {
    // Two calls: within one batch a repeated text resolves to a single row.
    await createTopics([{ text: 'cricket', weight: 0.9, status: 'retired' }]);
    await createTopics([{ text: 'cricket', weight: 0.4, status: 'active' }]);

    const result = await executeProposalActions([{ type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 }]);

    const rows = await getAllByNormalizedText('cricket');
    expect(rows.find((r) => r.status === 'active')!.weight).toBeLessThan(0.4);
    expect(rows.find((r) => r.status === 'retired')!.weight).toBe(0.9);
    expect(result.applied).toBe(1);
    expect(result.changeLogIds).toHaveLength(1);
  });

  it('retire_topic resolves the text to an active id and retires it', async () => {
    const [topic] = await createTopics([{ text: 'cricket', weight: 0.6, status: 'active' }]);

    const result = await executeProposalActions([{ type: 'retire_topic', topicText: 'cricket' }]);

    expect((await getAllByNormalizedText('cricket')).find((r) => r.id === topic.id)!.status).toBe('retired');
    expect(result).toMatchObject({ applied: 1, summaries: ['Retired topic'] });
    expect(result.changeLogIds).toHaveLength(1);
  });

  it('set_high_priority pins the resolved topic', async () => {
    const [topic] = await createTopics([{ text: 'cricket', weight: 0.6, status: 'active' }]);

    const result = await executeProposalActions([{ type: 'set_high_priority', topicText: 'cricket', highPriority: true }]);

    expect((await getAllByNormalizedText('cricket')).find((r) => r.id === topic.id)!.highPriority).toBe(true);
    expect(result.summaries).toEqual(['Pinned topic as high priority']);
  });

  it('set_high_priority on a topic already in that state applies with no change-log row (today: counted as applied)', async () => {
    const [topic] = await createTopics([{ text: 'cricket', weight: 0.6, status: 'active' }]);

    const result = await executeProposalActions([{ type: 'set_high_priority', topicText: 'cricket', highPriority: false }]);

    expect((await getAllByNormalizedText('cricket')).find((r) => r.id === topic.id)!.highPriority).toBe(false);
    expect(result).toEqual({ ...NOTHING, applied: 1, summaries: ['Unpinned topic'] });
  });

  it.each([
    ['retire_topic', { type: 'retire_topic' as const, topicText: 'unknown topic' }],
    ['set_high_priority', { type: 'set_high_priority' as const, topicText: 'unknown topic', highPriority: true }],
    ['set_topic_weight', { type: 'set_topic_weight' as const, topicText: 'unknown topic', delta: 0.1 }],
  ])('%s errors, and changes nothing, when the text has no active topic', async (_name, action) => {
    const [retired] = await createTopics([{ text: 'unknown topic', weight: 0.5, status: 'retired' }]);

    const result = await executeProposalActions([action]);

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('no active topic');
    expect(result.changeLogIds).toEqual([]);
    expect((await getAllByNormalizedText('unknown topic'))[0]).toMatchObject({ id: retired.id, status: 'retired' });
  });

  it('a non-applied executor result becomes an error line: the nudge budget runs out', async () => {
    await createTopics([{ text: 'cricket', weight: 0.4, status: 'active' }]);

    const result = await executeProposalActions(
      Array.from({ length: 6 }, () => ({ type: 'set_topic_weight' as const, topicText: 'cricket', delta: -0.3 })),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(result.applied).toBeLessThan(6);
    expect(result.errors.length).toBe(6 - result.applied);
    expect(result.errors[0]).toContain('budget exhausted');
  });
});

describe('track_story (follow in chat)', () => {
  const subject = {
    origin: 'suggestion' as const,
    surface: 'detail',
    articleId: 'a-1',
    title: 'Protest escalates in Sonbhadra',
    stableClusterId: 'sc-1',
    publicationName: 'The Hindu',
  };
  const follow = { type: 'track_story' as const, label: 'Sonbhadra exam protest', searchText: 'sonbhadra student exam result protest', subject };

  it('mints the topic on the SEARCH text and follows the story under the display label', async () => {
    const result = await executeProposalActions([follow]);

    const topics = await getAllByNormalizedText('sonbhadra student exam result protest');
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ provenance: 'tracked', status: 'active', highPriority: true });
    expect(await findActiveTrackedId({ stableClusterId: 'sc-1', articleId: 'a-1' })).not.toBeNull();
    expect(result.applied).toBe(1);
    expect(result.summaries).toEqual(['Following "Sonbhadra exam protest"']);
    expect(result.errors).toEqual([]);
  });

  it('confirming the same story twice follows it once', async () => {
    await executeProposalActions([follow]);
    await executeProposalActions([follow]);

    expect(await getAllByNormalizedText('sonbhadra student exam result protest')).toHaveLength(1);
  });

  it('empty search text is an error and mints nothing', async () => {
    const result = await executeProposalActions([{ ...follow, searchText: '   ' }]);

    expect(result.applied).toBe(0);
    expect(result.errors).toEqual(['track_story: empty searchText']);
    expect(await findActiveTrackedId({ stableClusterId: 'sc-1', articleId: 'a-1' })).toBeNull();
  });

  it('collects an error but keeps going when the follow throws', async () => {
    jest.spyOn(trackActions, 'trackStoryWithProposal').mockRejectedValueOnce(new Error('mint boom'));

    const result = await executeProposalActions([follow, { type: 'add_fact', statement: 'Likes AI news' }]);

    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('mint boom');
    expect((await getFacts()).map((f) => f.statement)).toEqual(['Likes AI news']);
  });
});

// The UI-CONFIRMED actions. This executor is reached from ProposalCard's Confirm (a real tap); the
// agents strip them before delegating, and the default here refuses them too.
describe('run_calibration', () => {
  const run = (options: { confirmedByUser?: boolean } = { confirmedByUser: true }) =>
    executeProposalActions([{ type: 'run_calibration' }], options);

  it('REFUSES to run without an explicit user confirmation (the default): no model call', async () => {
    const result = await run({});

    expect(gatewayCalls()).toHaveLength(0);
    expect(result).toEqual(NOTHING);
  });

  it('still applies co-staged actions when it refuses the calibration', async () => {
    const result = await executeProposalActions([{ type: 'run_calibration' }, { type: 'add_fact', statement: 'Follows Formula 1' }]);

    expect(gatewayCalls()).toHaveLength(0);
    expect(result.applied).toBe(1);
    expect((await getFacts()).map((f) => f.statement)).toEqual(['Follows Formula 1']);
  });

  it('on-device: explains in the cloud-only dialog instead of running, and reports no error', async () => {
    await setProcessingMode('on-device');

    const result = await run();

    expect(gatewayCalls()).toHaveLength(0);
    expect(result).toEqual(NOTHING);
    const { queue } = useDialogQueue.getState();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      title: 'Mera Protocol',
      body: "This needs Mera's private cloud. You can switch in Settings, under Mera Protocol.",
    });
  });

  it('on-device with cloud chat on: still blocked, calibration is not chat', async () => {
    await setProcessingMode('on-device+cloud-chat');

    const result = await run();

    expect(gatewayCalls()).toHaveLength(0);
    expect(result).toEqual(NOTHING);
    expect(useDialogQueue.getState().queue).toHaveLength(1);
  });

  it('recalibrates and says so when the model returns tweaks that are within bounds', async () => {
    server.use(...mockGateway(() => '{"deltas":{"W_TOPIC":0.05}}'));

    const result = await run();

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(1);
    expect(result.summaries[0]).toMatch(/recalibrated/i);
    expect(Object.keys(await getScoringOverrides())).toEqual(['W_TOPIC']);
  });

  it('summarises a no-op run (nothing actionable came back) without an error', async () => {
    server.use(...mockGateway(() => 'Nothing to change.'));

    const result = await run();

    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(result.summaries[0]).toMatch(/no changes/i);
  });

  it('reports an error when the model call fails', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'bad request' } })));

    const result = await run();

    expect(result.applied).toBe(0);
    expect(result.errors).toEqual(['run_calibration: recalibration could not be completed']);
  });
});

describe('fact_check_claim', () => {
  const article = {
    type: 'fact_check_claim' as const,
    mode: 'article' as const,
    label: 'Check this article',
    claim: '',
    subject: { surface: 'fact-check-chat', articleId: 'art-1', articleTitle: 'Protest escalates' },
  };

  it('REFUSES without an explicit user confirmation: nothing starts', async () => {
    const result = await executeProposalActions([article]);

    expect(result).toEqual(NOTHING);
    expect(useFloatingChatStore.getState().quickFactChecks).toEqual([]);
  });

  it('on-device: explains in the cloud-only dialog, starts nothing and reports no error', async () => {
    await setProcessingMode('on-device');

    const result = await executeProposalActions([article], { confirmedByUser: true });

    expect(result).toEqual(NOTHING);
    expect(useFloatingChatStore.getState().quickFactChecks).toEqual([]);
    expect(useDialogQueue.getState().queue).toHaveLength(1);
  });

  it('on-device with cloud chat on: the check runs like in cloud mode, with no dialog', async () => {
    await setProcessingMode('on-device+cloud-chat');

    const result = await executeProposalActions([article], { confirmedByUser: true });

    expect(result).toMatchObject({ applied: 1, errors: [] });
    expect(useDialogQueue.getState().queue).toEqual([]);
    const settled = await pollUntil(
      async () => useFloatingChatStore.getState().quickFactChecks[0],
      (c) => c?.status !== 'running',
    );
    expect(settled).toMatchObject({ mode: 'article', articleRequested: true });
  });

  it('a claim pill with an empty claim is an error', async () => {
    const result = await executeProposalActions(
      [{ type: 'fact_check_claim', mode: 'claim', label: 'x', claim: '  ', subject: article.subject }],
      { confirmedByUser: true },
    );

    expect(result.errors).toEqual(['fact_check_claim: empty claim']);
  });

  it('an article pill with no article id is an error', async () => {
    const result = await executeProposalActions(
      [{ ...article, subject: { surface: 'fact-check-chat', articleId: '', articleTitle: 't' } }],
      { confirmedByUser: true },
    );

    expect(result.errors).toEqual(['fact_check_claim: empty articleId']);
  });

  it('cloud, confirmed: registers a running card at once and hands the article to the server check', async () => {
    const result = await executeProposalActions([article], { confirmedByUser: true });

    expect(result).toMatchObject({ applied: 1, errors: [], summaries: ['Checking "Check this article"'] });
    expect(useFloatingChatStore.getState().quickFactChecks).toHaveLength(1);
    // The check settles off the Confirm tap: the server accepted the ask.
    const settled = await pollUntil(
      async () => useFloatingChatStore.getState().quickFactChecks[0],
      (c) => c?.status !== 'running',
    );
    expect(settled).toMatchObject({ mode: 'article', articleRequested: true });
  });
});
