// persona-migration-service: the one-time silent persona v3 migration, run against the real
// in-memory DB. Facts are seeded through fact-service; assertions read the topics, locations,
// fact weights, change log and the guard row back.
// Loaded here so the testing-library hooks it registers attach at file load, not inside the first test
// (jest.setup.integration.js requires the helpers lazily from its beforeEach).
import '@/test/helpers';
import database from '@/lib/database';
import type FactModel from '@/lib/database/models/Fact';
import type LocationModel from '@/lib/database/models/Location';
import type PersonaChangeLogModel from '@/lib/database/models/PersonaChangeLog';
import type TopicModel from '@/lib/database/models/Topic';
import { addFact } from '@/lib/database/services/fact-service';
import * as locationService from '@/lib/database/services/location-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { createTopics } from '@/lib/database/services/topic-service';
import logger from '@/lib/logger';
import { PERSONA_V3_MIGRATION_KEY, runPersonaMigrationIfNeeded } from '@/lib/services/persona-migration-service';

const topics = () => database.get<TopicModel>('topics').query().fetch();
const locations = () => database.get<LocationModel>('locations').query().fetch();
const changeLog = () => database.get<PersonaChangeLogModel>('persona_change_log').query().fetch();
const factWeights = async () =>
  Object.fromEntries((await database.get<FactModel>('facts').query().fetch()).map((f) => [f.statement, f.weight ?? null]));

const HOME = 'Lives in Nieuw-West, Amsterdam, Netherlands, Europe';

afterEach(() => jest.restoreAllMocks());

