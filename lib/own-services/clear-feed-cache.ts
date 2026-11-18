import { clearFeedCacheAndResync as clearLocalFeedCache } from '@/lib/services/clear-feed-cache';
import { podPaired } from './pod-state';

// Paired, the feed lives on the server: ask it to read again and pull every table.
export async function clearFeedCacheAndResync(): Promise<void> {
  if (!podPaired()) return clearLocalFeedCache();
  const { refreshFromPod } = await import('./pod-runner');
  return refreshFromPod();
}
