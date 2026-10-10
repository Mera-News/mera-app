// persona-change-log-service: the audit log and `revertChange`, on the real in-memory DB.
// Every mutation is applied through the real executor / rails, then undone by its change-log id: the
// persona rows must be back where they were, the row marked reverted, a `revert_change` row appended,
// and the MIRROR sweep must have restored (or re-applied) what the mutation swept (D12).
// Replaces the mocked persona-action-executor-{nudge,pubpref,scopepref,suppression}-revert suites and
// pubpref-undo-compare-and-set.
import { firstValueFrom } from 'rxjs';
import database from '@/lib/database';
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-service';
import { applyPersonaAction, type PersonaAction } from '@/lib/database/services/persona-action-executor';
import {
  append,
  getById,
  getChangeTargets,
  getRecent,
  observeRecent,
  revertChange,
} from '@/lib/database/services/persona-change-log-service';
import { retirePreference, setPreferenceKind, upsertScopePreference } from '@/lib/database/services/publication-preference-service';
import { addSuppression, getActive as activeSuppressions, getAll as allSuppressions } from '@/lib/database/services/suppression-service';
import { suppress } from '@/lib/database/services/topic-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  DAY,
  MIN,
  NOON,
  freezeClock,
  failTableQuery,
  logRow,
  logRows,
  logsOf,
  quietLogger,
  resetPersonaMemory,
  restoreFaults,
  rowById,
  rowsOf,
  seedArticles,
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

/** The row is marked reverted and a `revert_change` audit row names it. */
async function expectReverted(changeLogId: string | undefined) {
  expect(changeLogId).toBeDefined();
  const row = await logRow(changeLogId!);
  expect(row.reverted).toBe(true);
  const audit = (await logsOf('revert_change')).find((r) => r.action.targetId === changeLogId);
  expect(audit).toMatchObject({
    source: 'user',
    action: { targetId: changeLogId, revertedActionType: row.actionType },
    summary: `Reverted: ${row.summary}`,
    reverted: false,
  });
}

const hardNvidia: PersonaAction = {
  action_type: A.ADD_SUPPRESSION,
  suppressionPattern: 'nvidia',
  suppressionKeywords: ['nvidia'],
  suppressionStrength: 0.9,
};

// ---------------------------------------------------------------------------
// The log itself
// ---------------------------------------------------------------------------

describe('append / getById / getRecent / observeRecent', () => {
  it('append writes an un-reverted row with the serialised action and returns the model', async () => {
    freezeClock(NOON);

    const row = await append({ actionType: 'set_topic_weight', action: { targetId: 't1', before: 0.2, after: 0.4 }, source: 'nudge', summary: 'S' });

    expect(row.reverted).toBe(false);
    expect(row.createdAt.getTime()).toBe(NOON);
    expect(await logRow(row.id)).toEqual({
      id: row.id,
      actionType: 'set_topic_weight',
      action: { targetId: 't1', before: 0.2, after: 0.4 },
      source: 'nudge',
      summary: 'S',
      reverted: false,
    });
  });

  it('getById finds a row and rejects for an unknown id', async () => {
    const row = await append({ actionType: 'add_topic', action: {}, source: 'chat', summary: 'x' });

    expect((await getById(row.id)).summary).toBe('x');
    await expect(getById('ghost')).rejects.toThrow();
  });

  it('[dead-candidate] getRecent and observeRecent list newest first and honour the limit', async () => {
    freezeClock(NOON);
    for (const [i, name] of ['first', 'second', 'third'].entries()) {
      jest.setSystemTime(NOON + i * MIN);
      await append({ actionType: 'add_topic', action: {}, source: 'chat', summary: name });
    }

    expect((await getRecent()).map((r) => r.summary)).toEqual(['third', 'second', 'first']);
    expect((await getRecent(2)).map((r) => r.summary)).toEqual(['third', 'second']);
    expect((await firstValueFrom(observeRecent(2))).map((r) => r.summary)).toEqual(['third', 'second']);
  });

  it('observeRecent emits again when a row is appended', async () => {
    const seen: string[][] = [];
    const sub = observeRecent().subscribe((rows) => seen.push(rows.map((r) => r.summary)));
    await append({ actionType: 'add_topic', action: {}, source: 'chat', summary: 'late' });
    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
    sub.unsubscribe();

    expect(seen[0]).toEqual([]);
    expect(seen[seen.length - 1]).toEqual(['late']);
  });
});