describe('runPersonaMigrationIfNeeded', () => {
  it('on an empty persona it runs, migrates nothing and marks the guard done', async () => {
    const result = await runPersonaMigrationIfNeeded();

    expect(result).toEqual({ ran: true, factsMigrated: 0, topicsCreated: 0, locationsUpserted: 0 });
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('done');
    expect(await topics()).toEqual([]);
    expect(await changeLog()).toEqual([]);
  });

  it('is a no-op once the guard reads done', async () => {
    await addFact('Follows Formula 1', { topics: ['Formula 1'] });
    await setSetting(PERSONA_V3_MIGRATION_KEY, 'done');

    const result = await runPersonaMigrationIfNeeded();

    expect(result).toEqual({ ran: false, factsMigrated: 0, topicsCreated: 0, locationsUpserted: 0 });
    expect(await topics()).toEqual([]);
    expect(await factWeights()).toEqual({ 'Follows Formula 1': null });
    expect(await changeLog()).toEqual([]);
  });

  it('writes topic rows, fact weights, a change-log entry per fact and the guard', async () => {
    const fact = await addFact('Follows Formula 1', { topics: ['Formula 1', ' formula   1 ', 'Grand Prix', ''] });

    const result = await runPersonaMigrationIfNeeded();

    // Duplicates (by normalized text) and blanks collapse to one row each.
    expect(result).toEqual({ ran: true, factsMigrated: 1, topicsCreated: 2, locationsUpserted: 0 });
    const rows = (await topics()).sort((a, b) => a.text.localeCompare(b.text));
    expect(rows.map((t) => ({
      factId: t.factId,
      text: t.text,
      normalizedText: t.normalizedText,
      weight: t.weight,
      status: t.status,
      provenance: t.provenance,
      highPriority: t.highPriority,
      locationId: t.locationId,
    }))).toEqual([
      { factId: fact.id, text: 'Formula 1', normalizedText: 'formula 1', weight: 0.75, status: 'active', provenance: 'migration', highPriority: false, locationId: null },
      { factId: fact.id, text: 'Grand Prix', normalizedText: 'grand prix', weight: 0.75, status: 'active', provenance: 'migration', highPriority: false, locationId: null },
    ]);
    expect(await factWeights()).toEqual({ 'Follows Formula 1': 1 });
    const log = await changeLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actionType: 'migrate_fact', source: 'migration', reverted: false });
    expect(JSON.parse(log[0].actionJson)).toEqual({
      targetId: fact.id,
      before: { weight: null },
      after: { weight: 1 },
      topicsCreated: 2,
      locationsDerived: 0,
    });
    expect(log[0].summary).toBe('Migrated fact to persona v3 (2 topics): Follows Formula 1');
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('done');
  });

  it('never modifies fact.metadata.topics', async () => {
    await addFact('Follows Formula 1', { topics: ['Formula 1', 'Grand Prix'] });

    await runPersonaMigrationIfNeeded();

    const [fact] = await database.get<FactModel>('facts').query().fetch();
    expect(fact.metadata).toEqual({ topics: ['Formula 1', 'Grand Prix'] });
  });

  it('weights a fact that has no metadata topics and counts it as migrated', async () => {
    await addFact('Likes to read');

    const result = await runPersonaMigrationIfNeeded();

    expect(result).toEqual({ ran: true, factsMigrated: 1, topicsCreated: 0, locationsUpserted: 0 });
    expect(await factWeights()).toEqual({ 'Likes to read': 1 });
    expect(await topics()).toEqual([]);
    expect(await changeLog()).toHaveLength(1);
  });

  it('derives a location from an anchored statement and links the topics that name its city', async () => {
    const fact = await addFact(HOME, { topics: ['Cycling in Nieuw-West', 'Dutch politics'] });

    const result = await runPersonaMigrationIfNeeded();

    expect(result).toEqual({ ran: true, factsMigrated: 1, topicsCreated: 2, locationsUpserted: 1 });
    const [loc] = await locations();
    expect(loc).toMatchObject({
      city: 'Nieuw-West',
      region: 'Amsterdam',
      countryCode: 'NL',
      role: 'home',
      weight: 1,
      validUntil: null,
      provenance: 'migration',
      sourceFactId: fact.id,
    });
    const byText = Object.fromEntries((await topics()).map((t) => [t.text, t.locationId]));
    expect(byText).toEqual({ 'Cycling in Nieuw-West': loc.id, 'Dutch politics': null });
    const [log] = await changeLog();
    expect(JSON.parse(log.actionJson)).toMatchObject({ locationsDerived: 1 });
    expect(log.summary).toBe(`Migrated fact to persona v3 (2 topics, 1 location): ${HOME}`);
  });

  it('infers the role from the statement and keeps a statement with no resolvable country out of locations', async () => {
    await addFact('Parents live in Brooklyn, New York, United States, North America');
    await addFact('Works in Berlin, Germany');
    await addFact('Lives in Nowhereville, Atlantis');

    const result = await runPersonaMigrationIfNeeded();

    expect(result.locationsUpserted).toBe(2);
    const rows = (await locations()).sort((a, b) => a.countryCode.localeCompare(b.countryCode));
    expect(rows.map((l) => [l.city, l.countryCode, l.role, l.weight])).toEqual([
      ['Berlin', 'DE', 'work', 0.8],
      ['Brooklyn', 'US', 'family', 0.7],
    ]);
  });

  it('upserts one location for two facts that anchor the same place and role', async () => {
    await addFact('Lives in Amsterdam, Netherlands');
    await addFact('Lives in Amsterdam, Netherlands, Europe');

    const result = await runPersonaMigrationIfNeeded();

    expect(result).toMatchObject({ factsMigrated: 2, locationsUpserted: 1 });
    expect(await locations()).toHaveLength(1);
  });

  it('skips a fact that already has topics rows', async () => {
    const done = await addFact('Already topical', { topics: ['Old topic'] });
    await createTopics([{ factId: done.id, text: 'Old topic', weight: 0.5 }]);
    await addFact('Fresh fact', { topics: ['Fresh topic'] });

    const result = await runPersonaMigrationIfNeeded();

    expect(result).toEqual({ ran: true, factsMigrated: 1, topicsCreated: 1, locationsUpserted: 0 });
    expect(await factWeights()).toEqual({ 'Already topical': null, 'Fresh fact': 1 });
    expect((await topics()).map((t) => [t.text, t.weight]).sort()).toEqual([
      ['Fresh topic', 0.75],
      ['Old topic', 0.5],
    ]);
  });

  it('resumes from a pending guard: facts that already carry a weight are not migrated twice', async () => {
    await addFact('First', { topics: ['One'] });
    await runPersonaMigrationIfNeeded();
    await addFact('Second', { topics: ['Two'] });
    await setSetting(PERSONA_V3_MIGRATION_KEY, 'pending');

    const result = await runPersonaMigrationIfNeeded();

    expect(result).toEqual({ ran: true, factsMigrated: 1, topicsCreated: 1, locationsUpserted: 0 });
    expect((await topics()).map((t) => t.text).sort()).toEqual(['One', 'Two']);
    expect(await changeLog()).toHaveLength(2);
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('done');
  });

  it('leaves the guard pending when a chunk fails, keeps the finished chunk, and resumes on the next run', async () => {
    // 50 facts per transaction: the 51st lands in the second chunk, which carries the location.
    for (let i = 0; i < 50; i++) await addFact(`Fact ${String(i).padStart(2, '0')}`, { topics: [`Topic ${i}`] });
    await addFact(HOME, { topics: ['Cycling in Nieuw-West'] });
    const capture = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
    jest.spyOn(locationService, 'upsertLocation').mockRejectedValueOnce(new Error('disk full'));

    await expect(runPersonaMigrationIfNeeded()).rejects.toThrow('disk full');

    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'persona-migration', method: 'runPersonaMigrationIfNeeded' },
    });
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('pending');
    expect(await topics()).toHaveLength(50);
    expect(Object.values(await factWeights()).filter((w) => w === 1)).toHaveLength(50);
    expect(await locations()).toEqual([]);

    const result = await runPersonaMigrationIfNeeded();

    expect(result).toEqual({ ran: true, factsMigrated: 1, topicsCreated: 1, locationsUpserted: 1 });
    expect(await topics()).toHaveLength(51);
    expect(await locations()).toHaveLength(1);
    expect(await changeLog()).toHaveLength(51);
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('done');
  });

  it('a second run after completion changes nothing', async () => {
    await addFact(HOME, { topics: ['Cycling in Nieuw-West'] });
    await runPersonaMigrationIfNeeded();

    const second = await runPersonaMigrationIfNeeded();

    expect(second).toEqual({ ran: false, factsMigrated: 0, topicsCreated: 0, locationsUpserted: 0 });
    expect(await topics()).toHaveLength(1);
    expect(await locations()).toHaveLength(1);
    expect(await changeLog()).toHaveLength(1);
  });
});
