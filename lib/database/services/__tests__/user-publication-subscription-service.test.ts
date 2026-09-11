jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';

import {
  cancelSubscription,
  declinePublisher,
  findByPublisherId,
  getActive,
  getSubscribedSourceNameSet,
  getSubscriptionBySourceName,
  hasAnsweredForPublisher,
  isSubscribedPublicationName,
  normalizeSubscriptionName,
  observeActive,
  parseSourceNames,
  refreshSourceNames,
  upsertSubscription,
} from '../user-publication-subscription-service';

const TABLE = 'user_publication_subscriptions';
const db = database as unknown as MockDatabase;

function makeSub(over: Record<string, any> = {}) {
  return makeRecord({
    id: over.id ?? 'row1',
    publisherId: 'pub1',
    publisherName: 'Het Parool',
    publisherNameNorm: 'het parool',
    countryCode: 'NLD',
    subscriptionUri: 'https://www.parool.nl/abonnementen',
    sourceNamesJson: JSON.stringify(['het parool', 'parool.nl']),
    status: 'active',
    ...over,
  });
}

beforeEach(() => {
  db._setRows(TABLE, []);
  jest.clearAllMocks();
});

describe('normalizeSubscriptionName', () => {
  // Must stay character-for-character identical to
  // publication-preference-service and persona-agent-core: a subscription
  // only ever fires on exact normalised equality.
  it('lowercases, trims and collapses runs of whitespace', () => {
    expect(normalizeSubscriptionName('  Het   Parool ')).toBe('het parool');
    expect(normalizeSubscriptionName('DE TELEGRAAF')).toBe('de telegraaf');
    expect(normalizeSubscriptionName('A\t\tB')).toBe('a b');
  });

  it('treats null and undefined as the empty string rather than throwing', () => {
    expect(normalizeSubscriptionName(null as unknown as string)).toBe('');
    expect(normalizeSubscriptionName(undefined as unknown as string)).toBe('');
  });
});

describe('parseSourceNames', () => {
  it('reads a well-formed array', () => {
    expect(parseSourceNames(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
  });

  // The render path must never throw on a bad blob; it degrades to "matches
  // nothing" and the next screen load refreshes the set.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['malformed json', '{oh no'],
    ['a truncated blob', '["a", "b'],
    ['a non-array', JSON.stringify({ a: 1 })],
  ])('returns [] for %s instead of throwing', (_label, input) => {
    expect(parseSourceNames(input as string | null | undefined)).toEqual([]);
  });

  it('drops non-string and empty members', () => {
    expect(parseSourceNames(JSON.stringify(['a', 1, null, '', 'b']))).toEqual(['a', 'b']);
  });
});

describe('upsertSubscription', () => {
  it('creates a row, normalising and de-duplicating the source names', async () => {
    await upsertSubscription({
      publisherId: 'pub1',
      publisherName: '  Het Parool ',
      countryCode: 'NLD',
      subscriptionUri: 'https://www.parool.nl/abonnementen',
      sourceNames: ['Het Parool', 'het   parool', 'Parool.nl', ''],
    });

    const created = db._collections[TABLE]._rows[0];
    expect(created.publisherName).toBe('Het Parool');
    expect(created.publisherNameNorm).toBe('het parool');
    expect(created.status).toBe('active');
    expect(JSON.parse(created.sourceNamesJson)).toEqual(['het parool', 'parool.nl']);
  });

  it('stores an absent subscription_uri as explicit null, not undefined', async () => {
    await upsertSubscription({
      publisherId: 'pub2',
      publisherName: 'The Next Web',
      countryCode: 'GLOBAL',
      sourceNames: ['thenextweb'],
    });
    expect(db._collections[TABLE]._rows[0].subscriptionUri).toBeNull();
  });

  it('keeps a non-alpha-3 country code verbatim', async () => {
    await upsertSubscription({
      publisherId: 'pub2',
      publisherName: 'The Next Web',
      countryCode: 'GLOBAL',
      sourceNames: [],
    });
    expect(db._collections[TABLE]._rows[0].countryCode).toBe('GLOBAL');
  });

  // Keyed on publisher_id, not name: a server-side rename must not fork the row.
  it('reuses the existing row for the same publisher id and refreshes its names', async () => {
    const existing = makeSub({ publisherName: 'Old Name', sourceNamesJson: '[]' });
    db._setRows(TABLE, [existing]);

    await upsertSubscription({
      publisherId: 'pub1',
      publisherName: 'Het Parool',
      countryCode: 'NLD',
      sourceNames: ['Het Parool'],
    });

    expect(db._collections[TABLE].create).not.toHaveBeenCalled();
    expect(existing.publisherName).toBe('Het Parool');
    expect(JSON.parse(existing.sourceNamesJson)).toEqual(['het parool']);
  });

  it('reactivates a cancelled row', async () => {
    const existing = makeSub({ status: 'cancelled' });
    db._setRows(TABLE, [existing]);
    await upsertSubscription({
      publisherId: 'pub1',
      publisherName: 'Het Parool',
      countryCode: 'NLD',
      sourceNames: ['Het Parool'],
    });
    expect(existing.status).toBe('active');
  });

  // Saying yes is a stronger signal than the No that silenced the prompt.
  it('reactivates a declined row', async () => {
    const existing = makeSub({ status: 'declined' });
    db._setRows(TABLE, [existing]);
    await upsertSubscription({
      publisherId: 'pub1',
      publisherName: 'Het Parool',
      countryCode: 'NLD',
      sourceNames: ['Het Parool'],
    });
    expect(existing.status).toBe('active');
  });
});