describe('getChangeTargets', () => {
  it('resolves topics, facts, filters and places by id, in one map', async () => {
    const { fact, topics } = await seedInterest('Lives in Amsterdam', ['amsterdam']);
    const filter = await addSuppression({ pattern: 'gossip', strength: 0.5, source: 'user' });
    const place = await seedPlace('NL', 'Amsterdam');
    const noCity = await seedPlace('DE', null, 'work');

    const targets = await getChangeTargets([topics[0].id, fact.id, filter.id, place.id, noCity.id]);

    expect(targets.get(topics[0].id)).toEqual({ text: 'amsterdam' });
    expect(targets.get(fact.id)).toEqual({ text: 'Lives in Amsterdam' });
    expect(targets.get(filter.id)).toEqual({ text: 'gossip' });
    expect(targets.get(place.id)).toEqual({ city: 'Amsterdam', countryCode: 'NL' });
    expect(targets.get(noCity.id)).toEqual({ city: null, countryCode: 'DE' });
    expect(targets.size).toBe(5);
  });

  it('retired topics and filters still resolve; a deleted fact does not; duplicates and blanks are ignored', async () => {
    const { fact, topics } = await seedInterest('Lives in Amsterdam', ['amsterdam']);
    const filter = await addSuppression({ pattern: 'gossip', strength: 0.5, source: 'user' });
    await applyPersonaAction({ action_type: A.RETIRE_TOPIC, topicId: topics[0].id }, 'user');
    await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: filter.id }, 'user');
    const other = await seedInterest('Likes tea', ['tea']);
    await applyPersonaAction({ action_type: A.DISCARD_FACT, factId: other.fact.id }, 'user');

    const targets = await getChangeTargets([topics[0].id, topics[0].id, filter.id, other.fact.id, '', 'ghost']);

    expect([...targets.keys()].sort()).toEqual([topics[0].id, filter.id].sort());
    expect(targets.get(topics[0].id)).toEqual({ text: 'amsterdam' });
    expect(fact.id).toBeDefined();
  });

  it('an empty or all-blank id list returns an empty map', async () => {
    expect((await getChangeTargets([])).size).toBe(0);
    expect((await getChangeTargets(['', ''])).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Revert: each revertible action is undone exactly
// ---------------------------------------------------------------------------

describe('weights', () => {
  it('a topic nudge un-votes: the weight returns and the audit row names it', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    const res = await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: -0.15 }, 'feedback');
    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.35);

    await expect(revertChange(res.changeLogId!)).resolves.toBe(true);

    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.5);
    await expectReverted(res.changeLogId);
  });

  it('an absolute topic weight is restored to its prior value', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    const res = await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, weight: -1 }, 'user');

    await revertChange(res.changeLogId!);

    expect((await rowById('topics', topics[0].id)).weight).toBe(0.5);
  });

  it('a pin round-trips back off', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);
    const res = await applyPersonaAction({ action_type: A.SET_HIGH_PRIORITY, topicId: topics[0].id, highPriority: true }, 'feedback');
    expect((await rowById('topics', topics[0].id)).highPriority).toBe(true);

    await revertChange(res.changeLogId!);

    expect((await rowById('topics', topics[0].id)).highPriority).toBe(false);
    await expectReverted(res.changeLogId);
  });

  it('a fact weight returns to its prior value, and to NULL when it had none', async () => {
    const { fact } = await seedInterest('I follow F1', ['formula 1']);
    const first = await applyPersonaAction({ action_type: A.SET_FACT_WEIGHT, factId: fact.id, delta: -0.2 }, 'feedback'); // null -> 0.8
    const second = await applyPersonaAction({ action_type: A.SET_FACT_WEIGHT, factId: fact.id, delta: -0.2 }, 'feedback'); // 0.8 -> 0.6
    expect((await rowById('facts', fact.id)).weight).toBeCloseTo(0.6);

    await revertChange(second.changeLogId!);
    expect((await rowById('facts', fact.id)).weight).toBeCloseTo(0.8);
    await revertChange(first.changeLogId!);

    expect((await rowById('facts', fact.id)).weight).toBeNull();
  });

  it('a location weight returns to its prior value', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home', 0.4);
    const res = await applyPersonaAction({ action_type: A.SET_LOCATION_WEIGHT, locationId: home.id, weight: 1 }, 'slider');

    await revertChange(res.changeLogId!);

    expect((await rowById('locations', home.id)).weight).toBe(0.4);
    await expectReverted(res.changeLogId);
  });

  it('weights revert unconditionally: undoing an older nudge overwrites a newer one (only source preferences are compare-and-set)', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    const older = await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: -0.1 }, 'feedback');
    await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: -0.1 }, 'feedback');

    await expect(revertChange(older.changeLogId!)).resolves.toBe(true);

    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.5);
  });
});

