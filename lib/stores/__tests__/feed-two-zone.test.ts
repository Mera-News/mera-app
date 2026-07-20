// feed-two-zone — pure tests for buildTwoZoneListData + zoneOneSectionDescriptors.
// SelectSectionsResults are hand-crafted (grouping/sectioning is already covered
// by feed-sections-selector.test) so each watermark/opened rule is isolated. The
// DB module is mocked because importing the adapter pulls in the persona services.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import {
  buildTwoZoneListData,
  zoneOneSectionDescriptors,
  EARLIER_TOP_N,
  EARLIER_EXPANSION_KEY,
} from '../feed-sections-selector';
import type { ForYouSuggestion, ClusterMembership } from '../for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type {
  SelectSectionsResult,
  SectionGroup,
  FeedSection,
  BreakingItem,
} from '@/lib/news-harness/feed-select';

const WM = Date.parse('2024-06-15T00:00:00.000Z');
const NEW_ISO = '2024-06-20T00:00:00.000Z'; // > watermark
const OLD_ISO = '2024-06-10T00:00:00.000Z'; // < watermark

function row(id: string, o: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: id,
    articleId: `art-${id}`,
    clusters: [],
    relevance: 0.6,
    reason: '',
    status: ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: null,
    publication_name: null,
    title_en: id,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: NEW_ISO,
    firstPubDate: NEW_ISO,
    rawScore: 0.6,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    ...o,
  };
}

function clu(stableClusterId: string): ClusterMembership {
  return { clusterId: `c-${stableClusterId}`, confidence: 0.9, stableClusterId };
}

function grp(repId: string, memberIds: string[], rawScore: number | null = 0.6): SectionGroup {
  return { representativeId: repId, memberIds, rawScore, bucket: 'MEDIUM' };
}

function factSection(key: string, groups: SectionGroup[], factId = key.replace('fact:', '')): FeedSection {
  return { key, kind: 'fact', title: key, weight: 1, factId, groups };
}

function byIdOf(rows: ForYouSuggestion[]): Map<string, ForYouSuggestion> {
  return new Map(rows.map((r) => [r._id, r]));
}

describe('buildTwoZoneListData — earliest-member watermark rule', () => {
  it('splits a section into a new (zone 1) group and an earlier (zone 2) group', () => {
    const rows = [row('a', { createdAt: NEW_ISO }), row('b', { createdAt: OLD_ISO })];
    const result: SelectSectionsResult = {
      breaking: [],
      sections: [factSection('fact:f1', [grp('a', ['a']), grp('b', ['b'])])],
    };
    const items = buildTwoZoneListData(result, new Set(), byIdOf(rows), new Map(), WM, new Set());

    // Zone 1: fact-header + the new card 'a'.
    expect(items.some((i) => i.type === 'fact-header')).toBe(true);
    const cards = items.filter((i) => i.type === 'suggestion-card');
    expect(cards.map((c) => (c.type === 'suggestion-card' ? c.data._id : ''))).toEqual(['a']);
    // Divider + earlier card 'b' in zone 2.
    const divider = items.find((i) => i.type === 'caught-up-divider');
    expect(divider && divider.type === 'caught-up-divider' && divider.variant).toBe('normal');
    const earlier = items.filter((i) => i.type === 'earlier-card');
    expect(earlier.map((e) => e.key)).toEqual(['earlier:b']);
  });

  it('sends a NEW sibling of an already-seen story to Earlier (earliest member wins)', () => {
    // Group g has an OLD member + a NEW member → earliest = OLD < watermark → Earlier.
    const rows = [row('old', { createdAt: OLD_ISO }), row('new', { createdAt: NEW_ISO })];
    const result: SelectSectionsResult = {
      breaking: [],
      sections: [factSection('fact:f1', [grp('old', ['old', 'new'])])],
    };
    const items = buildTwoZoneListData(result, new Set(), byIdOf(rows), new Map(), WM, new Set());

    expect(items.some((i) => i.type === 'suggestion-card')).toBe(false); // nothing new in zone 1
    const divider = items.find((i) => i.type === 'caught-up-divider');
    // No new section cards → empty-new variant.
    expect(divider && divider.type === 'caught-up-divider' && divider.variant).toBe('empty-new');
    const earlier = items.filter((i) => i.type === 'earlier-card');
    expect(earlier.map((e) => e.key)).toEqual(['earlier:old']);
  });
});

