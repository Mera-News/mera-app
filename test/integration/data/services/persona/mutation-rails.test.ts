// mutation-rails-service: the bounded persona mutations (nudge under a per-topic per-day budget,
// absolute set, pin, fact nudge), on the real DB. The budget query is a real `Q.where` now, so the day
// window (local midnight), the per-topic scope and which log rows count are all under test.
import database from '@/lib/database';
import { nudgeFactWeight, nudgeTopic, setTopicHighPriority, setTopicWeightAbsolute } from '@/lib/database/services/mutation-rails-service';
import { append } from '@/lib/database/services/persona-change-log-service';
import {
  DAY,
  NOON,
  freezeClock,
  logRows,
  logsOf,
  quietLogger,
  resetPersonaMemory,
  restoreFaults,
  rowById,
  seedInterest,
  settleWrites,
} from './support';

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

const topicWith = async (weight: number, text = 'formula 1') => (await seedInterest(`I follow ${text}`, [{ text, weight }])).topics[0];
const weightOf = async (id: string) => (await rowById('topics', id)).weight as number;
/** Local midnight of the strict clock's day: the budget window boundary. */
const MIDNIGHT = new Date(2026, 9, 9).getTime();

describe('nudgeTopic', () => {
  it('moves the weight, appends one invertible row and returns its id', async () => {
    const topic = await topicWith(0.5);

    const res = await nudgeTopic(topic.id, 0.123, 'feedback');

    expect(res.applied).toBe(true);
    expect(res.after).toBeCloseTo(0.623);
    expect(await weightOf(topic.id)).toBeCloseTo(0.623);
    const [row] = await logsOf('set_topic_weight');
    expect(res.changeLogId).toBe(row.id);
    expect(row).toMatchObject({ source: 'feedback', summary: 'Adjusted topic weight 0.50 → 0.62' }); // 2-dp labels
    expect(row.action).toMatchObject({ targetId: topic.id, before: 0.5 });
    expect(row.action.delta as number).toBeCloseTo(0.123);
  });

  it('clamps at +1 and -1 and logs only the delta that actually applied', async () => {
    const high = await topicWith(0.9, 'high');
    const low = await topicWith(-0.95, 'low');

    const up = await nudgeTopic(high.id, 0.25, 'feedback');
    const down = await nudgeTopic(low.id, -0.2, 'feedback');

    expect(up.after).toBe(1);
    expect(down.after).toBe(-1);
    const rows = await logsOf('set_topic_weight');
    expect(rows.find((r) => r.action.targetId === high.id)!.action.delta as number).toBeCloseTo(0.1);
    expect(rows.find((r) => r.action.targetId === low.id)!.action.delta as number).toBeCloseTo(-0.05);
  });

  it('a nudge that cannot move the weight (already at the bound) writes nothing and burns no budget', async () => {
    const topic = await topicWith(1);

    const res = await nudgeTopic(topic.id, 0.2, 'feedback');

    expect(res).toEqual({ applied: false, after: 1 });
    expect(await logRows()).toEqual([]);
    const reverse = await nudgeTopic(topic.id, -0.3, 'feedback'); // full budget still available
    expect(reverse.applied).toBe(true);
    expect(reverse.after).toBeCloseTo(0.7);
  });

  it('shrinks a delta to the remaining day budget (0.3) and refuses once it is spent', async () => {
    const topic = await topicWith(0);

    const first = await nudgeTopic(topic.id, 0.2, 'feedback');
    const second = await nudgeTopic(topic.id, 0.2, 'feedback');
    const third = await nudgeTopic(topic.id, 0.2, 'feedback');

    expect(first.after).toBeCloseTo(0.2);
    expect(second.after).toBeCloseTo(0.3); // only 0.1 of the 0.2 fits
    expect(third).toEqual({ applied: false, after: second.after });
    expect(await logsOf('set_topic_weight')).toHaveLength(2);
    expect((await logsOf('set_topic_weight'))[1].action.delta as number).toBeCloseTo(0.1);
  });

  it('the budget counts the absolute value: nudging down spends it too', async () => {
    const topic = await topicWith(0);
    await nudgeTopic(topic.id, -0.2, 'feedback');

    const res = await nudgeTopic(topic.id, 0.2, 'feedback');

    expect(res.after).toBeCloseTo(-0.1); // 0.1 left, applied upward
  });

  it('the budget is per topic', async () => {
    const a = await topicWith(0, 'alpha');
    const b = await topicWith(0, 'beta');
    await nudgeTopic(a.id, 0.3, 'feedback');

    const res = await nudgeTopic(b.id, 0.3, 'feedback');

    expect(res.applied).toBe(true);
    expect(await weightOf(b.id)).toBeCloseTo(0.3);
  });

  it('only delta-carrying set_topic_weight rows for THIS topic count against it', async () => {
    const topic = await topicWith(0);
    const noise = (actionType: string, action: Record<string, unknown>) =>
      append({ actionType, action, source: 'feedback', summary: 'noise' });
    await noise('set_topic_weight', { targetId: topic.id, before: 0, after: 0.9 }); // an absolute set: no delta
    await noise('set_fact_weight', { targetId: topic.id, delta: 0.3 }); // another action type
    await noise('set_topic_weight', { targetId: 'someone-else', delta: 0.3 }); // another topic
    await noise('revert_change', { targetId: topic.id, delta: 0.3 });

    const res = await nudgeTopic(topic.id, 0.3, 'feedback');

    expect(res.applied).toBe(true);
    expect(res.after).toBeCloseTo(0.3);
  });

  it('a corrupt log row is ignored rather than breaking the budget', async () => {
    const topic = await topicWith(0);
    const bad = await append({ actionType: 'set_topic_weight', action: {}, source: 'feedback', summary: 'bad' });
    const model = await database.get<any>('persona_change_log').find(bad.id);
    await database.write(() =>
      model.update((r: any) => {
        r.actionJson = '{broken';
      }),
    );

    const res = await nudgeTopic(topic.id, 0.3, 'feedback');

    expect(res.applied).toBe(true);
  });

  it('the day window is local midnight: yesterday 23:59:59.999 is free, midnight sharp counts', async () => {
    const topic = await topicWith(0);
    freezeClock(MIDNIGHT - 1);
    await nudgeTopic(topic.id, 0.3, 'feedback'); // spends YESTERDAY'S budget

    jest.setSystemTime(MIDNIGHT);
    const today = await nudgeTopic(topic.id, 0.3, 'feedback');
    jest.setSystemTime(MIDNIGHT + 1);
    const again = await nudgeTopic(topic.id, 0.3, 'feedback');

    expect(today.applied).toBe(true);
    expect(today.after).toBeCloseTo(0.6);
    expect(again.applied).toBe(false);
  });

  it('a whole day later the budget is fresh', async () => {
    const topic = await topicWith(0);
    freezeClock(NOON);
    await nudgeTopic(topic.id, 0.3, 'feedback');
    expect((await nudgeTopic(topic.id, 0.1, 'feedback')).applied).toBe(false);

    jest.setSystemTime(NOON + DAY);

    expect((await nudgeTopic(topic.id, 0.1, 'feedback')).applied).toBe(true);
  });

  it('an unknown topic rejects without a row', async () => {
    await expect(nudgeTopic('ghost', 0.1, 'feedback')).rejects.toThrow();
    expect(await logRows()).toEqual([]);
  });
});