describe('topics', () => {
  it('add_topic and add_negative_topic are undone by retiring the minted topic (the row stays)', async () => {
    const pos = await applyPersonaAction({ action_type: A.ADD_TOPIC, topicText: 'formula 1' }, 'chat');
    const neg = await applyPersonaAction({ action_type: A.ADD_NEGATIVE_TOPIC, topicText: 'cricket' }, 'chat');

    await revertChange(pos.changeLogId!);
    await revertChange(neg.changeLogId!);

    const byText = Object.fromEntries((await rowsOf('topics')).map((t) => [t.text, t.status]));
    expect(byText).toEqual({ 'formula 1': 'retired', cricket: 'retired' });
    await expectReverted(pos.changeLogId);
    await expectReverted(neg.changeLogId);
  });

  it('retire_topic is undone by reactivating it', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);
    const res = await applyPersonaAction({ action_type: A.RETIRE_TOPIC, topicId: topics[0].id }, 'user');

    await revertChange(res.changeLogId!);

    expect((await rowById('topics', topics[0].id)).status).toBe('active');
  });

  it('retire_topic revert brings a once-suppressed topic back ACTIVE, weight untouched (accepted drift)', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: -0.7 }]);
    await suppress(topics[0].id);
    const res = await applyPersonaAction({ action_type: A.RETIRE_TOPIC, topicId: topics[0].id }, 'user');

    await revertChange(res.changeLogId!);

    expect(await rowById('topics', topics[0].id)).toMatchObject({ status: 'active', weight: -0.7 });
  });

  // DATA-U11-1. createTopics returns the EXISTING row when the same text is minted twice (no fact), so two
  // verdicts that each minted "cricket" log two rows pointing at ONE topic. Each add's inverse retires it.
  describe('the same negative topic minted by two verdicts', () => {
    const mint = () => applyPersonaAction({ action_type: A.ADD_NEGATIVE_TOPIC, topicText: 'cricket' }, 'feedback');

    it('the topic stays live until BOTH mints are undone', async () => {
      const first = await mint();
      const second = await mint();

      await revertChange(second.changeLogId!);

      expect((await rowsOf('topics'))[0].status).toBe('active');
      expect(first.changeLogId).toBeDefined();
    });
  });

  it('suppress_topic (forward-compat) is undone by reactivating the topic', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);
    await suppress(topics[0].id);
    const row = await append({ actionType: A.SUPPRESS_TOPIC, action: { targetId: topics[0].id }, source: 'user', summary: 'Suppressed topic' });

    await revertChange(row.id);

    expect((await rowById('topics', topics[0].id)).status).toBe('active');
  });
});

