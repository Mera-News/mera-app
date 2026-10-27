// persona-action-executor: the single dispatch point for persona mutations, on the real in-memory DB.
// Every applied action writes its rows, appends exactly one invertible change-log row and hands back
// its id; a hard filter or a mute is retroactive, so its sweep must visibly act on stored suggestions.
// Replaces the mocked persona-action-executor*.test.ts suites.
import { applyPersonaAction, applyPersonaActions } from '@/lib/database/services/persona-action-executor';
import { revertChange } from '@/lib/database/services/persona-change-log-service';
import { addSuppression, getAll as allSuppressions } from '@/lib/database/services/suppression-service';
import { setPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  DAY,
  NOON,
  freezeClock,
  failTableQuery,
  logRows,
  logsOf,
  quietLogger,
  resetPersonaMemory,
  restoreFaults,
  rowById,
  rowsOf,
  seedArticles,
  seedFeedOrder,
  seedInterest,
  seedPlace,
  settleWrites,
  statuses,
} from './support';

const A = ACTION_NAMES;

let logs: ReturnType<typeof quietLogger>;
beforeEach(() => {
  logs = quietLogger();
  resetPersonaMemory();
});
afterEach(async () => {
  restoreFaults();
  await settleWrites();
  logs.restore();
});

const supRows = () => allSuppressions();
const prefRows = () => rowsOf('publication_preferences');

// ---------------------------------------------------------------------------
// The dispatch table itself
// ---------------------------------------------------------------------------

