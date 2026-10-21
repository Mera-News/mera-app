// Discarded by Mera: the Show filter's stories Mera read and scored below the
// gate. Never under All, never persisted, counted from the same selectors.
import {
  applyFeedShow,
  buildDiscardedStories,
  FEED_SHOWS,
  feedShowCounts,
  foldNotReadTail,
  formatShowCount,
  newNotReadTailSession,
  TAIL_RENDER_CAP,
} from '@/components/custom/feed/not-read-tail';
import { parseFeedShow } from '@/components/custom/feed/feed-view-prefs';
import { isNotRead } from '@/lib/feed-ordering/pending-visibility';
import { ArticleSuggestionStatus as S } from '@/lib/database/article-suggestion-status';
import { buildFeedList } from '@/lib/stores/feed-list-selector';
import type { ClusterMembership, ForYouSuggestion } from '@/lib/stores/for-you-store';

// feed-view-prefs logs through Sentry, which does not load under node.
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

const NOW = 1_000_000_000_000;
const H = 3_600_000;

let seq = 0;
function sugg(o: Partial<ForYouSuggestion> & { ageH?: number } = {}): ForYouSuggestion {
  seq += 1;
  const id = o._id ?? `s${seq}`;
  return {
    _id: id,
    articleId: o.articleId ?? id,
    clusters: o.clusters ?? [],
    relevance: o.relevance ?? 0.2,
    reason: o.reason ?? null,
    status: o.status ?? S.Complete,
    country_code: null,
    language_code: 'en',
    publication_name: o.publication_name ?? 'Pub',
    title_en: o.title_en ?? `${id}zq w${seq}a w${seq}b w${seq}c`,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(NOW - H).toISOString(),
    firstPubDate: new Date(NOW - (o.ageH ?? 1) * H).toISOString(),
    rawScore: 0.5,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    factIds: [],
    scoredAt: null,
  } as ForYouSuggestion;
}
const cluster = (id: string): ClusterMembership => ({ clusterId: `run-${id}`, confidence: 0.9, stableClusterId: id });
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('buildDiscardedStories', () => {
  it('holds rows Mera read below the gate: complete or reason_skipped, ineligible (relevance 0) included', () => {
    const pool = [
      sugg({ _id: 'low', relevance: 0.2 }),
      sugg({ _id: 'zero', relevance: 0 }),
      sugg({ _id: 'skipped', relevance: 0.3, status: S.ReasonSkipped }),
      sugg({ _id: 'pick', relevance: 0.6, reason: 'why' }),
      sugg({ _id: 'atGate', relevance: 0.4, reason: 'why' }),
      sugg({ _id: 'unscored', relevance: 0, status: S.Unscored }),
      sugg({ _id: 'pending', relevance: 0.2, status: S.ReasonPending }),
      sugg({ _id: 'excluded', relevance: 0, status: S.Excluded }),
      sugg({ _id: 'read', relevance: 0, status: S.AlreadyRead }),
    ];
    expect(ids(buildDiscardedStories(pool, null, NOW).rows).sort()).toEqual(['low', 'skipped', 'zero']);
  });

  it('stays inside the 48h window', () => {
    const pool = [sugg({ _id: 'in', ageH: 47 }), sugg({ _id: 'out', ageH: 49 })];
    expect(ids(buildDiscardedStories(pool, null, NOW).rows)).toEqual(['in']);
  });

  it('groups members of one story into one card, like the main list', () => {
    const pool = [
      sugg({ _id: 'a', clusters: [cluster('story')] }),
      sugg({ _id: 'b', clusters: [cluster('story')] }),
      sugg({ _id: 'c' }),
    ];
    const { rows, total } = buildDiscardedStories(pool, null, NOW);
    expect(total).toBe(2);
    expect(rows.find((r) => r.memberIds.includes('a'))?.memberCount).toBe(2);
  });

  it('is newest published first, capped, with the true count', () => {
    const pool = Array.from({ length: TAIL_RENDER_CAP + 3 }, (_, i) => sugg({ _id: `d${i}`, ageH: 1 + i * 0.1 }));
    const { rows, total } = buildDiscardedStories(pool, null, NOW);
    expect(rows).toHaveLength(TAIL_RENDER_CAP);
    expect(total).toBe(TAIL_RENDER_CAP + 3);
    expect(rows[0].id).toBe('d0');
    expect(rows[1].id).toBe('d1');
  });
});