describe('suppressions', () => {
  it('undoing an add retires the filter', async () => {
    const res = await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'gossip' }, 'user');

    await revertChange(res.changeLogId!);

    expect((await allSuppressions())[0].status).toBe('retired');
    await expectReverted(res.changeLogId);
  });

  it('undoing a removal reactivates a HARD structured filter, in force again', async () => {
    const added = await applyPersonaAction(
      { action_type: A.ADD_SUPPRESSION, suppressionPattern: 'Daily Blether', suppressionKind: 'publication', suppressionValue: 'Daily Blether', suppressionStrength: 0.9 },
      'user',
    );
    const stored = (await allSuppressions())[0];
    const removed = await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: stored.id }, 'user');
    expect((await allSuppressions())[0].status).toBe('retired');

    await revertChange(removed.changeLogId!);

    expect((await allSuppressions())[0]).toMatchObject({ status: 'active', kind: 'publication', value: 'Daily Blether' });
    expect(await activeSuppressions()).toHaveLength(1);
    expect(added.applied).toBe(true);
    await expectReverted(removed.changeLogId);
  });

  it('undoing the removal of a SOFT filter keeps its ORIGINAL expiry: still-live comes back live', async () => {
    freezeClock(NOON);
    await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'celebrity gossip', suppressionKeywords: ['celebrity', 'gossip'] }, 'feedback');
    const stored = (await allSuppressions())[0];
    const removed = await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: stored.id }, 'user');
    jest.setSystemTime(NOON + 29 * DAY);

    await revertChange(removed.changeLogId!);

    const [after] = await allSuppressions();
    expect(after).toMatchObject({ status: 'active', expiresAt: NOON + 30 * DAY });
    expect(await activeSuppressions()).toHaveLength(1);
  });

  it('undoing the removal of a long-expired SOFT filter is inert: active, but not 30 days longer', async () => {
    freezeClock(NOON);
    await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'celebrity gossip', suppressionKeywords: ['celebrity'] }, 'feedback');
    const stored = (await allSuppressions())[0];
    const removed = await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: stored.id }, 'user');
    jest.setSystemTime(NOON + 30 * DAY + 1); // one ms past the expiry

    await revertChange(removed.changeLogId!);

    expect((await allSuppressions())[0]).toMatchObject({ status: 'active', expiresAt: NOON + 30 * DAY });
    expect(await activeSuppressions()).toEqual([]);
  });
});

describe('publication preferences', () => {
  it('mute over a prior boost: undo restores the boost weight', async () => {
    await setPreferenceKind('The Times', 'boost', 'user');
    const res = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'mute' }, 'feedback');
    expect((await rowsOf('publication_preferences'))[0].weight).toBe(-1);

    await expect(revertChange(res.changeLogId!)).resolves.toBe(true);

    expect((await rowsOf('publication_preferences'))[0]).toMatchObject({ weight: 0.5, status: 'active' });
    await expectReverted(res.changeLogId);
  });

  it("boost from 'none': undo retires the preference", async () => {
    const res = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'boost' }, 'feedback');

    await revertChange(res.changeLogId!);

    expect((await rowsOf('publication_preferences'))[0].status).toBe('retired');
  });

  it('a stale undo never clobbers a newer change (compare-and-set), and leaves no trace', async () => {
    const fewer = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'IT Pro', publicationPref: 'deprioritize' }, 'user');
    const boost = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'IT Pro', publicationPref: 'boost' }, 'feedback');
    const rowsBefore = (await logRows()).length;

    await expect(revertChange(fewer.changeLogId!)).resolves.toBe(false);

    expect((await rowsOf('publication_preferences'))[0].weight).toBe(0.5);
    expect((await logRow(fewer.changeLogId!)).reverted).toBe(false);
    expect((await logRows()).length).toBe(rowsBefore);

    await expect(revertChange(boost.changeLogId!)).resolves.toBe(true);
    expect((await rowsOf('publication_preferences'))[0].weight).toBe(-0.5);
    await expect(revertChange(boost.changeLogId!)).resolves.toBe(false);
    expect((await rowsOf('publication_preferences'))[0].weight).toBe(-0.5);
  });

  it('a single undo still restores the prior value', async () => {
    const res = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'AD.nl', publicationPref: 'deprioritize' }, 'user');

    await expect(revertChange(res.changeLogId!)).resolves.toBe(true);

    expect((await rowsOf('publication_preferences'))[0].status).toBe('retired');
  });

  it('a row that never recorded an `after` reverts unconditionally', async () => {
    await setPreferenceKind('IT Pro', 'boost', 'user');
    const row = await append({ actionType: A.SET_PUBLICATION_PREF, action: { targetId: 'IT Pro', before: 'deprioritize' }, source: 'migration', summary: 'old shape' });

    await expect(revertChange(row.id)).resolves.toBe(true);

    expect((await rowsOf('publication_preferences'))[0]).toMatchObject({ weight: -0.5, status: 'active' });
  });
});

