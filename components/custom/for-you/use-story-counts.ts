// use-story-counts — "N stories for you, and you've read R": the counts
// card's stories, counted the way the Continuous Feed lists them.
//
// The other clauses (published, analysed) are ARTICLES over 24 hours
// (use-feed-counts). These two are STORIES over the Feed's own window: 48 hours,
// and up to 7 days for an unread High or Emergency story (the reader's keep),
// from the Feed's own selector, so the number is the scored cards the reader
// can scroll to. Rows Mera has not read (the not-read tail) are not counted.
//
// Limits, accepted: the context is null, so a muted publication's rows count
// until its purge runs (after its toast); and the count follows the live pool,
// while a reading session keeps its cards until the next session.
//
// Cost: one Feed list build per change of the suggestion pool, the opened
// set, the Feed algorithm or the minute, shared by every caller.

import { buildReadSnapshot } from '@/lib/feed-ordering/read-snapshot';
import { readOptionsOf, type FeedAlgoPrefs } from '@/lib/feed-ordering/feed-algo';
import { useCountsMinute } from '@/lib/hooks/use-feed-counts';
import { buildFeedList } from '@/lib/stores/feed-list-selector';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useForYouSuggestions } from '@/lib/stores/selectors';
import { useFeedAlgo } from '@/components/custom/feed/feed-view-prefs';

export interface StoryCounts {
  /** Scored stories the Feed lists for the reader. */
  storyCount: number;
  /** Of those, stories with any copy the reader opened. */
  storyReadCount: number;
}

const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

export function computeStoryCounts(
  suggestions: ForYouSuggestion[],
  opts: { nowMs: number; openedArticleIds: ReadonlySet<string>; algo: FeedAlgoPrefs },
): StoryCounts {
  const read = buildReadSnapshot(
    useFeedOrderStore.getState().cardStates,
    useOpenedStoriesStore.getState().ids,
    suggestions,
    readOptionsOf(opts.algo),
  );
  const stories = buildFeedList(suggestions, NO_EXCLUSIONS as Set<string>, opts.nowMs, null, {
    includeReasonPending: true,
    read,
  });
  let storyReadCount = 0;
  for (const it of stories) if (it.memberIds.some((id) => opts.openedArticleIds.has(id))) storyReadCount++;
  return { storyCount: stories.length, storyReadCount };
}

let memo: {
  suggestions: unknown;
  opened: unknown;
  algo: unknown;
  minute: number;
  result: StoryCounts;
} | null = null;

/** Exported for tests only: forget the shared result between cases. */
export function resetStoryCountsMemoForTest(): void {
  memo = null;
}

export function useStoryCounts(): StoryCounts {
  const suggestions = useForYouSuggestions();
  const opened = useOpenedStoriesStore((s) => s.articleIds);
  const algo = useFeedAlgo();
  const minute = useCountsMinute();
  if (memo && memo.suggestions === suggestions && memo.opened === opened && memo.algo === algo && memo.minute === minute) {
    return memo.result;
  }
  const result = computeStoryCounts(suggestions, { nowMs: minute, openedArticleIds: opened, algo });
  memo = { suggestions, opened, algo, minute, result };
  return result;
}
