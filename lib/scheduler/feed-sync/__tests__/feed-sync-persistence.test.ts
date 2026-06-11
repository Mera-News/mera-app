// feed-sync-persistence.test.ts — tests for feed-sync-persistence helpers

const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
const mockDeleteSetting = jest.fn();

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...args: any[]) => mockGetSetting(...args),
  setSetting: (...args: any[]) => mockSetSetting(...args),
  deleteSetting: (...args: any[]) => mockDeleteSetting(...args),
}));

import {
  loadMachineSnapshot,
  saveMachineSnapshot,
  clearMachineSnapshot,
  loadValidSnapshot,
  updateMachineState,
} from '../feed-sync-persistence';
import { FEED_SYNC_MACHINE_KEY, STALE_MACHINE_AGE_MS } from '../feed-sync-types';
import type { FeedSyncMachineSnapshot } from '../feed-sync-types';

const NOW = 1_700_000_000_000;

function makeSnapshot(overrides: Partial<FeedSyncMachineSnapshot> = {}): FeedSyncMachineSnapshot {
  return {
    state: 'idle',
    startedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mockGetSetting.mockResolvedValue(null);
  mockSetSetting.mockResolvedValue(undefined);
  mockDeleteSetting.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('loadMachineSnapshot', () => {
  it('returns null when no setting exists', async () => {
    mockGetSetting.mockResolvedValue(null);
    const result = await loadMachineSnapshot();
    expect(result).toBeNull();
  });

  it('parses valid JSON snapshot', async () => {
    const snapshot = makeSnapshot({ state: 'hydrating', startedAt: NOW - 1000 });
    mockGetSetting.mockResolvedValue(JSON.stringify(snapshot));

    const result = await loadMachineSnapshot();
    expect(result).toEqual(snapshot);
  });

  it('returns null for invalid JSON (parse error)', async () => {
    mockGetSetting.mockResolvedValue('not-valid-json{{{');
    const result = await loadMachineSnapshot();
    expect(result).toBeNull();
  });

  it('loads from FEED_SYNC_MACHINE_KEY', async () => {
    await loadMachineSnapshot();
    expect(mockGetSetting).toHaveBeenCalledWith(FEED_SYNC_MACHINE_KEY);
  });

  it('preserves errorCode in snapshot', async () => {
    const snapshot = makeSnapshot({ state: 'failed', errorCode: 'offline' });
    mockGetSetting.mockResolvedValue(JSON.stringify(snapshot));

    const result = await loadMachineSnapshot();
    expect(result?.errorCode).toBe('offline');
  });
});

describe('saveMachineSnapshot', () => {
  it('serializes snapshot to JSON and saves via setSetting', async () => {
    const snapshot = makeSnapshot({ state: 'diffing' });
    await saveMachineSnapshot(snapshot);

    expect(mockSetSetting).toHaveBeenCalledWith(
      FEED_SYNC_MACHINE_KEY,
      JSON.stringify(snapshot),
    );
  });

  it('saves snapshot with errorCode', async () => {
    const snapshot = makeSnapshot({ state: 'failed', errorCode: 'auth-expired' });
    await saveMachineSnapshot(snapshot);

    const savedJson = mockSetSetting.mock.calls[0][1];
    const parsed = JSON.parse(savedJson);
    expect(parsed.errorCode).toBe('auth-expired');
  });
});

describe('clearMachineSnapshot', () => {
  it('deletes the machine snapshot setting', async () => {
    await clearMachineSnapshot();
    expect(mockDeleteSetting).toHaveBeenCalledWith(FEED_SYNC_MACHINE_KEY);
  });
});

describe('loadValidSnapshot', () => {
  it('returns null when no snapshot stored', async () => {
    mockGetSetting.mockResolvedValue(null);
    const result = await loadValidSnapshot();
    expect(result).toBeNull();
  });

  it('returns snapshot when it is fresh (within 2h)', async () => {
    const freshSnapshot = makeSnapshot({ startedAt: NOW - 1000 }); // 1s ago
    mockGetSetting.mockResolvedValue(JSON.stringify(freshSnapshot));

    const result = await loadValidSnapshot();
    expect(result).toEqual(freshSnapshot);
  });

  it('returns null and clears when snapshot is stale (> 2h)', async () => {
    const staleSnapshot = makeSnapshot({ startedAt: NOW - STALE_MACHINE_AGE_MS - 1 });
    mockGetSetting.mockResolvedValue(JSON.stringify(staleSnapshot));

    const result = await loadValidSnapshot();

    expect(result).toBeNull();
    expect(mockDeleteSetting).toHaveBeenCalledWith(FEED_SYNC_MACHINE_KEY);
  });

  it('returns null when snapshot is exactly at stale boundary (>= 2h)', async () => {
    const boundarySnapshot = makeSnapshot({ startedAt: NOW - STALE_MACHINE_AGE_MS - 1 });
    mockGetSetting.mockResolvedValue(JSON.stringify(boundarySnapshot));

    const result = await loadValidSnapshot();
    expect(result).toBeNull();
  });

  it('does not clear when snapshot is fresh (< 2h)', async () => {
    const freshSnapshot = makeSnapshot({ startedAt: NOW - STALE_MACHINE_AGE_MS + 1000 });
    mockGetSetting.mockResolvedValue(JSON.stringify(freshSnapshot));

    await loadValidSnapshot();
    expect(mockDeleteSetting).not.toHaveBeenCalled();
  });
});

describe('updateMachineState', () => {
  it('does nothing when no existing snapshot', async () => {
    mockGetSetting.mockResolvedValue(null);
    await updateMachineState('diffing');
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('updates state in existing snapshot without changing other fields', async () => {
    const existing = makeSnapshot({ state: 'fetching-topic-ids', startedAt: NOW - 5000 });
    mockGetSetting.mockResolvedValue(JSON.stringify(existing));

    await updateMachineState('diffing');

    const savedJson = mockSetSetting.mock.calls[0][1];
    const updated = JSON.parse(savedJson);
    expect(updated.state).toBe('diffing');
    expect(updated.startedAt).toBe(NOW - 5000);
  });

  it('preserves errorCode when updating state', async () => {
    const existing = makeSnapshot({ state: 'failed', errorCode: 'offline', startedAt: NOW });
    mockGetSetting.mockResolvedValue(JSON.stringify(existing));

    await updateMachineState('idle');

    const savedJson = mockSetSetting.mock.calls[0][1];
    const updated = JSON.parse(savedJson);
    expect(updated.errorCode).toBe('offline');
    expect(updated.state).toBe('idle');
  });
});

export {};