describe('source scope preferences', () => {
  const scope = (value: string, label: string, publicationPref: 'boost' | 'deprioritize') =>
    applyPersonaAction({ action_type: A.SET_SOURCE_SCOPE_PREF, scopeKind: 'country', scopeValue: value, scopeLabel: label, publicationPref }, 'chat');

  it("undoing a create retires the scope row (prior 'none')", async () => {
    const res = await scope('IND', 'India', 'boost');

    await expect(revertChange(res.changeLogId!)).resolves.toBe(true);

    expect((await rowsOf('publication_preferences'))[0]).toMatchObject({ scopeValue: 'IND', status: 'retired' });
    await expectReverted(res.changeLogId);
  });

  it('undoing a change restores the PRIOR kind, active, under its label', async () => {
    await scope('DEU', 'Germany', 'boost');
    const second = await scope('DEU', 'Germany', 'deprioritize');
    expect((await rowsOf('publication_preferences'))[0].weight).toBe(-0.5);

    await revertChange(second.changeLogId!);

    expect((await rowsOf('publication_preferences'))[0]).toMatchObject({ weight: 0.5, status: 'active', publicationName: 'Germany' });
  });

  it('a scope follows compare-and-set too: the older undo is refused after a newer change', async () => {
    const first = await scope('NLD', 'Netherlands', 'boost');
    await scope('NLD', 'Netherlands', 'deprioritize');

    await expect(revertChange(first.changeLogId!)).resolves.toBe(false);

    expect((await rowsOf('publication_preferences'))[0].weight).toBe(-0.5);
    expect((await logRow(first.changeLogId!)).reverted).toBe(false);
  });

  it('reverts a row written by the Source-preferences screen, which logs no label', async () => {
    await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'India', weight: -0.5, provenance: 'user' });
    const row = await append({
      actionType: A.SET_SOURCE_SCOPE_PREF,
      action: { targetId: 'country:IND', before: 'boost', after: 'deprioritize' },
      source: 'user',
      summary: 'Set source preference: India → deprioritize',
    });

    await revertChange(row.id);

    expect((await rowsOf('publication_preferences'))[0]).toMatchObject({ weight: 0.5, status: 'active', publicationName: 'India' });
  });

  it("recovers the display label from the retired row when the screen's 'clear' log has none", async () => {
    const pref = await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'India', weight: 0.5, provenance: 'user' });
    await retirePreference(pref.id); // the screen's clear: row retired, log written by hand without a label
    const row = await append({
      actionType: A.SET_SOURCE_SCOPE_PREF,
      action: { targetId: 'country:IND', before: 'boost', after: 'none' },
      source: 'user',
      summary: 'Cleared source-scope preference: India',
    });

    await revertChange(row.id);

    expect((await rowsOf('publication_preferences'))[0]).toMatchObject({ status: 'active', weight: 0.5, publicationName: 'India' });
  });
});

