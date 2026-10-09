// subscribed-sibling-service: "a subscribed publication covered this story", shared by article detail
// and the post-scoring read stage. It matches on STABLE cluster ids (the indexed stable_cluster_id
// column), never on the per-run HDBSCAN `clusterId`s, which live in a different namespace. A query
// that fed raw ids into that column matched nothing and shipped green past a full suite because the
// old shared mock ignored the WHERE clause. Here the real query runs. Subscriptions are made through
// user-publication-subscription-service. Replaces
// lib/database/services/__tests__/subscribed-sibling-service.test.ts.
import {
  cancelSubscription,
  upsertSubscription,
} from '@/lib/database/services/user-publication-subscription-service';
import {
  clusterIdsForRow,
  findPrimarySubscribedSibling,
  findSubscribedSiblings,
  getSubscribedCoverageForArticle,
  hasUnknownPubDate,
  saveSubscriptionRead,
  siblingIsReadable,
} from '@/lib/database/services/subscribed-sibling-service';
import {
  DAY,
  HOUR,
  T0,
  article,
  bareRow,
  failNextQuery,
  freezeClock,
  row,
  seed,
  type PersonaInput,
} from './support';

beforeEach(() => freezeClock());
afterEach(() => jest.restoreAllMocks());

const ago = (hours: number) => new Date(T0 - hours * HOUR).toISOString();
const SYNC = new Date(T0);

async function subscribe(publisherName = 'Het Parool', sourceNames: string[] = ['Het Parool'], publisherId = 'p1') {
  return upsertSubscription({ publisherId, publisherName, countryCode: 'NLD', sourceNames });
}

/** A story member: its publication, when it was published, and the stable id it carries. */
const member = (id: string, publication: string, hoursAgo: number, over: Parameters<typeof article>[1] = {}) =>
  article(id, { publication_name: publication, pubDate: ago(hoursAgo), ...over });

const inStory = (...ids: string[]): PersonaInput => ({ stable: Object.fromEntries(ids.map((id) => [id, 'story-1'])) });

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('hasUnknownPubDate', () => {
  // persist writes firstPubDate = parseDate(pubDate) ?? now alongside createdAt = now, so a feed with
  // no usable pubDate gets sync time as its publication date and the two are indistinguishable.
  it('is true when firstPubDate is really the sync time (a feed with no usable pubDate)', async () => {
    await seed([article('a1', { pubDate: 'not-a-date' })]);

    expect(hasUnknownPubDate(await row('a1'))).toBe(true);
  });

  it('is true for the same instant and for a sub-second gap, false from one second on', () => {
    expect(hasUnknownPubDate({ firstPubDate: SYNC, createdAt: SYNC })).toBe(true);
    expect(hasUnknownPubDate({ firstPubDate: new Date(T0 + 300), createdAt: SYNC })).toBe(true);
    expect(hasUnknownPubDate({ firstPubDate: new Date(T0 + 999), createdAt: SYNC })).toBe(true);
    expect(hasUnknownPubDate({ firstPubDate: new Date(T0 + 1000), createdAt: SYNC })).toBe(false);
    expect(hasUnknownPubDate({ firstPubDate: new Date(T0 - 1000), createdAt: SYNC })).toBe(false);
  });

  it('is false for a real publication date', async () => {
    await seed([article('a1', { pubDate: ago(3) })]);

    expect(hasUnknownPubDate(await row('a1'))).toBe(false);
  });
});