describe('setTopicWeightAbsolute', () => {
  it('sets, clamps to [-1, 1], and logs before/after without a delta', async () => {
    const topic = await topicWith(0.5);

    const up = await setTopicWeightAbsolute(topic.id, 4, 'user');
    const down = await setTopicWeightAbsolute(topic.id, -4, 'user');

    expect(up).toMatchObject({ applied: true, before: 0.5, after: 1 });
    expect(down).toMatchObject({ applied: true, before: 1, after: -1 });
    const rows = await logsOf('set_topic_weight');
    expect(rows.map((r) => r.id)).toEqual([up.changeLogId, down.changeLogId]);
    expect(rows[0].action).toEqual({ targetId: topic.id, before: 0.5, after: 1 });
    expect(rows[0].summary).toBe('Set topic weight 0.50 → 1.00');
    expect(await weightOf(topic.id)).toBe(-1);
  });

  it('NaN is treated as 0', async () => {
    const topic = await topicWith(0.5);

    const res = await setTopicWeightAbsolute(topic.id, Number.NaN, 'user');

    expect(res).toMatchObject({ applied: true, after: 0 });
    expect(await weightOf(topic.id)).toBe(0);
  });

  it('setting the weight it already has is a no-op: applied:false, no id, no row', async () => {
    const topic = await topicWith(0.5);

    const res = await setTopicWeightAbsolute(topic.id, 0.5, 'user');

    expect(res).toEqual({ applied: false, before: 0.5, after: 0.5 });
    expect(await logRows()).toEqual([]);
  });

  it('has no day budget, and spends none: the nudge budget is untouched by it', async () => {
    const topic = await topicWith(0);
    await setTopicWeightAbsolute(topic.id, 0.5, 'user');
    await setTopicWeightAbsolute(topic.id, -0.5, 'user');
    await setTopicWeightAbsolute(topic.id, 0.9, 'user');

    const res = await nudgeTopic(topic.id, -0.3, 'feedback');

    expect(res.applied).toBe(true);
    expect(res.after).toBeCloseTo(0.6);
  });
});

