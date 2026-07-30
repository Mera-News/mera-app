// saved-state — the app-wide bookmark invalidation channel.
//
// Regression context: deleting an article from the Saved list left its Feed
// card showing a filled bookmark, and the next tap ran the un-save branch
// against a row that no longer existed — a silent no-op that just cleared the
// icon. The write paths now publish here and every mounted bookmark corrects
// itself.

import { renderHook, act } from '@testing-library/react-native';
import {
  __resetSavedStateForTests,
  getSavedOverride,
  publishSavedState,
  useSavedOverride,
} from '../saved-state';

beforeEach(() => {
  __resetSavedStateForTests();
});

describe('publishSavedState / getSavedOverride', () => {
  it('is undefined until something mutates that id', () => {
    expect(getSavedOverride('art-1')).toBeUndefined();
  });

  it('records both directions', () => {
    publishSavedState('art-1', true);
    expect(getSavedOverride('art-1')).toBe(true);
    publishSavedState('art-1', false);
    expect(getSavedOverride('art-1')).toBe(false);
  });

  it('keeps ids independent', () => {
    publishSavedState('art-1', true);
    expect(getSavedOverride('art-2')).toBeUndefined();
  });

  it('ignores a blank id rather than storing an empty key', () => {
    publishSavedState('', true);
    expect(getSavedOverride('')).toBeUndefined();
  });
});

describe('useSavedOverride', () => {
  it('starts undefined so the caller falls back to its own DB read', () => {
    const { result } = renderHook(() => useSavedOverride('art-1'));
    expect(result.current).toBeUndefined();
  });

  // The actual reported bug: the Saved list deletes, the Feed card is mounted
  // elsewhere and must flip without remounting.
  it('flips a mounted subscriber when another surface deletes the row', () => {
    const { result } = renderHook(() => useSavedOverride('art-1'));
    act(() => publishSavedState('art-1', true));
    expect(result.current).toBe(true);
    act(() => publishSavedState('art-1', false));
    expect(result.current).toBe(false);
  });

  it('does not react to a different article', () => {
    const { result } = renderHook(() => useSavedOverride('art-1'));
    act(() => publishSavedState('art-2', true));
    expect(result.current).toBeUndefined();
  });

  it('notifies every mounted subscriber for that id', () => {
    const a = renderHook(() => useSavedOverride('art-1'));
    const b = renderHook(() => useSavedOverride('art-1'));
    act(() => publishSavedState('art-1', true));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
  });

  // A redundant publish must not churn every mounted bookmark in a long list.
  it('does not re-render when the value is unchanged', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useSavedOverride('art-1');
    });
    const baseline = renders;
    act(() => publishSavedState('art-1', true));
    const afterChange = renders;
    expect(afterChange).toBeGreaterThan(baseline);
    act(() => publishSavedState('art-1', true)); // same value again
    expect(renders).toBe(afterChange);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useSavedOverride('art-1'));
    unmount();
    // No subscribers left: publishing must not throw.
    expect(() => publishSavedState('art-1', true)).not.toThrow();
  });
});
