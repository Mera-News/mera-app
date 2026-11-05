// "Clear reading history": the local log of opened articles, which is two tables
// and the feed's memory mirror of one of them. The modal promises the log goes,
// so the read filter and read ticks start over: a story already filtered as read
// stays terminal, and a later copy of it can reach the Feed again.
import { clearAllVisits } from '@/lib/database/services/publication-visit-service';
import { clearAllImpressions } from '@/lib/database/services/story-impression-service';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';

export async function clearReadingHistory(): Promise<void> {
    await clearAllVisits();
    await clearAllImpressions();
    useOpenedStoriesStore.getState().clear();
}
