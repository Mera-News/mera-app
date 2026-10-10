// user-publication-subscription-service at its seam: the real service over the in-memory DB.
// Replaces lib/database/services/__tests__/user-publication-subscription-service.test.ts, whose
// database mock ignored the `status = 'active'` clause: "getActive filters on active status" could
// only assert that query() was called. Here a cancelled and a declined row are really filtered out.
//
// Spec from the mera-app-data skill: subscriptions are DEVICE-ONLY; matching runs on
// `source_names_json`, never on `publisher_name`; subscribing writes NO preference row.
import {
  cancelSubscription,
  declinePublisher,
  findByPublisherId,
  getActive,
  getSubscribedSourceNameSet,
  hasAnsweredForPublisher,
  normalizeSubscriptionName,
  observeActive,
  parseSourceNames,
  refreshSourceNames,
  upsertSubscription,
  type UpsertSubscriptionInput,
} from '@/lib/database/services/user-publication-subscription-service';
import { useStrictClock } from '@/test/helpers';
import { countRows, T0, until } from './support';

const PREFS = 'publication_preferences';
const SUBS = 'user_publication_subscriptions';
const at = (ms: number) => jest.setSystemTime(ms);

const sub = (over: Partial<UpsertSubscriptionInput> = {}): UpsertSubscriptionInput => ({
  publisherId: 'pub1',
  publisherName: 'Het Parool',
  countryCode: 'NLD',
  subscriptionUri: 'https://www.parool.nl/abonnementen',
  sourceNames: ['Het Parool', 'Parool.nl'],
  ...over,
});

const names = async (publisherId = 'pub1') => parseSourceNames((await findByPublisherId(publisherId))?.sourceNamesJson);

describe('normalizeSubscriptionName', () => {
  // Must stay character-for-character identical to publication-preference-service and
  // persona-agent-core: a subscription only ever fires on exact normalised-name equality.
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

  // The render path must never throw on a bad blob; it degrades to "matches nothing".
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
  beforeEach(() => useStrictClock(T0));

  it('creates an active row, trimming the name and normalising and de-duplicating the source names', async () => {
    const created = await upsertSubscription(
      sub({ publisherName: '  Het Parool ', sourceNames: ['Het Parool', 'het   parool', 'Parool.nl', ''] }),
    );

    const row = await findByPublisherId('pub1');
    expect(row?.id).toBe(created.id);
    expect(row).toMatchObject({
      publisherId: 'pub1',
      publisherName: 'Het Parool',
      publisherNameNorm: 'het parool',
      countryCode: 'NLD',
      subscriptionUri: 'https://www.parool.nl/abonnementen',
      status: 'active',
    });
    expect(parseSourceNames(row?.sourceNamesJson)).toEqual(['het parool', 'parool.nl']);
    expect(row?.subscribedAt.getTime()).toBe(T0);
    expect(row?.createdAt.getTime()).toBe(T0);
    expect(row?.updatedAt.getTime()).toBe(T0);
  });

  it('stores an absent subscription uri as null and keeps a non-alpha-3 country code verbatim', async () => {
    await upsertSubscription(sub({ publisherId: 'pub2', publisherName: 'The Next Web', countryCode: 'GLOBAL', subscriptionUri: undefined, sourceNames: [] }));

    expect(await findByPublisherId('pub2')).toMatchObject({ subscriptionUri: null, countryCode: 'GLOBAL', sourceNamesJson: '[]' });
  });

  it('writes NO publication preference row, on the first subscribe or on a re-subscribe', async () => {
    await upsertSubscription(sub());
    expect(await countRows(PREFS)).toBe(0);

    await upsertSubscription(sub({ sourceNames: ['Het Parool', 'Parool.nl', 'New Feed'] }));
    expect(await countRows(PREFS)).toBe(0);
    expect(await countRows(SUBS)).toBe(1);
  });

  // Keyed on publisher_id, not name: a server-side rename must not fork the row.
  it('reuses the row of the same publisher id, refreshing the name, the uri and the source names', async () => {
    const first = await upsertSubscription(sub({ publisherName: 'Old Name', sourceNames: [] }));
    at(T0 + 5000);

    const again = await upsertSubscription(sub({ publisherName: 'Het Parool', subscriptionUri: null, sourceNames: ['Het Parool'] }));

    expect(again.id).toBe(first.id);
    expect(await countRows(SUBS)).toBe(1);
    const row = await findByPublisherId('pub1');
    expect(row).toMatchObject({ publisherName: 'Het Parool', publisherNameNorm: 'het parool', subscriptionUri: null });
    expect(parseSourceNames(row?.sourceNamesJson)).toEqual(['het parool']);
    expect(row?.createdAt.getTime()).toBe(T0);
    expect(row?.subscribedAt.getTime()).toBe(T0 + 5000);
    expect(row?.updatedAt.getTime()).toBe(T0 + 5000);
  });

  it('reactivates a cancelled row', async () => {
    const created = await upsertSubscription(sub());
    await cancelSubscription(created.id);

    await upsertSubscription(sub());

    expect((await findByPublisherId('pub1'))?.status).toBe('active');
    expect(await countRows(SUBS)).toBe(1);
  });

  // Saying yes is a stronger signal than the No that silenced the prompt.
  it('reactivates a declined row', async () => {
    await declinePublisher({ publisherId: 'pub1', publisherName: 'Het Parool', countryCode: 'NLD' });

    await upsertSubscription(sub());

    expect((await findByPublisherId('pub1'))).toMatchObject({ status: 'active' });
    expect(await names()).toEqual(['het parool', 'parool.nl']);
  });
});