describe('every action name has exactly one fate', () => {
  const APPLIED = [
    A.SET_TOPIC_WEIGHT, A.SET_HIGH_PRIORITY, A.SET_FACT_WEIGHT, A.ADD_NEGATIVE_TOPIC, A.ADD_TOPIC,
    A.RETIRE_TOPIC, A.DISCARD_FACT, A.ADD_SUPPRESSION, A.RETIRE_SUPPRESSION, A.SET_LOCATION_WEIGHT,
    A.SET_PUBLICATION_PREF, A.SET_SOURCE_SCOPE_PREF,
  ];
  const SUGGESTIONS = [A.NUDGE_SUBSCRIBE_PUBLICATION, A.NUDGE_BROWSE_RELATED];
  const UNSUPPORTED = [
    A.SUPPRESS_TOPIC, A.REASSIGN_TOPIC, A.MERGE_FACTS, A.HYGIENE_DELETE_FACT, A.ADD_LOCATION,
    A.DELETE_LOCATION, A.REVERT_CHANGE, A.SET_FACT_PLACES, A.SET_FACT_NEWS_STOPPED,
  ];

  it('the three groups cover ACTION_NAMES exactly, so a new name fails here until it is classified', () => {
    expect([...APPLIED, ...SUGGESTIONS, ...UNSUPPORTED].sort()).toEqual(Object.values(A).sort());
  });

  it.each(UNSUPPORTED)('%s is rejected as unsupported and writes nothing', async (name) => {
    const { fact, topics } = await seedInterest('I follow F1', ['formula 1']);

    const res = await applyPersonaAction(
      { action_type: name, topicId: topics[0].id, factId: fact.id, topicText: 'x' },
      'feedback',
    );

    expect(res).toEqual({ applied: false, summary: `unsupported: ${name}` });
    expect(await logRows()).toEqual([]);
    expect((await rowById('topics', topics[0].id)).weight).toBe(1);
    expect((await rowById('topics', topics[0].id)).status).toBe('active');
  });

  it('an action type nobody has heard of is rejected without writing', async () => {
    const res = await applyPersonaAction({ action_type: 'launch_missiles' as never }, 'feedback');

    expect(res).toEqual({ applied: false, summary: 'unsupported: launch_missiles' });
    expect(await logRows()).toEqual([]);
    expect(await rowsOf('topics')).toEqual([]);
    expect(await supRows()).toEqual([]);
  });

  it('the nudge suggestions are not mutations: not applied, no change-log row', async () => {
    const sub = await applyPersonaAction(
      { action_type: A.NUDGE_SUBSCRIBE_PUBLICATION, publicationId: 'The Times' },
      'feedback',
    );
    const subBare = await applyPersonaAction({ action_type: A.NUDGE_SUBSCRIBE_PUBLICATION }, 'feedback');
    const byText = await applyPersonaAction({ action_type: A.NUDGE_BROWSE_RELATED, topicText: 'space' }, 'feedback');
    const byId = await applyPersonaAction({ action_type: A.NUDGE_BROWSE_RELATED, topicId: 't9' }, 'feedback');
    const bare = await applyPersonaAction({ action_type: A.NUDGE_BROWSE_RELATED }, 'feedback');

    expect(sub).toEqual({ applied: false, summary: 'Suggestion: subscribe to The Times' });
    expect(subBare.summary).toBe('Suggestion: subscribe to publication');
    expect(byText.summary).toBe('Suggestion: browse related to space');
    expect(byId.summary).toBe('Suggestion: browse related to t9');
    expect(bare.summary).toBe('Suggestion: browse related to topic');
    expect(await logRows()).toEqual([]);
  });

  it.each([
    [{ action_type: A.SET_TOPIC_WEIGHT, delta: 0.1 }, 'skipped set_topic_weight: missing topicId'],
    [{ action_type: A.SET_TOPIC_WEIGHT, topicId: 'x' }, 'skipped set_topic_weight: no delta or weight'],
    [{ action_type: A.SET_HIGH_PRIORITY, highPriority: true }, 'skipped set_high_priority: missing topicId'],
    [{ action_type: A.SET_HIGH_PRIORITY, topicId: 'x' }, 'skipped set_high_priority: missing highPriority'],
    [{ action_type: A.SET_FACT_WEIGHT, delta: 0.1 }, 'skipped set_fact_weight: missing factId'],
    [{ action_type: A.SET_FACT_WEIGHT, factId: 'x' }, 'skipped set_fact_weight: missing delta'],
    [{ action_type: A.ADD_NEGATIVE_TOPIC, topicText: '   ' }, 'skipped add_negative_topic: missing topicText'],
    [{ action_type: A.ADD_TOPIC }, 'skipped add_topic: missing topicText'],
    [{ action_type: A.RETIRE_TOPIC }, 'skipped retire_topic: missing topicId'],
    [{ action_type: A.DISCARD_FACT }, 'skipped discard_fact: missing factId'],
    [{ action_type: A.ADD_SUPPRESSION, suppressionPattern: '  ' }, 'skipped add_suppression: missing suppressionPattern'],
    [{ action_type: A.RETIRE_SUPPRESSION }, 'skipped retire_suppression: missing suppressionId'],
    [{ action_type: A.SET_LOCATION_WEIGHT, weight: 0.5 }, 'skipped set_location_weight: missing locationId'],
    [{ action_type: A.SET_LOCATION_WEIGHT, locationId: 'x' }, 'skipped set_location_weight: missing weight'],
    [{ action_type: A.SET_PUBLICATION_PREF, publicationPref: 'boost' }, 'skipped set_publication_pref: missing publicationId'],
    [{ action_type: A.SET_PUBLICATION_PREF, publicationId: 'x' }, 'skipped set_publication_pref: missing publicationPref'],
    [{ action_type: A.SET_SOURCE_SCOPE_PREF, scopeValue: 'IND', publicationPref: 'boost' }, 'skipped set_source_scope_pref: missing scopeKind'],
    [{ action_type: A.SET_SOURCE_SCOPE_PREF, scopeKind: 'country', publicationPref: 'boost' }, 'skipped set_source_scope_pref: missing scopeValue'],
    [{ action_type: A.SET_SOURCE_SCOPE_PREF, scopeKind: 'country', scopeValue: 'IND' }, 'skipped set_source_scope_pref: missing publicationPref'],
    [
      { action_type: A.SET_SOURCE_SCOPE_PREF, scopeKind: 'country', scopeValue: 'IND', publicationPref: 'mute' },
      'skipped set_source_scope_pref: a source scope cannot be muted',
    ],
  ] as const)('an incomplete %j is skipped, never thrown, and writes nothing', async (action, summary) => {
    const res = await applyPersonaAction({ ...action } as never, 'feedback');

    expect(res).toEqual({ applied: false, summary });
    expect(await logRows()).toEqual([]);
    expect(await prefRows()).toEqual([]);
    expect(await supRows()).toEqual([]);
  });
});

