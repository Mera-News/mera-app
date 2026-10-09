// feed-sync-persistence against the real `settings` table: the machine snapshot round trip, the
// stale-snapshot rule on a fake clock, and updateMachineState.
// Replaces lib/scheduler/feed-sync/__tests__/feed-sync-persistence.test.ts.
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  clearMachineSnapshot,
  loadMachineSnapshot,
  loadValidSnapshot,
  saveMachineSnapshot,
  updateMachineState,
} from '@/lib/scheduler/feed-sync/feed-sync-persistence';
import {
  FEED_SYNC_MACHINE_KEY,
  STALE_MACHINE_AGE_MS,
  type FeedSyncMachineSnapshot,
} from '@/lib/scheduler/feed-sync/feed-sync-types';
import { useFakeClock } from '@/test/helpers';

const NOW = new Date('2026-10-09T10:00:00.000Z').getTime();
const snapshot = (over: Partial<FeedSyncMachineSnapshot> = {}): FeedSyncMachineSnapshot => ({
  state: 'hydrating',
  startedAt: NOW - 1000,
  ...over,
});

beforeEach(() => useFakeClock(NOW));

describe('the snapshot row', () => {
  it('round-trips through the settings table under the machine key', async () => {
    const snap = snapshot({ state: 'failed', errorCode: 'offline' });

    await saveMachineSnapshot(snap);

    expect(JSON.parse((await getSetting(FEED_SYNC_MACHINE_KEY))!)).toEqual(snap);
    expect(await loadMachineSnapshot()).toEqual(snap);
  });

  it('overwrites the previous snapshot rather than adding a second', async () => {
    await saveMachineSnapshot(snapshot({ state: 'diffing' }));
    await saveMachineSnapshot(snapshot({ state: 'done' }));

    expect((await loadMachineSnapshot())!.state).toBe('done');
  });

  it('loads null when nothing is stored', async () => {
    expect(await loadMachineSnapshot()).toBeNull();
  });

  it('loads null for a row that is not JSON', async () => {
    await setSetting(FEED_SYNC_MACHINE_KEY, 'not-valid-json{{{');

    expect(await loadMachineSnapshot()).toBeNull();
  });

  it('clearing deletes the row', async () => {
    await saveMachineSnapshot(snapshot());

    await clearMachineSnapshot();

    expect(await getSetting(FEED_SYNC_MACHINE_KEY)).toBeNull();
    expect(await loadMachineSnapshot()).toBeNull();
  });
});

describe('loadValidSnapshot', () => {
  it('returns null when nothing is stored', async () => {
    expect(await loadValidSnapshot()).toBeNull();
  });

  it('returns a snapshot younger than STALE_MACHINE_AGE_MS and leaves the row alone', async () => {
    const fresh = snapshot({ startedAt: NOW - STALE_MACHINE_AGE_MS + 60_000 });
    await saveMachineSnapshot(fresh);

    expect(await loadValidSnapshot()).toEqual(fresh);
    expect(await getSetting(FEED_SYNC_MACHINE_KEY)).not.toBeNull();
  });

  it('rejects a snapshot older than STALE_MACHINE_AGE_MS and deletes its row', async () => {
    await saveMachineSnapshot(snapshot({ startedAt: NOW - STALE_MACHINE_AGE_MS - 60_000 }));

    expect(await loadValidSnapshot()).toBeNull();
    expect(await getSetting(FEED_SYNC_MACHINE_KEY)).toBeNull();
  });

  it('turns stale as the clock moves on, not at save time', async () => {
    await saveMachineSnapshot(snapshot({ startedAt: Date.now() }));
    expect(await loadValidSnapshot()).not.toBeNull();

    jest.setSystemTime(Date.now() + STALE_MACHINE_AGE_MS + 60_000);

    expect(await loadValidSnapshot()).toBeNull();
  });
});

describe('updateMachineState', () => {
  it('writes nothing when there is no snapshot to update', async () => {
    await updateMachineState('diffing');

    expect(await getSetting(FEED_SYNC_MACHINE_KEY)).toBeNull();
  });

  it('replaces the state and keeps startedAt and errorCode', async () => {
    await saveMachineSnapshot(snapshot({ state: 'failed', errorCode: 'offline', startedAt: NOW - 5000 }));

    await updateMachineState('idle');

    expect(await loadMachineSnapshot()).toEqual({ state: 'idle', startedAt: NOW - 5000, errorCode: 'offline' });
  });
});
