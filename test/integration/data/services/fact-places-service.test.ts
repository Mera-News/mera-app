// Fact places services (fbx P1): set / equal / user guard / change-log row / revert / mark wrong /
// stop news / regeneration gates. Real in-memory DB; only the model gateway is faked.
import { addFact, getFacts, markFactPlacesWrong, setFactPlaces, stopNewsForFact } from '@/lib/database/services/fact-service';
import { getRecent, revertChange } from '@/lib/database/services/persona-change-log-service';
import { sweepForMutation } from '@/lib/database/services/persona-mutation-sweeps';
import { regenerateTopicsForFact } from '@/lib/database/services/topic-replacement-service';
import { getByFact } from '@/lib/database/services/topic-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { advanceUntilDone, gatewayCalls, mockGateway, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';

import {
  cleanupTopics,
  resetCloudMemory,
  resetTopicsMemory,
  seedFact,
  setMode,
} from './topics/support';

beforeEach(async () => {
  resetTopicsMemory();
  resetCloudMemory();
  await signInFixtureAccount();
  useFakeClock(Date.parse('2026-10-09T10:00:00Z'));
});
afterEach(cleanupTopics);

const meta = async (id: string) => ((await getFacts()).find((f) => f.id === id)?.metadata ?? {}) as Record<string, unknown>;
const set = (...args: Parameters<typeof setFactPlaces>) => advanceUntilDone(setFactPlaces(...args));
const logsOf = async (type: string) => (await getRecent(50)).filter((r) => r.actionType === type);

describe('setFactPlaces', () => {
  it('writes places, keeps metadata.topics, stamps the source and logs one row', async () => {
    const { fact } = await seedFact('Lives in Amsterdam', ['Amsterdam news']);

    const out = await set(fact.id, ['NL', 'NL'], 'user', { regenerate: false });

    expect(out.applied).toBe(true);
    const m = await meta(fact.id);
    expect(m).toMatchObject({ places: ['NL'], places_by: 'user', topics: ['Amsterdam news'] });
    expect(typeof m.places_source).toBe('string');
    const rows = await logsOf('set_fact_places');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(out.changeLogId);
    expect(rows[0].source).toBe('user');
    expect(JSON.parse(rows[0].actionJson).after).toEqual({ places: ['NL'], by: 'user' });
  });

  it('an equal place set only refreshes the source: no row, applied false', async () => {
    const { fact } = await seedFact('Lives in Amsterdam');
    await set(fact.id, ['NL'], 'user', { regenerate: false });
    const out = await set(fact.id, ['NL'], 'user', { regenerate: false });
    expect(out).toEqual({ applied: false });
    expect(await logsOf('set_fact_places')).toHaveLength(1);
  });

  it('a sweep never overwrites a user choice; a user overwrites a sweep (source llm)', async () => {
    const { fact } = await seedFact('Follows cricket');
    await set(fact.id, ['IN'], 'user', { regenerate: false });
    expect(await set(fact.id, ['GLOBAL'], 'sweep', { regenerate: false })).toEqual({ applied: false });
    expect((await meta(fact.id)).places).toEqual(['IN']);

    const other = await addFact('Follows football');
    await set(other.id, ['GLOBAL'], 'sweep', { regenerate: false });
    expect((await logsOf('set_fact_places')).find((r) => r.source === 'llm')).toBeDefined();
    expect((await set(other.id, ['ES'], 'user', { regenerate: false })).applied).toBe(true);
  });

  it('is invisible to the feed sweeps', () => {
    expect(sweepForMutation({ actionType: ACTION_NAMES.SET_FACT_PLACES })).toBeNull();
    expect(sweepForMutation({ actionType: ACTION_NAMES.SET_FACT_NEWS_STOPPED })).toBeNull();
  });
});

describe('revert of set_fact_places', () => {
  it('restores places, by and source, clears the flag, and regenerates topics', async () => {
    const { fact } = await seedFact('Follows cricket', ['cricket news']);
    await addFact('Lives in Amsterdam');
    await set(fact.id, ['IN'], 'sweep', { regenerate: false });
    const before = await meta(fact.id);
    const out = await set(fact.id, ['NL'], 'user', { regenerate: false });
    server.use(...mockGateway(() => '["Netherlands cricket broadcasts"]'));

    expect(await advanceUntilDone(revertChange(out.changeLogId!))).toBe(true);

    const m = await meta(fact.id);
    expect(m).toMatchObject({ places: ['IN'], places_by: 'sweep', places_source: before.places_source });
    expect(gatewayCalls('batch')).toHaveLength(1);
    expect(m.places_topics_for).toEqual(['IN']);
  });

  it('a newer places write owns the value: the undo is a no-op', async () => {
    const { fact } = await seedFact('Follows cricket');
    const first = await set(fact.id, ['IN'], 'user', { regenerate: false });
    await set(fact.id, ['NL'], 'user', { regenerate: false });
    expect(await advanceUntilDone(revertChange(first.changeLogId!))).toBe(false);
    expect((await meta(fact.id)).places).toEqual(['NL']);
  });
});

describe('markFactPlacesWrong', () => {
  it('flags a sweep answer and clears its source; a user answer stays', async () => {
    const { fact } = await seedFact('Follows cricket');
    await set(fact.id, ['IN'], 'sweep', { regenerate: false });
    expect(await markFactPlacesWrong(fact.id)).toBe(true);
    const m = await meta(fact.id);
    expect(m.places_wrong).toBe(true);
    expect(m.places_source).toBeUndefined();

    const mine = await addFact('Lives in Amsterdam');
    await set(mine.id, ['NL'], 'user', { regenerate: false });
    expect(await markFactPlacesWrong(mine.id)).toBe(false);
    expect((await meta(mine.id)).places_wrong).toBeUndefined();
  });
});

describe('stopNewsForFact', () => {
  it('retires topics through logged retire_topic rows; undoing the flag row clears news_stopped', async () => {
    const { fact, topics } = await seedFact('Follows cricket', ['cricket news', { text: 'IPL', provenance: 'tracked' }]);

    const { changeLogIds } = await stopNewsForFact(fact.id);

    const rows = await getByFact(fact.id);
    expect(rows.find((r) => r.text === 'cricket news')?.status).toBe('retired');
    expect(rows.find((r) => r.text === 'IPL')?.status).toBe('active');
    expect(changeLogIds).toHaveLength(2);
    expect((await meta(fact.id)).news_stopped).toBe(true);

    // retire_topic undoes (reactivates); the flag row clears the flag
    expect(await revertChange(changeLogIds[0])).toBe(true);
    expect((await getByFact(fact.id)).find((r) => r.id === topics[0].id)?.status).toBe('active');
    expect(await revertChange(changeLogIds[1])).toBe(true);
    expect((await meta(fact.id)).news_stopped).toBeUndefined();
  });
});

describe('regenerateTopicsForFact gates', () => {
  it('skips on-device and news_stopped facts without asking a model', async () => {
    const { fact } = await seedFact('Follows cricket', ['cricket news']);
    await addFact('Lives in Amsterdam');
    await setMode('on-device');
    expect((await advanceUntilDone(regenerateTopicsForFact(fact.id))).ok).toBe(false);
    await setMode('cloud');
    await stopNewsForFact(fact.id);
    expect((await advanceUntilDone(regenerateTopicsForFact(fact.id))).ok).toBe(false);
    expect(gatewayCalls()).toHaveLength(0);
  });
});