describe('cancelSubscription', () => {
  it('soft-deletes rather than destroying', async () => {
    const existing = makeSub();
    db._setRows(TABLE, [existing]);
    await cancelSubscription('row1');
    expect(existing.status).toBe('cancelled');
    expect(existing.destroyPermanently).not.toHaveBeenCalled();
  });
});

describe('declinePublisher', () => {
  it('writes a declined row when none exists', async () => {
    await declinePublisher({
      publisherId: 'pub9',
      publisherName: 'De Telegraaf',
      countryCode: 'NLD',
    });
    const row = db._collections[TABLE]._rows[0];
    expect(row.status).toBe('declined');
    expect(row.sourceNamesJson).toBe('[]');
  });

  // A stray prompt dismissal must never cost the user a real subscription.
  it('refuses to overwrite an ACTIVE subscription', async () => {
    const existing = makeSub({ status: 'active' });
    db._setRows(TABLE, [existing]);
    await declinePublisher({
      publisherId: 'pub1',
      publisherName: 'Het Parool',
      countryCode: 'NLD',
    });
    expect(existing.status).toBe('active');
  });

  it('flips a cancelled row to declined', async () => {
    const existing = makeSub({ status: 'cancelled' });
    db._setRows(TABLE, [existing]);
    await declinePublisher({
      publisherId: 'pub1',
      publisherName: 'Het Parool',
      countryCode: 'NLD',
    });
    expect(existing.status).toBe('declined');
  });
});

describe('hasAnsweredForPublisher', () => {
  it.each([
    ['active', true],
    ['declined', true],
    ['cancelled', false],
  ])('is %s -> %s', async (status, expected) => {
    db._setRows(TABLE, [makeSub({ status })]);
    expect(await hasAnsweredForPublisher('pub1')).toBe(expected);
  });

  it('is false when the publisher is unknown', async () => {
    expect(await hasAnsweredForPublisher('nope')).toBe(false);
  });
});

describe('findByPublisherId', () => {
  it('returns null rather than throwing when absent', async () => {
    expect(await findByPublisherId('nope')).toBeNull();
  });
});

describe('refreshSourceNames', () => {
  it('writes when the set changed', async () => {
    const existing = makeSub();
    db._setRows(TABLE, [existing]);
    const changed = await refreshSourceNames('pub1', ['Het Parool', 'Parool.nl', 'New Feed']);
    expect(changed).toBe(true);
    expect(JSON.parse(existing.sourceNamesJson)).toContain('new feed');
  });

  // Guards against churning updated_at on every mount of the screen.
  it('is a no-op when the set is unchanged, regardless of order', async () => {
    const existing = makeSub();
    db._setRows(TABLE, [existing]);
    const changed = await refreshSourceNames('pub1', ['Parool.nl', 'HET PAROOL']);
    expect(changed).toBe(false);
    expect(existing.update).not.toHaveBeenCalled();
  });

  it('does nothing for a cancelled subscription', async () => {
    db._setRows(TABLE, [makeSub({ status: 'cancelled' })]);
    expect(await refreshSourceNames('pub1', ['anything'])).toBe(false);
  });

  it('does nothing for an unknown publisher', async () => {
    expect(await refreshSourceNames('nope', ['anything'])).toBe(false);
  });
});

describe('source-name matching', () => {
  it('unions every active subscription source name', async () => {
    db._setRows(TABLE, [
      makeSub({ id: 'a', publisherId: 'p1', sourceNamesJson: JSON.stringify(['x', 'y']) }),
      makeSub({ id: 'b', publisherId: 'p2', sourceNamesJson: JSON.stringify(['y', 'z']) }),
    ]);
    expect(await getSubscribedSourceNameSet()).toEqual(new Set(['x', 'y', 'z']));
  });

  // THE correctness trap this column exists for: an article carries the
  // SOURCE's name, which is not the publisher's name.
  it('matches a source name that differs from the publisher name', async () => {
    db._setRows(TABLE, [
      makeSub({ publisherName: 'DPG Media', publisherNameNorm: 'dpg media' }),
    ]);
    expect(await isSubscribedPublicationName('Parool.nl')).toBe(true);
    expect(await isSubscribedPublicationName('DPG Media')).toBe(false);
  });

  it('normalises the incoming publication name before matching', async () => {
    db._setRows(TABLE, [makeSub()]);
    expect(await isSubscribedPublicationName('  HET   PAROOL ')).toBe(true);
  });

  it.each([[null], [undefined], ['']])('is false for %s', async (input) => {
    db._setRows(TABLE, [makeSub()]);
    expect(await isSubscribedPublicationName(input as string | null | undefined)).toBe(false);
  });

  it('maps each source name to its subscription, first writer winning', async () => {
    db._setRows(TABLE, [
      makeSub({ id: 'a', publisherId: 'p1', sourceNamesJson: JSON.stringify(['shared']) }),
      makeSub({ id: 'b', publisherId: 'p2', sourceNamesJson: JSON.stringify(['shared']) }),
    ]);
    const map = await getSubscriptionBySourceName();
    expect(map.get('shared')?.id).toBe('a');
  });
});

describe('queries', () => {
  it('getActive filters on active status', async () => {
    db._setRows(TABLE, [makeSub()]);
    await getActive();
    expect(db._collections[TABLE].query).toHaveBeenCalled();
  });

  it('observeActive returns an observable query', () => {
    const q = { observe: jest.fn(() => 'obs') };
    db._collections[TABLE].query.mockReturnValueOnce(q as never);
    expect(observeActive()).toBe('obs');
    expect(q.observe).toHaveBeenCalled();
  });
});
