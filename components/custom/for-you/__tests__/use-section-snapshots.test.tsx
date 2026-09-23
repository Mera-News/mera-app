/* eslint-disable @typescript-eslint/no-require-imports */
// F20 (in-session half): a fact added in chat changed neither of the Dashboard's
// old reload triggers, so its new topics were unknown to the section selector
// until a restart.
import { BehaviorSubject } from 'rxjs';

// BehaviorSubjects, like a WatermelonDB query: they emit on subscribe.
const mockFacts$ = new BehaviorSubject<unknown[]>([]);
const mockLocations$ = new BehaviorSubject<unknown[]>([]);
let mockFocused = true;
const mockLoad = jest.fn();

jest.mock('@/lib/database/services/fact-service', () => ({ observeFacts: () => mockFacts$ }));
jest.mock('@/lib/database/services/location-service', () => ({ observeAll: () => mockLocations$ }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/stores/section-snapshots', () => ({ loadSectionSnapshots: () => mockLoad() }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused }));

import { act, renderHook } from '@testing-library/react-native';
import { SNAPSHOT_RELOAD_DEBOUNCE_MS, useSectionSnapshots } from '../use-section-snapshots';

beforeEach(() => {
  jest.useFakeTimers();
  mockFocused = true;
  mockLoad.mockReset();
  mockLoad.mockResolvedValue({ topics: new Map() });
});
afterEach(() => jest.useRealTimers());

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useSectionSnapshots', () => {
  it('loads once on mount, not again for the streams\' emit-on-subscribe', async () => {
    renderHook(() => useSectionSnapshots('test'));
    await flush();
    act(() => {
      jest.advanceTimersByTime(SNAPSHOT_RELOAD_DEBOUNCE_MS * 2);
    });
    await flush();
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('reloads once after a burst of facts-table changes', async () => {
    renderHook(() => useSectionSnapshots('test'));
    await flush();
    act(() => {
      mockFacts$.next([]);
      mockFacts$.next([]);
      mockFacts$.next([]);
    });
    act(() => {
      jest.advanceTimersByTime(SNAPSHOT_RELOAD_DEBOUNCE_MS);
    });
    await flush();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it('reloads on a locations change', async () => {
    renderHook(() => useSectionSnapshots('test'));
    await flush();
    act(() => {
      mockLocations$.next([]);
      jest.advanceTimersByTime(SNAPSHOT_RELOAD_DEBOUNCE_MS);
    });
    await flush();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it('reloads when the screen regains focus, which catches topic-only edits', async () => {
    const { rerender } = renderHook(() => useSectionSnapshots('test'));
    await flush();
    mockFocused = false;
    rerender({});
    mockFocused = true;
    rerender({});
    await flush();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });

  it('does not load while blurred', async () => {
    mockFocused = false;
    renderHook(() => useSectionSnapshots('test'));
    await flush();
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

describe('both section screens read the fresh snapshots', () => {
  it('neither screen loads the snapshots itself any more', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['ForYouScreen.tsx', 'FactFeedScreen.tsx']) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      expect({ file, direct: /loadSectionSnapshots\(/.test(src), hook: /useSectionSnapshots\(/.test(src) }).toEqual({
        file,
        direct: false,
        hook: true,
      });
    }
  });
});