describe('buildTwoZoneListData — breaking + divider', () => {
  it('breaking strip ALWAYS renders, ignoring the watermark, and is not duplicated in zone 2', () => {
    const rows = [row('bk', { createdAt: OLD_ISO })];
    const breaking: BreakingItem[] = [
      { representativeId: 'bk', memberIds: ['bk'], rawScore: 1.2, bucket: 'EMERGENCY' },
    ];
    const result: SelectSectionsResult = { breaking, sections: [] };
    const items = buildTwoZoneListData(result, new Set(), byIdOf(rows), new Map(), WM, new Set());

    expect(items[0].type).toBe('breaking-strip');
    // Old breaking rep is not also an earlier-card (breaking lives only in the strip).
    expect(items.some((i) => i.type === 'earlier-card')).toBe(false);
    // No sections + no earlier → no divider.
    expect(items.some((i) => i.type === 'caught-up-divider')).toBe(false);
  });

  it('omits the divider entirely when zone 2 is empty (everything is new)', () => {
    const rows = [row('a', { createdAt: NEW_ISO }), row('b', { createdAt: NEW_ISO })];
    const result: SelectSectionsResult = {
      breaking: [],
      sections: [factSection('fact:f1', [grp('a', ['a']), grp('b', ['b'])])],
    };
    const items = buildTwoZoneListData(result, new Set(), byIdOf(rows), new Map(), WM, new Set());
    expect(items.some((i) => i.type === 'caught-up-divider')).toBe(false);
    expect(items.some((i) => i.type === 'earlier-card')).toBe(false);
    expect(items.filter((i) => i.type === 'suggestion-card')).toHaveLength(2);
  });
});

describe('buildTwoZoneListData — Earlier zone ordering, top-N, expansion', () => {
  function earlierResult(): { result: SelectSectionsResult; byId: Map<string, ForYouSuggestion> } {
    // 12 earlier groups with ascending-then-scrambled rawScore; all OLD.
    const rows: ForYouSuggestion[] = [];
    const groups: SectionGroup[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `e${i}`;
      rows.push(row(id, { createdAt: OLD_ISO, rawScore: i / 100 }));
      groups.push(grp(id, [id], i / 100));
    }
    return {
      result: { breaking: [], sections: [factSection('fact:f1', groups)] },
      byId: byIdOf(rows),
    };
  }

  it('orders earlier cards by rawScore desc and caps at EARLIER_TOP_N with a show-more', () => {
    const { result, byId } = earlierResult();
    const items = buildTwoZoneListData(result, new Set(), byId, new Map(), WM, new Set());

    const earlier = items.filter((i) => i.type === 'earlier-card');
    expect(earlier).toHaveLength(EARLIER_TOP_N);
    // Highest rawScore (e11 = 0.11) first, descending.
    expect(earlier[0].key).toBe('earlier:e11');
    expect(earlier[1].key).toBe('earlier:e10');

    const showMore = items.find((i) => i.type === 'earlier-show-more');
    expect(showMore && showMore.type === 'earlier-show-more' && showMore.count).toBe(12 - EARLIER_TOP_N);
    const divider = items.find((i) => i.type === 'caught-up-divider');
    expect(divider && divider.type === 'caught-up-divider' && divider.earlierCount).toBe(12);
  });

  it('expanding the Earlier zone reveals all cards and drops the show-more', () => {
    const { result, byId } = earlierResult();
    const items = buildTwoZoneListData(
      result,
      new Set([EARLIER_EXPANSION_KEY]),
      byId,
      new Map(),
      WM,
      new Set(),
    );
    expect(items.filter((i) => i.type === 'earlier-card')).toHaveLength(12);
    expect(items.some((i) => i.type === 'earlier-show-more')).toBe(false);
  });
});

describe('buildTwoZoneListData — opened flags', () => {
  it('flags an earlier card opened via article id OR stable cluster id', () => {
    const rows = [
      row('x', { createdAt: OLD_ISO }), // opened by article id
      row('y', { createdAt: OLD_ISO, clusters: [clu('SY')] }), // opened by stable cluster id
      row('z', { createdAt: OLD_ISO }), // not opened
    ];
    const result: SelectSectionsResult = {
      breaking: [],
      sections: [factSection('fact:f1', [grp('x', ['x']), grp('y', ['y']), grp('z', ['z'])])],
    };
    const openedSet = new Set(['art-x', 'SY']);
    const items = buildTwoZoneListData(result, new Set(), byIdOf(rows), new Map(), WM, openedSet);

    const opened = new Map(
      items
        .filter((i) => i.type === 'earlier-card')
        .map((i) => (i.type === 'earlier-card' ? [i.data._id, i.opened] : ['', false])),
    );
    expect(opened.get('x')).toBe(true);
    expect(opened.get('y')).toBe(true);
    expect(opened.get('z')).toBe(false);
  });
});

describe('zoneOneSectionDescriptors', () => {
  it('returns only sections with new groups, with new-group counts', () => {
    const rows = [
      row('a', { createdAt: NEW_ISO }),
      row('b', { createdAt: NEW_ISO }),
      row('c', { createdAt: OLD_ISO }),
      row('d', { createdAt: OLD_ISO }),
    ];
    const result: SelectSectionsResult = {
      breaking: [],
      sections: [
        factSection('fact:new', [grp('a', ['a']), grp('b', ['b'])]),
        factSection('fact:old', [grp('c', ['c']), grp('d', ['d'])]),
      ],
    };
    const descriptors = zoneOneSectionDescriptors(result, byIdOf(rows), WM);
    expect(descriptors).toEqual([{ key: 'fact:new', title: 'fact:new', kind: 'fact', count: 2 }]);
  });
});