describe('siblingIsReadable', () => {
  const anchor = { firstPubDate: new Date(T0 - 3 * HOUR), createdAt: SYNC };
  const at = (hoursAgo: number) => ({ firstPubDate: new Date(T0 - hoursAgo * HOUR), createdAt: SYNC });

  it('admits a sibling published before the anchor, or at the same instant', () => {
    expect(siblingIsReadable(anchor, at(6))).toBe(true);
    expect(siblingIsReadable(anchor, at(3))).toBe(true);
  });

  // The decided rule: newer coverage is never read for this suggestion, and the skip is permanent.
  it('skips a sibling published after the anchor', () => {
    expect(siblingIsReadable(anchor, at(1))).toBe(false);
  });

  // Siblings land in one batch with one createdAt, so a gate written against createdAt would admit all.
  it('compares publication time with publication time, not with the shared sync time', () => {
    expect(siblingIsReadable(anchor, at(1))).toBe(false);
    expect(siblingIsReadable({ ...anchor, createdAt: new Date(T0 + DAY) }, at(1))).toBe(false);
  });

  it('skips a sibling whose publication date is unknown', () => {
    expect(siblingIsReadable(anchor, { firstPubDate: SYNC, createdAt: SYNC })).toBe(false);
  });
});

describe('clusterIdsForRow', () => {
  // STABLE ids only. A raw clusterId is a per-run HDBSCAN label in a different namespace from
  // stable_cluster_id, so including one would widen the query with a value that can never match.
  it('is the stable id plus every membership STABLE id, and no raw clusterId', async () => {
    await seed(
      [
        article('a1', {
          clusters: [
            { clusterId: 'raw-1', confidence: 0.9, stableClusterId: 'stable-2' },
            { clusterId: 'raw-2', confidence: 0.4 },
          ] as never,
        }),
      ],
      { stable: { a1: 'stable-1' } },
    );

    expect(new Set(clusterIdsForRow(await row('a1')))).toEqual(new Set(['stable-1', 'stable-2']));
  });

  it('lists a stable id once', async () => {
    await seed([article('a1', { clusters: [{ clusterId: 'raw-1', confidence: 0.9, stableClusterId: 'stable-1' }] as never })], {
      stable: { a1: 'stable-1' },
    });

    expect(clusterIdsForRow(await row('a1'))).toEqual(['stable-1']);
  });

  it('is empty when the row belongs to no stable cluster', async () => {
    await seed([article('a1')]);

    expect(clusterIdsForRow(await row('a1'))).toEqual([]);
  });

  it('survives a malformed membership blob', async () => {
    // No service writes a corrupt blob (persist always stringifies a list), so this is a bare row.
    await bareRow('bad', { stableClusterId: 'story-1', clusterMembershipsJson: '{broken' });

    expect(clusterIdsForRow(await row('bad'))).toEqual(['story-1']);
  });
});