describe('applyPersonaActions (batch)', () => {
  it('applies each action in order and returns per-action results', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);

    const results = await applyPersonaActions(
      [
        { action_type: A.RETIRE_TOPIC, topicId: topics[0].id },
        { action_type: A.NUDGE_BROWSE_RELATED, topicText: 'space' },
        { action_type: A.MERGE_FACTS },
      ],
      'feedback',
    );

    expect(results.map((r) => r.applied)).toEqual([true, false, false]);
    expect(results[2].summary).toBe('unsupported: merge_facts');
    expect((await rowById('topics', topics[0].id)).status).toBe('retired');
    expect((await logRows()).map((r) => r.actionType)).toEqual(['retire_topic']);
  });

  it('one failing action does not abort the batch: it is caught, reported and logged', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);

    const results = await applyPersonaActions(
      [
        { action_type: A.RETIRE_TOPIC, topicId: 'no-such-topic' },
        { action_type: A.SET_HIGH_PRIORITY, topicId: topics[0].id, highPriority: true },
      ],
      'feedback',
    );

    expect(results[0]).toEqual({ applied: false, summary: 'error applying retire_topic' });
    expect(results[1].applied).toBe(true);
    expect((await rowById('topics', topics[0].id)).highPriority).toBe(true);
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'persona-action-executor', action_type: 'retire_topic' },
    });
    // the failed retire never reached its change-log append
    expect(await logsOf('retire_topic')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Topic and fact weights
// ---------------------------------------------------------------------------

describe('set_topic_weight', () => {
  it('a delta is a budget-leashed nudge: weight moves, the row logs before/after/delta and the id is returned', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);

    const res = await applyPersonaAction(
      { action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: -0.15 },
      'feedback',
    );

    expect(res.applied).toBe(true);
    expect(res.summary).toBe('Nudged topic weight to 0.35');
    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.35);
    const [row] = await logsOf('set_topic_weight');
    expect(row.id).toBe(res.changeLogId);
    expect(row).toMatchObject({ source: 'feedback', summary: 'Adjusted topic weight 0.50 → 0.35', reverted: false });
    expect(row.action).toMatchObject({ targetId: topics[0].id, before: 0.5 });
    expect(row.action.after as number).toBeCloseTo(0.35);
    expect(row.action.delta as number).toBeCloseTo(-0.15);
  });

  it('a delta larger than the day budget (0.3) is cut to the budget; once spent, the weight is left alone, nothing is logged and no id returned', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    const nudge = (delta: number) =>
      applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta }, 'feedback');

    const first = await nudge(-0.5);
    const second = await nudge(-0.15);

    expect(first).toMatchObject({ applied: true, summary: 'Nudged topic weight to 0.20' });
    expect((await logsOf('set_topic_weight'))[0].action.delta as number).toBeCloseTo(-0.3);
    expect(second).toEqual({
      applied: false,
      changeLogId: undefined,
      summary: 'Nudge budget exhausted; topic weight unchanged',
    });
    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.2);
    expect(await logsOf('set_topic_weight')).toHaveLength(1);
  });

  it('an absolute weight is clamped to [-1, 1], logs before/after and returns the id', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    const set = (weight: number) =>
      applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, weight }, 'user');

    const up = await set(1.7);
    expect(up).toMatchObject({ applied: true, summary: 'Set topic weight to 1.00' });
    expect((await rowById('topics', topics[0].id)).weight).toBe(1);
    const down = await set(-4);
    expect(down.summary).toBe('Set topic weight to -1.00');
    expect((await rowById('topics', topics[0].id)).weight).toBe(-1);

    const rows = await logsOf('set_topic_weight');
    expect(rows.map((r) => r.id)).toEqual([up.changeLogId, down.changeLogId]);
    expect(rows[0].action).toEqual({ targetId: topics[0].id, before: 0.5, after: 1 });
    expect(rows[1].summary).toBe('Set topic weight 1.00 → -1.00');
  });

  it('setting the weight it already has is applied:false with no row', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);

    const res = await applyPersonaAction(
      { action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, weight: 0.5 },
      'feedback',
    );

    expect(res).toEqual({ applied: false, changeLogId: undefined, summary: 'Topic weight unchanged' });
    expect(await logRows()).toEqual([]);
  });

  it('a delta wins over a weight when both are given', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);

    await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: 0.1, weight: -1 }, 'feedback');

    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.6);
  });

  it('an unknown topic id is caught: not applied, error summary, exception captured, nothing logged', async () => {
    const res = await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: 'ghost', delta: 0.1 }, 'feedback');

    expect(res).toEqual({ applied: false, summary: 'error applying set_topic_weight' });
    expect(logs.captureException).toHaveBeenCalledTimes(1);
    expect(await logRows()).toEqual([]);
  });
});