describe('the Show segments over one pool', () => {
  const pool = [
    sugg({ _id: 'pick', relevance: 0.7, reason: 'why' }),
    sugg({ _id: 'unread', relevance: 0, status: S.Unscored }),
    sugg({ _id: 'gone', relevance: 0.1 }),
    sugg({ _id: 'gone0', relevance: 0 }),
  ];
  const candidates = buildFeedList(pool, new Set(), NOW, null, { includeReasonPending: true, includeUnscored: true });
  const scored = candidates.filter((c) => !isNotRead(c.suggestion));
  const folded = foldNotReadTail(newNotReadTailSession(), candidates);
  const discarded = buildDiscardedStories(pool, null, NOW).rows;

  it('All never contains a discarded row', () => {
    const all = ids(applyFeedShow(scored, folded.tail, 'all', discarded).rows);
    expect(all.sort()).toEqual(['pick', 'unread']);
    for (const d of discarded) expect(all).not.toContain(d.id);
  });

  it('Discarded by Mera renders only the discarded stories, with no picks before a divider', () => {
    const out = applyFeedShow(scored, folded.tail, 'discarded', discarded);
    expect(ids(out.rows).sort()).toEqual(['gone', 'gone0']);
    expect(out.picks).toBe(0);
  });

  it('each count is the number of rows that option renders', () => {
    const counts = feedShowCounts(scored, folded.tail, folded.capped, discarded, false);
    for (const show of FEED_SHOWS) {
      expect(counts[show].n).toBe(applyFeedShow(scored, folded.tail, show, discarded).rows.length);
    }
    expect(counts).toEqual({
      all: { n: 2, capped: false },
      picks: { n: 1, capped: false },
      unread: { n: 1, capped: false },
      discarded: { n: 2, capped: false },
    });
  });
});

describe('counts at the cap', () => {
  it('a full not-read tail marks All and Not read as capped; the label reads "200+"', () => {
    const many = Array.from({ length: TAIL_RENDER_CAP + 1 }, (_, i) =>
      sugg({ _id: `u${i}`, status: S.Unscored, relevance: 0, ageH: 1 + i * 0.1 }),
    );
    const candidates = buildFeedList(many, new Set(), NOW, null, { includeUnscored: true });
    const folded = foldNotReadTail(newNotReadTailSession(), candidates);
    expect(folded.capped).toBe(true);
    const counts = feedShowCounts([], folded.tail, folded.capped, [], false);
    expect(formatShowCount(counts.unread, String)).toBe(`${TAIL_RENDER_CAP}+`);
    expect(formatShowCount(counts.all, String)).toBe(`${TAIL_RENDER_CAP}+`);
    expect(formatShowCount(counts.picks, String)).toBe('0');
  });

  it('a tail exactly at the cap with nothing left out is not capped', () => {
    const exact = Array.from({ length: TAIL_RENDER_CAP }, (_, i) =>
      sugg({ _id: `e${i}`, status: S.Unscored, relevance: 0, ageH: 1 + i * 0.1 }),
    );
    const candidates = buildFeedList(exact, new Set(), NOW, null, { includeUnscored: true });
    expect(foldNotReadTail(newNotReadTailSession(), candidates).capped).toBe(false);
  });
});

describe('parseFeedShow', () => {
  it('keeps only picks across launches; discarded and unread open on All', () => {
    expect(parseFeedShow('picks')).toBe('picks');
    expect(parseFeedShow('discarded')).toBe('all');
    expect(parseFeedShow('unread')).toBe('all');
  });
});