// ---------------------------------------------------------------------------
// Revert refusals and idempotence
// ---------------------------------------------------------------------------

describe('revertChange refusals', () => {
  it('a second revert is a no-op: false, nothing written, nothing audited twice', async () => {
    const { topics } = await seedInterest('I follow F1', ['formula 1']);
    const res = await applyPersonaAction({ action_type: A.RETIRE_TOPIC, topicId: topics[0].id }, 'user');
    await revertChange(res.changeLogId!);
    const rows = (await logRows()).length;

    await expect(revertChange(res.changeLogId!)).resolves.toBe(false);

    expect((await logRows()).length).toBe(rows);
    expect(await logsOf('revert_change')).toHaveLength(1);
  });

  it('an unknown change-log id rejects', async () => {
    await expect(revertChange('ghost')).rejects.toThrow();
  });

  it.each([
    ['discard_fact'], ['add_location'], ['delete_location'], ['hygiene_delete_fact'], ['merge_facts'], ['revert_change'], ['from_the_future'],
  ])('%s has no inverse: it throws, the row stays un-reverted and nothing is audited', async (actionType) => {
    const row = await append({ actionType, action: { targetId: 'x' }, source: 'user', summary: 'n/a' });

    await expect(revertChange(row.id)).rejects.toThrow(`no inverse implemented for action_type '${actionType}'`);

    expect((await logRow(row.id)).reverted).toBe(false);
    expect((await logRows()).map((r) => r.id)).toEqual([row.id]); // no revert_change audit row appeared
  });

  it('an unparseable action_json throws', async () => {
    const row = await append({ actionType: A.ADD_TOPIC, action: {}, source: 'user', summary: 'x' });
    const model = await getById(row.id);
    await database.write(() =>
      model.update((r) => {
        r.actionJson = '{not json';
      }),
    );

    await expect(revertChange(row.id)).rejects.toThrow('unparseable action_json');
    expect((await getById(row.id)).reverted).toBe(false);
  });

  it.each([
    [A.SET_TOPIC_WEIGHT, { before: 0.5 }, 'no targetId'],
    [A.SET_TOPIC_WEIGHT, { targetId: 't', before: 'x' }, "no numeric 'before'"],
    [A.SET_LOCATION_WEIGHT, { targetId: 't' }, "no numeric 'before'"],
    [A.SET_HIGH_PRIORITY, { targetId: 't', before: 1 }, "no boolean 'before'"],
    [A.SET_FACT_WEIGHT, { targetId: 't', before: 'heavy' }, "'before' must be number|null"],
    [A.ADD_TOPIC, {}, 'no targetId'],
    [A.SET_PUBLICATION_PREF, { targetId: 'The Times', before: 'loud' }, 'publication pref kind for set_publication_pref'],
    [A.SET_SOURCE_SCOPE_PREF, { targetId: 'IND', before: 'none' }, "targetId must be '{scopeKind}:{scopeValue}'"],
    [A.SET_SOURCE_SCOPE_PREF, { targetId: 'city:IND', before: 'none' }, "targetId must be '{scopeKind}:{scopeValue}'"],
    [A.SET_SOURCE_SCOPE_PREF, { targetId: 'country:', before: 'none' }, "targetId must be '{scopeKind}:{scopeValue}'"],
    [A.SET_SOURCE_SCOPE_PREF, { targetId: 'country:IND', before: 'loud' }, 'publication pref kind for set_source_scope_pref'],
  ] as const)('a %s row with a malformed payload %j is refused (%s) and changes nothing', async (actionType, action, message) => {
    const row = await append({ actionType, action: { ...action }, source: 'user', summary: 'bad' });

    await expect(revertChange(row.id)).rejects.toThrow(message);

    expect((await logRow(row.id)).reverted).toBe(false);
    expect(await logsOf('revert_change')).toEqual([]);
    expect(await rowsOf('publication_preferences')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D12: the revert owes the feed the MIRROR sweep
// ---------------------------------------------------------------------------

describe('revert runs the mirror sweep', () => {
  beforeEach(async () => {
    await seedArticles([
      { id: 'a', title: 'Nvidia ships a GPU', publication: 'The Times' },
      { id: 'b', title: 'AMD ships a GPU', publication: 'The Sun' },
    ]);
  });

  it('reverting a HARD add releases the rows the add had purged', async () => {
    const added = await applyPersonaAction({ ...hardNvidia }, 'user');
    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });

    await revertChange(added.changeLogId!);

    expect((await allSuppressions())[0].status).toBe('retired');
    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
    expect(useForYouStore.getState().suggestions.find((s) => s._id === 'a')?.status).toBe('unscored');
  });

  it('reverting the REMOVAL of a hard filter re-purges what it blocks', async () => {
    await applyPersonaAction({ ...hardNvidia }, 'user');
    const filterId = (await allSuppressions())[0].id;
    const removed = await applyPersonaAction({ action_type: A.RETIRE_SUPPRESSION, suppressionId: filterId }, 'user');
    expect((await statuses()).a).toBe('unscored');

    await revertChange(removed.changeLogId!);

    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });
  });

  it('reverting a SOFT add runs no sweep: a stale excluded row is left alone', async () => {
    await batchMarkExcluded(['b']); // excluded, with no active filter to justify it
    const soft = await applyPersonaAction({ action_type: A.ADD_SUPPRESSION, suppressionPattern: 'gossip' }, 'user');

    await revertChange(soft.changeLogId!);

    expect((await statuses()).b).toBe('excluded');
  });

  it('reverting a topic mutation runs no sweep', async () => {
    await batchMarkExcluded(['b']);
    const { topics } = await seedInterest('I follow F1', ['formula 1']);
    const retired = await applyPersonaAction({ action_type: A.RETIRE_TOPIC, topicId: topics[0].id }, 'user');

    await revertChange(retired.changeLogId!);

    expect((await rowById('topics', topics[0].id)).status).toBe('active');
    expect((await statuses()).b).toBe('excluded');
  });

  it('reverting a mute releases the publication; reverting an un-mute purges it again', async () => {
    const mute = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'mute' }, 'user');
    expect((await statuses()).a).toBe('excluded');
    await revertChange(mute.changeLogId!);
    expect((await statuses()).a).toBe('unscored');

    await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'mute' }, 'user');
    const unmute = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'boost' }, 'user');
    expect((await statuses()).a).toBe('unscored');

    await revertChange(unmute.changeLogId!);

    expect((await statuses()).a).toBe('excluded');
  });

  it('a stale undo that is refused by compare-and-set sweeps nothing', async () => {
    const mute = await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'mute' }, 'user');
    await applyPersonaAction({ action_type: A.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'boost' }, 'user');
    await batchMarkExcluded(['b']);

    await expect(revertChange(mute.changeLogId!)).resolves.toBe(false);

    expect((await statuses()).b).toBe('excluded');
  });

  it('a sweep failure never fails the revert: it is committed, audited, and the failure is captured', async () => {
    const added = await applyPersonaAction({ ...hardNvidia }, 'user');
    failTableQuery('article_suggestions');

    await expect(revertChange(added.changeLogId!)).resolves.toBe(true);

    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'persona-mutation-sweeps', sweep: 'unexclude', action_type: 'add_suppression' },
    });
    restoreFaults();
    expect((await allSuppressions())[0].status).toBe('retired');
    expect((await logRow(added.changeLogId!)).reverted).toBe(true);
    expect(await logsOf('revert_change')).toHaveLength(1);
    expect((await statuses()).a).toBe('excluded'); // the release failed; the next scoring pass applies the retirement
  });
});