describe('set_high_priority', () => {
  it('pins a topic and returns the id of its row', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);

    const res = await applyPersonaAction(
      { action_type: A.SET_HIGH_PRIORITY, topicId: topics[0].id, highPriority: true },
      'feedback',
    );

    expect(res).toMatchObject({ applied: true, summary: 'Pinned topic as high priority' });
    expect((await rowById('topics', topics[0].id)).highPriority).toBe(true);
    const [row] = await logsOf('set_high_priority');
    expect(row.id).toBe(res.changeLogId);
    expect(row.action).toEqual({ targetId: topics[0].id, before: false, after: true });
    expect(row.summary).toBe('Pinned topic as high priority');
  });

  it('a no-op pin is reported applied with no id and no row (there is nothing to revert)', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);

    const res = await applyPersonaAction(
      { action_type: A.SET_HIGH_PRIORITY, topicId: topics[0].id, highPriority: false },
      'feedback',
    );

    expect(res).toEqual({ applied: true, changeLogId: undefined, summary: 'Unpinned topic' });
    expect(await logRows()).toEqual([]);
  });
});

describe('set_fact_weight', () => {
  it('nudges a fact, logs the prior weight and returns the id', async () => {
    const { fact } = await seedInterest('I follow F1', ['formula 1']);
    await applyPersonaAction({ action_type: A.SET_FACT_WEIGHT, factId: fact.id, delta: -0.2 }, 'feedback'); // null -> 0.8

    const res = await applyPersonaAction({ action_type: A.SET_FACT_WEIGHT, factId: fact.id, delta: -0.2 }, 'feedback');

    expect(res).toMatchObject({ applied: true, summary: 'Adjusted fact weight' });
    expect((await rowById('facts', fact.id)).weight).toBeCloseTo(0.6);
    const rows = await logsOf('set_fact_weight');
    expect(rows[1].id).toBe(res.changeLogId);
    expect(rows[1].action.before as number).toBeCloseTo(0.8);
    expect(rows[1].action.after as number).toBeCloseTo(0.6);
  });
});

// ---------------------------------------------------------------------------
// Minting and retiring topics, discarding facts
// ---------------------------------------------------------------------------

describe('add_negative_topic / add_topic', () => {
  it('mints a negative topic at the default -0.6, trimmed, active, feedback-owned, and logs it', async () => {
    const res = await applyPersonaAction({ action_type: A.ADD_NEGATIVE_TOPIC, topicText: '  cricket ' }, 'feedback');

    expect(res).toMatchObject({ applied: true, summary: 'Added negative topic: cricket' });
    const [topic] = await rowsOf('topics');
    expect(topic).toMatchObject({ text: 'cricket', weight: -0.6, status: 'active', provenance: 'feedback' });
    const [row] = await logsOf('add_negative_topic');
    expect(row.id).toBe(res.changeLogId);
    expect(row.action).toEqual({ targetId: topic.id, text: 'cricket' });
    expect(row.summary).toBe('Added negative topic: cricket');
  });

  it('honours an explicit weight, including a weight of 0', async () => {
    await applyPersonaAction({ action_type: A.ADD_NEGATIVE_TOPIC, topicText: 'cricket', weight: -0.9 }, 'feedback');
    await applyPersonaAction({ action_type: A.ADD_NEGATIVE_TOPIC, topicText: 'golf', weight: 0 }, 'feedback');

    const byText = Object.fromEntries((await rowsOf('topics')).map((t) => [t.text, t.weight]));
    expect(byText).toEqual({ cricket: -0.9, golf: 0 });
  });

  it('mints a positive topic at the default 0.5 and logs it', async () => {
    const res = await applyPersonaAction({ action_type: A.ADD_TOPIC, topicText: 'formula 1' }, 'chat');

    expect(res).toMatchObject({ applied: true, summary: 'Added topic: formula 1' });
    const [topic] = await rowsOf('topics');
    expect(topic).toMatchObject({ text: 'formula 1', weight: 0.5, status: 'active', provenance: 'feedback' });
    expect((await logsOf('add_topic'))[0]).toMatchObject({ id: res.changeLogId, source: 'chat' });
  });
});

