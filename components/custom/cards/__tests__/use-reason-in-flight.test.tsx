// useReasonWriting — the Feed card may say "Writing a note" only while the row's
// reasons are in flight, and never past the backstop counted from the FIRST time
// this process saw it in flight (not from `scoredAt`, which a background run
// sets hours before anyone looks).
/* eslint-disable @typescript-eslint/no-require-imports */

import { act, renderHook } from '@testing-library/react-native';

let mockInFlight: ReadonlySet<string> = new Set();
const mockListeners = new Set<() => void>();
// A minimal selector store: the real one reaches the database at import time.
jest.mock('@/lib/stores/for-you-store', () => {
  const { useSyncExternalStore } = require('react');
  return {
    useForYouStore: (sel: (s: { reasonsInFlightIds: ReadonlySet<string> }) => unknown) =>
      useSyncExternalStore(
        (l: () => void) => {
          mockListeners.add(l);
          return () => mockListeners.delete(l);
        },
        () => sel({ reasonsInFlightIds: mockInFlight }),
      ),
  };
});

import { useReasonWriting } from '../use-reason-in-flight';
import {
  REASON_WRITING_BACKSTOP_MS,
  firstReasonInFlightAt,
  resetReasonInFlightForTest,
} from '../pending-since';

function setInFlight(ids: string[]) {
  mockInFlight = new Set(ids);
  act(() => mockListeners.forEach((l) => l()));
}

describe('useReasonWriting', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetReasonInFlightForTest();
    mockInFlight = new Set();
  });
  afterEach(() => jest.useRealTimers());

  it('is false for a row that is not in flight, and records no anchor', () => {
    const { result } = renderHook(() => useReasonWriting('a'));
    expect(result.current).toBe(false);
    expect(firstReasonInFlightAt('a')).toBeNull();
  });

  it('is true while in flight and ends the moment the row leaves the set', () => {
    mockInFlight = new Set(['a']);
    const { result } = renderHook(() => useReasonWriting('a'));
    expect(result.current).toBe(true);
    setInFlight([]);
    expect(result.current).toBe(false);
  });

  it('stops at the backstop, even while the set still says in flight', () => {
    mockInFlight = new Set(['a']);
    const { result } = renderHook(() => useReasonWriting('a'));
    act(() => {
      jest.advanceTimersByTime(REASON_WRITING_BACKSTOP_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(result.current).toBe(false);
  });

  it('a remount does not restart the clock (the anchor is the first sight in this process)', () => {
    mockInFlight = new Set(['a']);
    const first = renderHook(() => useReasonWriting('a'));
    const anchor = firstReasonInFlightAt('a');
    expect(anchor).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(REASON_WRITING_BACKSTOP_MS - 1000);
    });
    first.unmount();
    // Virtualisation brings the row back: same anchor, so only ~1s remains.
    const again = renderHook(() => useReasonWriting('a'));
    expect(firstReasonInFlightAt('a')).toBe(anchor);
    expect(again.result.current).toBe(true);
    act(() => {
      jest.advanceTimersByTime(1001);
    });
    expect(again.result.current).toBe(false);
  });

  it('a mount after the backstop has passed says false at once', () => {
    mockInFlight = new Set(['a']);
    const first = renderHook(() => useReasonWriting('a'));
    first.unmount();
    act(() => {
      jest.advanceTimersByTime(REASON_WRITING_BACKSTOP_MS);
    });
    const { result } = renderHook(() => useReasonWriting('a'));
    expect(result.current).toBe(false);
  });
});