describe('findSubscribedSiblings', () => {
  it('returns a subscribed publication\'s article in the same story', async () => {
    await subscribe();
    await seed([member('anchor', 'NOS', 1), member('sib', 'Het Parool', 4)], inStory('anchor', 'sib'));

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual(['sib']);
  });

  it('never returns the anchor itself, even from a subscribed publication', async () => {
    await subscribe();
    await seed([member('anchor', 'Het Parool', 1)], inStory('anchor'));

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
  });

  it('excludes a sibling from a publication the reader is not subscribed to', async () => {
    await subscribe();
    await seed([member('anchor', 'NOS', 1), member('other', 'De Telegraaf', 4)], inStory('anchor', 'other'));

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
  });

  it('excludes a sibling in a different story', async () => {
    await subscribe();
    await seed([member('anchor', 'NOS', 1), member('elsewhere', 'Het Parool', 4)], {
      stable: { anchor: 'story-1', elsewhere: 'story-2' },
    });

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
  });

  it('excludes a sibling published after the anchor', async () => {
    await subscribe();
    await seed([member('anchor', 'NOS', 3), member('newer', 'Het Parool', 1)], inStory('anchor', 'newer'));

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
  });

  // The anchor is as new as can be, so an undated sibling (publication date = sync time = now) would
  // pass the "not newer than the anchor" rule on its own: only the unknown-date rule keeps it out.
  it('excludes a sibling whose publication date is unknown', async () => {
    await subscribe();
    await seed(
      [member('anchor', 'NOS', 0), member('undated', 'Het Parool', 5, { pubDate: 'not-a-date' })],
      inStory('anchor', 'undated'),
    );

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
  });

  it('orders newest publication first', async () => {
    await subscribe();
    await seed(
      [member('anchor', 'NOS', 1), member('older', 'Het Parool', 6), member('newer', 'Het Parool', 3)],
      inStory('anchor', 'older', 'newer'),
    );

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual(['newer', 'older']);
  });

  it('matches a SOURCE name that is not the publisher\'s own, normalised', async () => {
    await subscribe('Mediahuis', ['Het Parool', 'Parool Weekend']);
    await seed(
      [member('anchor', 'NOS', 1), member('sib', '  HET   PAROOL ', 4), member('weekend', 'parool weekend', 5)],
      inStory('anchor', 'sib', 'weekend'),
    );

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual(['sib', 'weekend']);
  });

  it('forgets a publication once its subscription is cancelled', async () => {
    const sub = await subscribe();
    await seed([member('anchor', 'NOS', 1), member('sib', 'Het Parool', 4)], inStory('anchor', 'sib'));
    await cancelSubscription(sub.id);

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
  });

  it('finds nothing when nothing is subscribed', async () => {
    await seed([member('anchor', 'NOS', 1), member('sib', 'Het Parool', 4)], inStory('anchor', 'sib'));

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
    expect(idsOf(await findSubscribedSiblings(await row('anchor'), new Set()))).toEqual([]);
  });

  it('takes the subscribed names it is given instead of resolving them', async () => {
    await seed([member('anchor', 'NOS', 1), member('sib', 'Het Parool', 4)], inStory('anchor', 'sib'));

    expect(idsOf(await findSubscribedSiblings(await row('anchor'), new Set(['het parool'])))).toEqual(['sib']);
  });

  it('finds nothing for an anchor that belongs to no stable cluster', async () => {
    await subscribe();
    await seed([member('anchor', 'NOS', 1), member('sib', 'Het Parool', 4)], { stable: { sib: 'story-1' } });

    expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
  });

  describe('stable ids, not raw cluster ids', () => {
    // The anchor and the sibling share a RAW HDBSCAN label ("c-7", a different run's label can reuse
    // it) but sit in different stable stories. They are not the same story.
    it('does not match on a shared raw clusterId', async () => {
      await subscribe();
      await seed(
        [
          member('anchor', 'NOS', 1, { clusters: [{ clusterId: 'c-7', confidence: 0.9, stableClusterId: 's-anchor' }] as never }),
          member('sib', 'Het Parool', 4, { clusters: [{ clusterId: 'c-7', confidence: 0.9, stableClusterId: 's-other' }] as never }),
        ],
        { stable: { anchor: 's-anchor', sib: 's-other' } },
      );

      expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
    });

    it('does not match a sibling whose stable_cluster_id column holds a raw id', async () => {
      await subscribe();
      await seed(
        [member('anchor', 'NOS', 1, { clusters: [{ clusterId: 'c-7', confidence: 0.9, stableClusterId: 's-anchor' }] as never }), member('sib', 'Het Parool', 4)],
        { stable: { anchor: 's-anchor', sib: 'c-7' } },
      );

      expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
    });

    it('matches through a membership\'s stable id when the anchor\'s own column names another story', async () => {
      await subscribe();
      await seed(
        [
          member('anchor', 'NOS', 1, { clusters: [{ clusterId: 'c-1', confidence: 0.9, stableClusterId: 'shared' }] as never }),
          member('sib', 'Het Parool', 4),
        ],
        { stable: { anchor: 'anchor-column', sib: 'shared' } },
      );

      expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual(['sib']);
    });

    // Documented limitation: matching is on the INDEXED column only, because the membership list is JSON.
    // A sibling whose stable_cluster_id is null is never a candidate, even when its memberships overlap.
    // persist fills the column from the first membership that has a stable id, so a row that has one and a
    // null column cannot be written any more (a row from before the column existed): a bare row.
    it('does not find a sibling whose stable_cluster_id column is null, even if its memberships overlap', async () => {
      await subscribe();
      await seed([member('anchor', 'NOS', 1)], { stable: { anchor: 'story-1' } });
      await bareRow('sib', {
        publicationName: 'Het Parool',
        firstPubDate: new Date(T0 - 4 * HOUR),
        stableClusterId: null,
        clusterMembershipsJson: JSON.stringify([{ clusterId: 'c-1', confidence: 0.9, stableClusterId: 'story-1' }]),
      });

      expect(idsOf(await findSubscribedSiblings(await row('anchor')))).toEqual([]);
    });
  });
});