describe('setTopicHighPriority', () => {
  it('toggles the pin, logging the prior flag, and returns the id', async () => {
    const topic = await topicWith(0.5);

    const on = await setTopicHighPriority(topic.id, true, 'feedback');
    const off = await setTopicHighPriority(topic.id, false, 'feedback');

    expect(on.applied).toBe(true);
    expect(off.applied).toBe(true);
    const rows = await logsOf('set_high_priority');
    expect(rows.map((r) => [r.id, r.action, r.summary])).toEqual([
      [on.changeLogId, { targetId: topic.id, before: false, after: true }, 'Pinned topic as high priority'],
      [off.changeLogId, { targetId: topic.id, before: true, after: false }, 'Unpinned topic'],
    ]);
    expect((await rowById('topics', topic.id)).highPriority).toBe(false);
  });

  it('the flag it already has is a no-op with no id and no row', async () => {
    const topic = await topicWith(0.5);

    const res = await setTopicHighPriority(topic.id, false, 'feedback');

    expect(res).toEqual({ applied: false });
    expect(await logRows()).toEqual([]);
  });
});

describe('nudgeFactWeight', () => {
  it('treats a NULL weight as the 1.0 baseline but logs the null verbatim', async () => {
    const { fact } = await seedInterest('I follow F1', ['formula 1']);

    const res = await nudgeFactWeight(fact.id, -0.25, 'feedback');

    expect(res.applied).toBe(true);
    expect((await rowById('facts', fact.id)).weight).toBeCloseTo(0.75);
    const [row] = await logsOf('set_fact_weight');
    expect(row).toMatchObject({ id: res.changeLogId, summary: 'Adjusted fact weight 1.00 → 0.75' });
    expect(row.action.before).toBeNull();
    expect(row.action.after as number).toBeCloseTo(0.75);
  });

  it('clamps to [-1, 1] and has no day budget', async () => {
    const { fact } = await seedInterest('I follow F1', ['formula 1']);

    await nudgeFactWeight(fact.id, 5, 'feedback');
    expect((await rowById('facts', fact.id)).weight).toBe(1);
    await nudgeFactWeight(fact.id, -1.5, 'feedback');
    await nudgeFactWeight(fact.id, -1.5, 'feedback');

    expect((await rowById('facts', fact.id)).weight).toBe(-1);
    expect(await logsOf('set_fact_weight')).toHaveLength(3);
  });

  it('an unknown fact rejects without a row', async () => {
    await expect(nudgeFactWeight('ghost', 0.1, 'feedback')).rejects.toThrow();
    expect(await logRows()).toEqual([]);
  });
});