describe('retire_topic', () => {
  it('retires the topic (the row stays) and logs it', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);

    const res = await applyPersonaAction({ action_type: A.RETIRE_TOPIC, topicId: topics[0].id }, 'feedback');

    expect(res).toMatchObject({ applied: true, summary: 'Retired topic' });
    expect((await rowById('topics', topics[0].id)).status).toBe('retired');
    expect((await logsOf('retire_topic'))[0]).toMatchObject({ id: res.changeLogId, action: { targetId: topics[0].id } });
  });
});

describe('discard_fact', () => {
  it('destroys the fact and its topics, logs the statement, and cannot be reverted', async () => {
    const { fact } = await seedInterest('Lives in Amsterdam', ['amsterdam', 'dutch news']);

    const res = await applyPersonaAction({ action_type: A.DISCARD_FACT, factId: fact.id }, 'chat');

    expect(res).toMatchObject({ applied: true, summary: 'Discarded fact: Lives in Amsterdam' });
    expect(await rowsOf('facts')).toEqual([]);
    expect(await rowsOf('topics')).toEqual([]);
    const [row] = await logsOf('discard_fact');
    expect(row).toMatchObject({ id: res.changeLogId, action: { targetId: fact.id, statement: 'Lives in Amsterdam' } });
    await expect(revertChange(row.id)).rejects.toThrow("no inverse implemented for action_type 'discard_fact'");
    expect((await logsOf('discard_fact'))[0].reverted).toBe(false);
  });

  it('an unknown fact is reported not found and writes nothing', async () => {
    await seedInterest('Lives in Amsterdam', ['amsterdam']);

    const res = await applyPersonaAction({ action_type: A.DISCARD_FACT, factId: 'ghost' }, 'chat');

    expect(res).toEqual({ applied: false, summary: 'fact not found' });
    expect(await rowsOf('facts')).toHaveLength(1);
    expect(await logRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suppressions: structured kinds, row source, and the retroactive hard sweep (D12)
// ---------------------------------------------------------------------------

describe('add_suppression', () => {
  it('stores the pattern, keywords, defaults and a soft 30-day expiry, and logs targetId/kind/value', async () => {
    freezeClock(NOON);

    const res = await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: ' gossip ', suppressionKeywords: ['gossip', 'celebrity'] },
      'feedback',
    );

    expect(res).toMatchObject({ applied: true, summary: 'Suppressed: gossip' });
    const [s] = await supRows();
    expect(s).toMatchObject({ pattern: 'gossip', strength: 0.5, source: 'feedback', status: 'active', kind: null, value: null });
    expect(s.keywords).toEqual(['gossip', 'celebrity']);
    expect(s.expiresAt).toBe(NOON + 30 * DAY);
    const [row] = await logsOf('add_suppression');
    expect(row).toMatchObject({ id: res.changeLogId, summary: 'Suppressed: gossip' });
    expect(row.action).toEqual({ targetId: s.id }); // undefined kind/value are not serialised
  });

  it('a hard filter (strength >= 0.8) has no expiry', async () => {
    await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'gossip', suppressionStrength: 0.9 }, 'user');

    expect((await supRows())[0].expiresAt).toBeNull();
  });

  it('passes a valid structured kind and value through, and logs them', async () => {
    const res = await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'Sports', suppressionKind: 'category', suppressionValue: ' sports ' },
      'feedback',
    );

    const [s] = await supRows();
    expect(s).toMatchObject({ kind: 'category', value: 'sports' });
    expect((await logsOf('add_suppression'))[0]).toMatchObject({
      id: res.changeLogId,
      action: { targetId: s.id, kind: 'category', value: 'sports' },
    });
  });

  it.each(['publication', 'entity', 'place', 'event_type', 'topic', 'keyword'])('accepts the v46 kind %s', async (kind) => {
    await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'x', suppressionKind: kind, suppressionValue: 'v' },
      'feedback',
    );

    expect((await supRows())[0].kind).toBe(kind);
  });

  it('degrades an unrecognised kind to NULL (reads as keyword), keeping the inert value', async () => {
    await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'x', suppressionKind: 'sentiment', suppressionValue: 'negative' },
      'feedback',
    );

    expect((await supRows())[0]).toMatchObject({ kind: null, value: 'negative' });
  });

  it.each(['category', 'entity', 'publication', 'place', 'event_type', 'topic'])(
    'degrades a VALUELESS structured kind %s to keyword: it could never match anything',
    async (kind) => {
      await applyPersonaAction(
        { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'Sports', suppressionKind: kind, suppressionValue: '   ' },
        'feedback',
      );

      expect((await supRows())[0]).toMatchObject({ kind: null, value: null });
    },
  );

  it('keeps an explicit keyword kind with no value (its keywords carry it)', async () => {
    await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'gossip', suppressionKind: 'keyword', suppressionKeywords: ['gossip'] },
      'feedback',
    );

    expect((await supRows())[0]).toMatchObject({ kind: 'keyword', value: null });
  });

  it("stores row source 'user' for a user filter and 'feedback' for every other change-log source", async () => {
    const bySource: Record<string, string> = {};
    for (const source of ['user', 'feedback', 'chat', 'digest', 'nudge'] as const) {
      await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: `p-${source}` }, source);
    }
    for (const s of await supRows()) bySource[s.pattern] = s.source;

    expect(bySource).toEqual({
      'p-user': 'user',
      'p-feedback': 'feedback',
      'p-chat': 'feedback',
      'p-digest': 'feedback',
      'p-nudge': 'feedback',
    });
  });

  it('only a user-owned change-log source is recorded as such on the log row', async () => {
    await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'a' }, 'user');
    await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'b' }, 'chat');

    expect((await logsOf('add_suppression')).map((r) => r.source)).toEqual(['user', 'chat']);
  });
});