describe('findPrimarySubscribedSibling', () => {
  it('picks the newest readable sibling', async () => {
    await subscribe();
    await seed(
      [member('anchor', 'NOS', 1), member('older', 'Het Parool', 6), member('newer', 'Het Parool', 3)],
      inStory('anchor', 'older', 'newer'),
    );

    expect((await findPrimarySubscribedSibling(await row('anchor')))?.id).toBe('newer');
  });

  it('is null when there is none', async () => {
    await subscribe();
    await seed([member('anchor', 'NOS', 1)], inStory('anchor'));

    expect(await findPrimarySubscribedSibling(await row('anchor'))).toBeNull();
  });
});

describe('getSubscribedCoverageForArticle', () => {
  async function story() {
    await subscribe();
    await seed(
      [
        member('anchor', 'NOS', 1),
        member('sib', 'Het Parool', 4, { title_en: 'Parool covers it', article_url: 'https://parool/sib', image_url: 'https://parool/sib.png' }),
      ],
      inStory('anchor', 'sib'),
    );
  }

  it('resolves the block: the primary sibling and no read until one is written', async () => {
    await story();

    expect(await getSubscribedCoverageForArticle('anchor')).toEqual({
      siblingId: 'sib',
      publicationName: 'Het Parool',
      titleEn: 'Parool covers it',
      articleUrl: 'https://parool/sib',
      imageUrl: 'https://parool/sib.png',
      firstPubDate: new Date(T0 - 4 * HOUR),
      read: null,
    });
  });

  it('carries the read once saveSubscriptionRead wrote it onto the anchor', async () => {
    await story();

    await saveSubscriptionRead('anchor', 'Focuses on the coalition talks.');

    expect((await getSubscribedCoverageForArticle('anchor'))?.read).toBe('Focuses on the coalition talks.');
  });

  it('finds the anchor by article id when the row id is a different identifier', async () => {
    await subscribe();
    await seed([member('sib', 'Het Parool', 4)], inStory('sib'));
    // Persist keys a row by its article id, so a row whose id differs from its article id is a bare row.
    await bareRow('server-id', { articleId: 'art-9', stableClusterId: 'story-1', firstPubDate: new Date(T0 - HOUR) });

    expect((await getSubscribedCoverageForArticle('art-9'))?.siblingId).toBe('sib');
  });

  it('is null when there is nothing to show: no id, no row, no subscribed sibling', async () => {
    await subscribe();
    await seed([member('alone', 'NOS', 1)], inStory('alone'));

    expect(await getSubscribedCoverageForArticle('')).toBeNull();
    expect(await getSubscribedCoverageForArticle('missing')).toBeNull();
    expect(await getSubscribedCoverageForArticle('alone')).toBeNull();
  });

  it('is null rather than a thrown error when a read fails: it renders in article detail', async () => {
    await story();
    failNextQuery('user_publication_subscriptions');

    expect(await getSubscribedCoverageForArticle('anchor')).toBeNull();
  });
});

describe('saveSubscriptionRead', () => {
  it('writes the read and its time onto the ANCHOR row', async () => {
    await seed([article('anchor')]);
    jest.setSystemTime(T0 + HOUR);

    await saveSubscriptionRead('anchor', 'Focuses on the coalition talks.');

    expect(await row('anchor')).toMatchObject({
      subscriptionRead: 'Focuses on the coalition talks.',
      subscriptionReadAt: T0 + HOUR,
    });
  });

  it('rejects for an anchor that is not there', async () => {
    await expect(saveSubscriptionRead('gone', 'x')).rejects.toThrow();
  });
});
