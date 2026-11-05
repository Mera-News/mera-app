// "Clear reading history" keeps the modal's promise: the local log of opened articles goes, both tables
// and the feed's memory mirror of them. A story already filtered as read stays terminal.
import { clearReadingHistory } from '@/components/custom/config-mera/clear-reading-history';
import { getAllVisitedArticles, recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { getOpenedSeenBreakdown, recordOpen } from '@/lib/database/services/story-impression-service';
import { loadReadStoryIndex } from '@/lib/feed-grouping/read-story-filter';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';

it('empties the opened log and the memory mirror, so the read filter knows nothing', async () => {
  await recordOpen({ articleId: 'a1', titleNorm: 'a headline', stableClusterId: 'c1', surface: 'feed' });
  useOpenedStoriesStore.getState().markOpened('a1', 'c1');
  await recordPublicationVisit({ articleId: 'a1', publicationName: 'De Volkskrant', countryCode: 'NL' });

  await clearReadingHistory();

  expect((await getOpenedSeenBreakdown()).stats.rowCount).toBe(0);
  expect((await loadReadStoryIndex()).impressionCount).toBe(0);
  expect(useOpenedStoriesStore.getState().ids.size).toBe(0);
  expect(useOpenedStoriesStore.getState().articleIds.size).toBe(0);
  expect(await getAllVisitedArticles()).toEqual([]);
});