describe('D12: a hard filter purges what is already stored', () => {
  const nvidia = (strength: number, source: 'user' | 'feedback' = 'user') =>
    applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'nvidia', suppressionKeywords: ['nvidia'], suppressionStrength: strength },
      source,
    );

  beforeEach(async () => {
    await seedArticles([
      { id: 'a', title: 'Nvidia ships a GPU' },
      { id: 'b', title: 'AMD ships a GPU' },
    ]);
    seedFeedOrder(['a', 'b']);
  });

  it('a HARD add excludes the matching rows, evicts exactly them from the Feed order and refreshes the For You store', async () => {
    const res = await nvidia(0.9);

    expect(res.applied).toBe(true);
    expect(Object.keys(res).sort()).toEqual(['applied', 'changeLogId', 'summary']);
    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });
    expect(useFeedOrderStore.getState().order).toEqual(['b']);
    const stored = useForYouStore.getState().suggestions;
    expect(stored.find((s) => s._id === 'a')?.status).toBe('excluded');
    expect(stored.find((s) => s._id === 'b')?.status).toBe('unscored');
  });

  it('a suppression exactly AT the hard threshold purges', async () => {
    await nvidia(0.8);

    expect((await statuses()).a).toBe('excluded');
  });

  it('a SOFT add runs no sweep: nothing excluded, the order is untouched, the store was never refreshed', async () => {
    await nvidia(0.79);

    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
    expect(useFeedOrderStore.getState().order).toEqual(['a', 'b']);
    expect(useForYouStore.getState().suggestions).toEqual([]);
  });

  it('the default strength is soft, so a bare add runs no sweep', async () => {
    await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'nvidia', suppressionKeywords: ['nvidia'] }, 'user');

    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });

  it('a sweep failure does NOT fail the action: it is committed, audited, and the failure is captured', async () => {
    failTableQuery('article_suggestions');

    const res = await nvidia(0.9);

    expect(res).toMatchObject({ applied: true, summary: 'Suppressed: nvidia' });
    expect(res.changeLogId).toBeDefined();
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'persona-mutation-sweeps', sweep: 'purge', action_type: 'add_suppression' },
    });
    restoreFaults();
    expect(await supRows()).toHaveLength(1);
    expect(await logsOf('add_suppression')).toHaveLength(1);
    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });
});