describe('findByPublisherId', () => {
  it('returns null rather than throwing when absent', async () => {
    expect(await findByPublisherId('nope')).toBeNull();
  });

  it('finds a row of any status', async () => {
    const created = await upsertSubscription(sub());
    await cancelSubscription(created.id);
    expect((await findByPublisherId('pub1'))?.status).toBe('cancelled');
  });
});

describe('getActive / observeActive', () => {
  it('getActive returns active rows only: cancelled and declined rows are filtered by the query', async () => {
    await upsertSubscription(sub({ publisherId: 'active-1' }));
    const toCancel = await upsertSubscription(sub({ publisherId: 'cancelled-1' }));
    await cancelSubscription(toCancel.id);
    await declinePublisher({ publisherId: 'declined-1', publisherName: 'De Telegraaf', countryCode: 'NLD' });

    expect((await getActive()).map((r) => r.publisherId)).toEqual(['active-1']);
  });

  it('observeActive emits the active set again as subscriptions come and go', async () => {
    const emissions: string[] = [];
    const subscription = observeActive().subscribe((rows) => emissions.push(rows.map((r) => r.publisherId).sort().join(',')));
    const last = () => emissions[emissions.length - 1];
    try {
      await until(() => emissions.length > 0, 'the first emission');
      expect(last()).toBe('');

      await upsertSubscription(sub({ publisherId: 'p1' }));
      await until(() => last() === 'p1', 'p1 to appear');

      const second = await upsertSubscription(sub({ publisherId: 'p2' }));
      await until(() => last() === 'p1,p2', 'p2 to appear');

      await cancelSubscription(second.id);
      await until(() => last() === 'p1', 'p2 to go');
    } finally {
      subscription.unsubscribe();
    }
  });
});

describe('cancelSubscription', () => {
  beforeEach(() => useStrictClock(T0));

  it('soft-deletes: the row stays, cancelled, with a new updatedAt, and drops out of the active set', async () => {
    const created = await upsertSubscription(sub());
    at(T0 + 1000);

    await cancelSubscription(created.id);

    const row = await findByPublisherId('pub1');
    expect(row?.status).toBe('cancelled');
    expect(row?.updatedAt.getTime()).toBe(T0 + 1000);
    expect(await getActive()).toEqual([]);
    expect(await countRows(SUBS)).toBe(1);
  });

  it('rejects for an id that is not there', async () => {
    await expect(cancelSubscription('missing-id')).rejects.toThrow();
  });
});

