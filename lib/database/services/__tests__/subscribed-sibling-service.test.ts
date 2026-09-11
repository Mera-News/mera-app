jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('../user-publication-subscription-service', () => ({
  getSubscribedSourceNameSet: jest.fn(async () => new Set(['het parool'])),
  normalizeSubscriptionName: (s: string) =>
    (s ?? '').toLowerCase().trim().replace(/\s+/g, ' '),
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';

import {
  clusterIdsForRow,
  findPrimarySubscribedSibling,
  findSubscribedSiblings,
  hasUnknownPubDate,
  saveSubscriptionRead,
  siblingIsReadable,
} from '../subscribed-sibling-service';

const TABLE = 'article_suggestions';
const db = database as unknown as MockDatabase;

const T0 = new Date('2026-09-10T12:00:00Z');
const EARLIER = new Date('2026-09-10T09:00:00Z');
const LATER = new Date('2026-09-10T18:00:00Z');
const SYNC = new Date('2026-09-11T08:00:00Z');

function row(over: Record<string, any> = {}) {
  return makeRecord({
    id: over.id ?? 'r1',
    publicationName: 'Het Parool',
    stableClusterId: 'story-1',
    clusterMembershipsJson: null,
    firstPubDate: EARLIER,
    createdAt: SYNC,
    ...over,
  });
}

beforeEach(() => {
  db._setRows(TABLE, []);
  jest.clearAllMocks();
});

describe('hasUnknownPubDate', () => {
  // article-suggestion-service writes `firstPubDate = parseDate(pubDate) ?? now`
  // alongside `createdAt = now`, so a feed with no pubDate gets sync time as
  // its publication date and the two are indistinguishable.
  it('is true when firstPubDate is really the sync timestamp', () => {
    expect(hasUnknownPubDate({ firstPubDate: SYNC, createdAt: SYNC })).toBe(true);
  });

  it('tolerates a sub-second gap between the two writes', () => {
    expect(
      hasUnknownPubDate({
        firstPubDate: new Date(SYNC.getTime() + 300),
        createdAt: SYNC,
      }),
    ).toBe(true);
  });

  it('is false for a real publication date', () => {
    expect(hasUnknownPubDate({ firstPubDate: EARLIER, createdAt: SYNC })).toBe(false);
  });
});

describe('siblingIsReadable', () => {
  const anchor = { firstPubDate: T0, createdAt: SYNC };

  it('admits a sibling published before the anchor', () => {
    expect(siblingIsReadable(anchor, { firstPubDate: EARLIER, createdAt: SYNC })).toBe(true);
  });

  it('admits a sibling published at the same instant', () => {
    expect(siblingIsReadable(anchor, { firstPubDate: T0, createdAt: SYNC })).toBe(true);
  });

  // The decided rule: newer coverage is never read for this suggestion, and
  // the skip is permanent rather than deferred.
  it('SKIPS a sibling published after the anchor', () => {
    expect(siblingIsReadable(anchor, { firstPubDate: LATER, createdAt: SYNC })).toBe(false);
  });

  // The gate must compare publication time to publication time. Both rows
  // share a createdAt because siblings land in the same sync batch, so a gate
  // written against createdAt would admit everything.
  it('is not fooled by a shared createdAt', () => {
    const a = { firstPubDate: T0, createdAt: SYNC };
    const newer = { firstPubDate: LATER, createdAt: SYNC };
    expect(siblingIsReadable(a, newer)).toBe(false);
  });

  it('skips a sibling whose publication date is unknown', () => {
    expect(siblingIsReadable(anchor, { firstPubDate: SYNC, createdAt: SYNC })).toBe(false);
  });
});

describe('clusterIdsForRow', () => {
  it('includes the stable id and every membership id', () => {
    const r = row({
      stableClusterId: 'stable-1',
      clusterMembershipsJson: JSON.stringify([
        { clusterId: 'c1', confidence: 0.9, stableClusterId: 'stable-2' },
        { clusterId: 'c2', confidence: 0.4 },
      ]),
    });
    expect(new Set(clusterIdsForRow(r))).toEqual(new Set(['stable-1', 'stable-2', 'c1', 'c2']));
  });

  it('survives a malformed membership blob', () => {
    expect(clusterIdsForRow(row({ clusterMembershipsJson: '{broken' }))).toEqual(['story-1']);
  });

  it('is empty when the row belongs to no cluster', () => {
    expect(clusterIdsForRow(row({ stableClusterId: null }))).toEqual([]);
  });
});

describe('findSubscribedSiblings', () => {
  it('returns a subscribed sibling in the same story', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'NOS', firstPubDate: T0 });
    const sibling = row({ id: 'sib', publicationName: 'Het Parool', firstPubDate: EARLIER });
    db._setRows(TABLE, [anchor, sibling]);

    const found = await findSubscribedSiblings(anchor);
    expect(found.map((r) => r.id)).toEqual(['sib']);
  });

  it('never returns the anchor itself', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'Het Parool', firstPubDate: T0 });
    db._setRows(TABLE, [anchor]);
    expect(await findSubscribedSiblings(anchor)).toEqual([]);
  });

  it('excludes a sibling from an unsubscribed publication', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'NOS', firstPubDate: T0 });
    const other = row({ id: 'other', publicationName: 'De Telegraaf', firstPubDate: EARLIER });
    db._setRows(TABLE, [anchor, other]);
    expect(await findSubscribedSiblings(anchor)).toEqual([]);
  });

  it('excludes a sibling published after the anchor', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'NOS', firstPubDate: T0 });
    const newer = row({ id: 'newer', publicationName: 'Het Parool', firstPubDate: LATER });
    db._setRows(TABLE, [anchor, newer]);
    expect(await findSubscribedSiblings(anchor)).toEqual([]);
  });

  it('orders newest publication first', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'NOS', firstPubDate: LATER });
    const older = row({ id: 'older', firstPubDate: EARLIER });
    const newer = row({ id: 'newer', firstPubDate: T0 });
    db._setRows(TABLE, [anchor, older, newer]);

    const found = await findSubscribedSiblings(anchor);
    expect(found.map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('short-circuits with no query when nothing is subscribed', async () => {
    const anchor = row({ id: 'anchor' });
    db._setRows(TABLE, [anchor]);
    const found = await findSubscribedSiblings(anchor, new Set());
    expect(found).toEqual([]);
    expect(db._collections[TABLE].query).not.toHaveBeenCalled();
  });

  it('short-circuits when the anchor belongs to no cluster', async () => {
    const anchor = row({ id: 'anchor', stableClusterId: null });
    db._setRows(TABLE, [anchor]);
    expect(await findSubscribedSiblings(anchor)).toEqual([]);
    expect(db._collections[TABLE].query).not.toHaveBeenCalled();
  });

  it('matches a source name that is not the publisher name', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'NOS', firstPubDate: T0 });
    const sibling = row({ id: 'sib', publicationName: '  HET   PAROOL ', firstPubDate: EARLIER });
    db._setRows(TABLE, [anchor, sibling]);
    expect((await findSubscribedSiblings(anchor)).map((r) => r.id)).toEqual(['sib']);
  });
});

describe('findPrimarySubscribedSibling', () => {
  it('picks the newest readable sibling', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'NOS', firstPubDate: LATER });
    db._setRows(TABLE, [
      anchor,
      row({ id: 'older', firstPubDate: EARLIER }),
      row({ id: 'newer', firstPubDate: T0 }),
    ]);
    expect((await findPrimarySubscribedSibling(anchor))?.id).toBe('newer');
  });

  it('is null when there is none', async () => {
    const anchor = row({ id: 'anchor', publicationName: 'NOS' });
    db._setRows(TABLE, [anchor]);
    expect(await findPrimarySubscribedSibling(anchor)).toBeNull();
  });
});

describe('saveSubscriptionRead', () => {
  it('writes the read and its timestamp onto the ANCHOR row', async () => {
    const anchor = row({ id: 'anchor' });
    db._setRows(TABLE, [anchor]);
    await saveSubscriptionRead('anchor', 'Focuses on the coalition talks.');
    expect(anchor.subscriptionRead).toBe('Focuses on the coalition talks.');
    expect(typeof anchor.subscriptionReadAt).toBe('number');
  });
});
