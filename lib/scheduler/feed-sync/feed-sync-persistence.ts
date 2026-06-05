import { getSetting, setSetting, deleteSetting } from '@/lib/database/services/setting-service';
import type { FeedSyncMachineSnapshot, FeedSyncState } from './feed-sync-types';
import { FEED_SYNC_MACHINE_KEY, STALE_MACHINE_AGE_MS } from './feed-sync-types';

export async function loadMachineSnapshot(): Promise<FeedSyncMachineSnapshot | null> {
  const raw = await getSetting(FEED_SYNC_MACHINE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FeedSyncMachineSnapshot;
  } catch {
    return null;
  }
}

export async function saveMachineSnapshot(snapshot: FeedSyncMachineSnapshot): Promise<void> {
  await setSetting(FEED_SYNC_MACHINE_KEY, JSON.stringify(snapshot));
}

export async function clearMachineSnapshot(): Promise<void> {
  await deleteSetting(FEED_SYNC_MACHINE_KEY);
}

/** Returns the persisted state if still valid (<2h old), null if stale or absent. */
export async function loadValidSnapshot(): Promise<FeedSyncMachineSnapshot | null> {
  const snap = await loadMachineSnapshot();
  if (!snap) return null;
  if (Date.now() - snap.startedAt > STALE_MACHINE_AGE_MS) {
    await clearMachineSnapshot();
    return null;
  }
  return snap;
}

export async function updateMachineState(state: FeedSyncState): Promise<void> {
  const existing = await loadMachineSnapshot();
  if (!existing) return;
  await saveMachineSnapshot({ ...existing, state });
}