describe('declinePublisher', () => {
  const decline = (over: Record<string, string> = {}) =>
    declinePublisher({ publisherId: 'pub9', publisherName: ' De Telegraaf ', countryCode: 'NLD', ...over });

  it('writes a declined row with an empty source set when none exists, and no preference row', async () => {
    await decline();

    expect(await findByPublisherId('pub9')).toMatchObject({
      status: 'declined',
      publisherName: 'De Telegraaf',
      publisherNameNorm: 'de telegraaf',
      sourceNamesJson: '[]',
      subscriptionUri: null,
    });
    expect(await countRows(PREFS)).toBe(0);
  });

  // A stray prompt dismissal must never cost the user a real subscription.
  it('refuses to overwrite an ACTIVE subscription', async () => {
    await upsertSubscription(sub());

    await decline({ publisherId: 'pub1', publisherName: 'Het Parool' });

    expect((await findByPublisherId('pub1'))?.status).toBe('active');
    expect(await names()).toEqual(['het parool', 'parool.nl']);
  });

  it('flips a cancelled row to declined', async () => {
    const created = await upsertSubscription(sub());
    await cancelSubscription(created.id);

    await decline({ publisherId: 'pub1', publisherName: 'Het Parool' });

    expect((await findByPublisherId('pub1'))?.status).toBe('declined');
  });

  it('declining twice keeps one declined row', async () => {
    await decline();
    await decline();
    expect(await countRows(SUBS)).toBe(1);
    expect((await findByPublisherId('pub9'))?.status).toBe('declined');
  });
});

describe('hasAnsweredForPublisher', () => {
  it('is true for an active or a declined publisher, false for a cancelled or unknown one', async () => {
    await upsertSubscription(sub({ publisherId: 'active' }));
    await declinePublisher({ publisherId: 'declined', publisherName: 'D', countryCode: 'NLD' });
    const cancelled = await upsertSubscription(sub({ publisherId: 'cancelled' }));
    await cancelSubscription(cancelled.id);

    expect(await hasAnsweredForPublisher('active')).toBe(true);
    expect(await hasAnsweredForPublisher('declined')).toBe(true);
    expect(await hasAnsweredForPublisher('cancelled')).toBe(false);
    expect(await hasAnsweredForPublisher('nope')).toBe(false);
  });
});

describe('refreshSourceNames', () => {
  beforeEach(() => useStrictClock(T0));

  it('writes, normalised, when the set changed', async () => {
    await upsertSubscription(sub());
    at(T0 + 1000);

    expect(await refreshSourceNames('pub1', ['Het Parool', 'Parool.nl', 'New Feed'])).toBe(true);

    expect(await names()).toEqual(['het parool', 'parool.nl', 'new feed']);
    expect((await findByPublisherId('pub1'))?.updatedAt.getTime()).toBe(T0 + 1000);
  });

  // Guards against churning updated_at on every mount of the screen.
  it('is a no-op when the set is unchanged, whatever the order or case', async () => {
    await upsertSubscription(sub());
    at(T0 + 1000);

    expect(await refreshSourceNames('pub1', ['Parool.nl', 'HET PAROOL'])).toBe(false);

    expect((await findByPublisherId('pub1'))?.updatedAt.getTime()).toBe(T0);
  });

  it('does nothing for a cancelled subscription or an unknown publisher', async () => {
    const created = await upsertSubscription(sub());
    await cancelSubscription(created.id);

    expect(await refreshSourceNames('pub1', ['anything'])).toBe(false);
    expect(await refreshSourceNames('nope', ['anything'])).toBe(false);
    expect(await names()).toEqual(['het parool', 'parool.nl']);
  });
});

describe('source-name matching', () => {
  it('getSubscribedSourceNameSet is the union of every ACTIVE subscription source names', async () => {
    await upsertSubscription(sub({ publisherId: 'p1', sourceNames: ['x', 'y'] }));
    await upsertSubscription(sub({ publisherId: 'p2', sourceNames: ['y', 'z'] }));
    const gone = await upsertSubscription(sub({ publisherId: 'p3', sourceNames: ['cancelled-name'] }));
    await cancelSubscription(gone.id);
    await declinePublisher({ publisherId: 'p4', publisherName: 'Declined', countryCode: 'NLD' });

    expect(await getSubscribedSourceNameSet()).toEqual(new Set(['x', 'y', 'z']));
  });

  // THE correctness trap this column exists for: an article carries the SOURCE's name, which is
  // not the publisher's name.
  it('holds the source names, never the publisher name', async () => {
    await upsertSubscription(sub({ publisherName: 'DPG Media', sourceNames: ['Het Parool', 'Parool.nl'] }));

    const set = await getSubscribedSourceNameSet();
    expect(set.has('parool.nl')).toBe(true);
    expect(set.has('dpg media')).toBe(false);
  });

  it('is empty with no subscriptions', async () => {
    expect(await getSubscribedSourceNameSet()).toEqual(new Set());
  });
});