describe('retire_suppression', () => {
  it('names the pattern in the log, retires the row and returns the id', async () => {
    const s = await addSuppression({ pattern: 'celebrity gossip', strength: 0.5, source: 'user', kind: 'publication', value: 'gossip daily' });

    const res = await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: s.id }, 'user');

    expect(res).toMatchObject({ applied: true, summary: 'Removed filter: celebrity gossip' });
    expect((await supRows())[0].status).toBe('retired');
    expect((await logsOf('retire_suppression'))[0]).toMatchObject({
      id: res.changeLogId,
      action: { targetId: s.id, pattern: 'celebrity gossip', kind: 'publication' },
      summary: 'Removed filter: celebrity gossip',
    });
  });

  it('logs kind "keyword" for a pre-v46 row with a NULL kind', async () => {
    const s = await addSuppression({ pattern: 'gossip', strength: 0.5, source: 'user' });

    await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: s.id }, 'user');

    expect((await logsOf('retire_suppression'))[0].action.kind).toBe('keyword');
  });

  it('an unknown suppression is not found: nothing retired, nothing logged', async () => {
    const s = await addSuppression({ pattern: 'gossip', strength: 0.5, source: 'user' });

    const res = await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: 'ghost' }, 'user');

    expect(res).toEqual({ applied: false, summary: 'suppression not found' });
    expect((await supRows())[0]).toMatchObject({ id: s.id, status: 'active' });
    expect(await logRows()).toEqual([]);
  });

  it('retiring a HARD filter releases the rows it had excluded back to unscored', async () => {
    await seedArticles([{ id: 'a', title: 'Nvidia ships a GPU' }, { id: 'b', title: 'AMD ships a GPU' }]);
    const added = await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'nvidia', suppressionKeywords: ['nvidia'], suppressionStrength: 1 },
      'user',
    );
    expect((await statuses()).a).toBe('excluded');
    const targetId = (await logsOf('add_suppression'))[0].action.targetId as string;

    await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: targetId }, 'user');

    expect(added.applied).toBe(true);
    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });

  it('retiring a SOFT filter runs no sweep: a row excluded by another hard filter stays excluded and the store is not refreshed', async () => {
    await seedArticles([{ id: 'a', title: 'Nvidia ships a GPU' }]);
    await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'nvidia', suppressionKeywords: ['nvidia'], suppressionStrength: 1 },
      'user',
    );
    const soft = await addSuppression({ pattern: 'amd', keywords: ['amd'], strength: 0.4, source: 'user' });
    useForYouStore.setState({ suggestions: [] }); // forget the purge's refresh

    await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: soft.id }, 'user');

    expect((await statuses()).a).toBe('excluded');
    expect(useForYouStore.getState().suggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

describe('set_location_weight', () => {
  it('sets the weight clamped to [0, 1], logs the prior value, and returns the id', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home', 0.4);

    const res = await applyPersonaAction({ action_type: A.SET_LOCATION_WEIGHT, locationId: home.id, weight: 1.5 }, 'slider');

    expect(res).toMatchObject({ applied: true, summary: 'Adjusted location weight' });
    expect((await rowById('locations', home.id)).weight).toBe(1);
    expect((await logsOf('set_location_weight'))[0]).toMatchObject({
      id: res.changeLogId,
      source: 'slider',
      action: { targetId: home.id, before: 0.4, after: 1 },
      summary: 'Adjusted location weight 0.40 → 1.00',
    });
  });

  it('a negative weight is clamped up to 0', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home', 0.4);

    await applyPersonaAction({ action_type: A.SET_LOCATION_WEIGHT, locationId: home.id, weight: -3 }, 'slider');

    expect((await rowById('locations', home.id)).weight).toBe(0);
  });

  it('an unknown location is not applied and writes nothing', async () => {
    await seedPlace('NL', 'Amsterdam', 'home', 0.4);

    const res = await applyPersonaAction({ action_type: A.SET_LOCATION_WEIGHT, locationId: 'ghost', weight: 0.5 }, 'slider');

    expect(res).toEqual({ applied: false, summary: 'location not found' });
    expect(await logRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Publication and source-scope preferences
// ---------------------------------------------------------------------------

describe('set_publication_pref', () => {
  it('reads the prior kind, writes the new one and logs before/after', async () => {
    await setPreferenceKind('The Times', 'boost', 'user');

    const res = await applyPersonaAction(
      { action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'mute' },
      'feedback',
    );

    expect(res).toMatchObject({ applied: true, summary: 'Set publication preference: The Times → mute' });
    const [pref] = await prefRows();
    expect(pref).toMatchObject({ publicationName: 'The Times', weight: -1, status: 'active' });
    expect((await logsOf('set_publication_pref'))[0]).toMatchObject({
      id: res.changeLogId,
      action: { targetId: 'The Times', before: 'boost', after: 'mute' },
    });
  });

  it("records before: 'none' when there was no prior preference", async () => {
    await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'boost' }, 'user');

    expect((await logsOf('set_publication_pref'))[0].action).toEqual({ targetId: 'The Times', before: 'none', after: 'boost' });
    expect((await prefRows())[0].weight).toBe(0.5);
  });

  it.each([
    ['user', 'user'],
    ['migration', 'migration'],
    ['feedback', 'feedback'],
    ['chat', 'feedback'],
    ['slider', 'feedback'],
    ['digest', 'feedback'],
  ] as const)('change-log source %s writes provenance %s', async (source, provenance) => {
    await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'boost' }, source);

    expect((await prefRows())[0].provenance).toBe(provenance);
  });

  describe('a mute is a hard filter (D12b)', () => {
    beforeEach(async () => {
      await seedArticles([
        { id: 'a', title: 'Budget day', publication: 'The Times' },
        { id: 'b', title: 'Budget day', publication: 'The Sun' },
      ]);
    });
    const pref = (publicationPref: 'boost' | 'deprioritize' | 'mute') =>
      applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref }, 'user');

    it('muting purges that publication, and only that one', async () => {
      await pref('mute');

      expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });
    });

    it('un-muting (boost over a mute) releases the rows the mute had excluded', async () => {
      await pref('mute');

      await pref('boost');

      expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
    });

    it('a non-mute change runs neither sweep: the store is never refreshed', async () => {
      await pref('deprioritize');
      await pref('boost');

      expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
      expect(useForYouStore.getState().suggestions).toEqual([]);
    });
  });
});

