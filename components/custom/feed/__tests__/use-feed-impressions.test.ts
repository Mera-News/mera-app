// use-feed-impressions — the pure viewability filter. The DB service + viewed
// store are mocked so importing the module doesn't pull in WatermelonDB.

jest.mock('@/lib/database/services/story-impression-service', () => ({
  recordImpression: jest.fn(),
}));
jest.mock('@/lib/stores/viewed-stories-store', () => ({
  useViewedStoriesStore: { getState: () => ({ markViewed: jest.fn() }) },
}));

import type { ViewToken } from 'react-native';
import { collectNewlyViewed } from '../use-feed-impressions';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';

function item(id: string): FeedListItem {
  return { id, suggestion: { articleId: id } as any, memberCount: 1, breaking: false, score: 1 };
}

function tok(isViewable: boolean, it: FeedListItem | null): ViewToken {
  return { isViewable, item: it, key: it?.id ?? 'x', index: 0 } as unknown as ViewToken;
}

describe('collectNewlyViewed', () => {
  it('keeps only viewable, non-null items not already seen', () => {
    const seen = new Set<string>(['seen1']);
    const changed = [
      tok(true, item('a')),
      tok(false, item('b')), // not viewable
      tok(true, null), // null item
      tok(true, item('seen1')), // already seen
      tok(true, item('c')),
    ];
    const res = collectNewlyViewed(changed, seen);
    expect(res.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('returns an empty list when nothing new is viewable', () => {
    expect(collectNewlyViewed([tok(false, item('a'))], new Set())).toEqual([]);
    expect(collectNewlyViewed([tok(true, item('a'))], new Set(['a']))).toEqual([]);
  });
});