describe('set_source_scope_pref', () => {
  const scope = (over: Record<string, unknown> = {}) =>
    ({ action_type: A.SET_SOURCE_SCOPE_PREF, scopeKind: 'country', scopeValue: 'IND', scopeLabel: 'India', publicationPref: 'boost', ...over }) as never;

  it("creates the scope row from 'none', logging the composite targetId and the label", async () => {
    const res = await applyPersonaAction(scope(), 'chat');

    expect(res).toMatchObject({ applied: true, summary: 'Set source preference: India → boost' });
    const [row] = await prefRows();
    expect(row).toMatchObject({ scopeKind: 'country', scopeValue: 'IND', publicationName: 'India', weight: 0.5, status: 'active', provenance: 'feedback' });
    expect((await logsOf('set_source_scope_pref'))[0]).toMatchObject({
      id: res.changeLogId,
      action: { targetId: 'country:IND', before: 'none', after: 'boost', label: 'India' },
      summary: 'Set source preference: India → boost',
    });
  });

  it('falls back to the scope value as its label when none is given', async () => {
    const res = await applyPersonaAction(scope({ scopeLabel: undefined }), 'chat');

    expect(res.summary).toBe('Set source preference: IND → boost');
    expect((await prefRows())[0].publicationName).toBe('IND');
  });

  it('a mute is refused (nothing implements a scope exclusion): no row, no log', async () => {
    const res = await applyPersonaAction(scope({ publicationPref: 'mute' }), 'chat');

    expect(res.applied).toBe(false);
    expect(res.summary).toContain('cannot be muted');
    expect(await prefRows()).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it('never collides with a NAMED publication that shares the label', async () => {
    await setPreferenceKind('India', 'deprioritize', 'user');

    await applyPersonaAction(scope(), 'chat');

    const rows = await prefRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.scopeKind == null)).toMatchObject({ publicationName: 'India', weight: -0.5 });
    expect(rows.find((p) => p.scopeKind === 'country')).toMatchObject({ scopeValue: 'IND', weight: 0.5 });
  });

  it('a scope preference never purges anything', async () => {
    await seedArticles([{ id: 'a', title: 'x', publication: 'India' }]);

    await applyPersonaAction(scope({ publicationPref: 'deprioritize' }), 'chat');

    expect(await statuses()).toEqual({ a: 'unscored' });
  });
});
