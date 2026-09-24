// F2 — the feed's commit plumbing.
//
// Before this fix the feed had NO db write that distinguished "the user opened a
// branch" from "a leaf settled": `onLeafCommitted` only touched local state, so
// the only persisted signal was the path — which a branch descent writes too.
// These tests pin that an uncommitted leaf (seenOnly) stays uncommitted and
// that a leaf (or a Mera escalation) commits on both the adapter and the
// persistence contract. The leaves come from the ••• sheet's tree levels, which
// the card's thumbs open directly (the inline panel is gone).

jest.mock('@/lib/services/swipe-feedback', () => ({
  wireSwipeCallbacks: jest.fn(),
}));
jest.mock('@/lib/database/services/story-impression-service', () => ({
  recordOpen: jest.fn(),
}));

import { renderHook } from '@testing-library/react-native';
import { swipeCallbacks } from '../swipe-callbacks';
import { useFeedbackSheet, type VerdictStoreAdapter } from '../use-feedback-sheet';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const suggestion = { _id: 's1', articleId: 'a1', title_en: 'T' } as unknown as ForYouSuggestion;

function makeAdapter() {
  const state: { verdict: any; path: string[]; committed: boolean } = {
    verdict: null,
    path: [],
    committed: false,
  };
  const adapter: VerdictStoreAdapter = {
    keyFor: () => 'k1',
    getVerdict: () => state.verdict,
    setVerdict: (_k, v) => {
      state.verdict = v;
    },
    getPath: () => state.path,
    setPath: (_k, p) => {
      state.path = p;
    },
    getCommitted: () => state.committed,
    setCommitted: (_k, c) => {
      state.committed = c;
    },
  };
  return { adapter, state };
}

let onLeafCommitted: jest.Mock;
let onTreePathChanged: jest.Mock;
let onInvokeMera: jest.Mock;

beforeEach(() => {
  onLeafCommitted = jest.fn();
  onTreePathChanged = jest.fn();
  onInvokeMera = jest.fn();
  swipeCallbacks.onLeafCommitted = onLeafCommitted;
  swipeCallbacks.onTreePathChanged = onTreePathChanged;
  swipeCallbacks.onInvokeMera = onInvokeMera;
  swipeCallbacks.onVerdict = jest.fn();
  swipeCallbacks.onVerdictChanged = jest.fn();
  swipeCallbacks.onVerdictRemoved = jest.fn();
});

describe('useFeedbackSheet — commit vs navigation', () => {
  it('an uncommitted leaf (seenOnly) records the path and commits NOTHING', () => {
    const { adapter, state } = makeAdapter();
    const { result } = renderHook(() => useFeedbackSheet(adapter));

    result.current.feedbackHandlers.onLeafPicked(suggestion, 'dislike', ['seen_already'], 0, false);

    expect(state.path).toEqual(['seen_already']);
    expect(state.committed).toBe(false);
    expect(onTreePathChanged).toHaveBeenCalledWith(suggestion, 'dislike', ['seen_already']);
    expect(onLeafCommitted).not.toHaveBeenCalled();
  });

  it('a terminal leaf commits, locally AND through the persistence contract, with its applied count', () => {
    const { adapter, state } = makeAdapter();
    const { result } = renderHook(() => useFeedbackSheet(adapter));

    const path = ['not_important_to_me', 'not_important'];
    result.current.feedbackHandlers.onLeafPicked(suggestion, 'dislike', path, 2, true);

    expect(state.committed).toBe(true);
    expect(state.path).toEqual(path);
    expect(onLeafCommitted).toHaveBeenCalledWith(suggestion, 'dislike', path, 2);
  });

  it('"related coverage" opens the suggestion through the host', () => {
    const { adapter } = makeAdapter();
    const onOpenSuggestion = jest.fn();
    const { result } = renderHook(() => useFeedbackSheet(adapter, { onOpenSuggestion }));

    result.current.feedbackHandlers.onBrowseRelated(suggestion);

    expect(onOpenSuggestion).toHaveBeenCalledWith(suggestion);
  });

  it('escalating to Mera commits too', () => {
    const { adapter, state } = makeAdapter();
    const { result } = renderHook(() => useFeedbackSheet(adapter));

    result.current.feedbackHandlers.onInvokeMera(suggestion, 'like', ['tell_mera_why']);

    expect(state.committed).toBe(true);
    expect(onLeafCommitted).toHaveBeenCalledWith(suggestion, 'like', ['tell_mera_why']);
    expect(onInvokeMera).toHaveBeenCalled();
  });

  it('un-voting clears the commitment', () => {
    const { adapter, state } = makeAdapter();
    const { result } = renderHook(() => useFeedbackSheet(adapter));

    result.current.feedbackHandlers.onLeafPicked(suggestion, 'dislike', ['a', 'b'], 1, true);
    state.verdict = 'dislike';
    result.current.onVerdict(suggestion, 'dislike');

    expect(state.committed).toBe(false);
    expect(state.verdict).toBeNull();
  });

  it('flipping like↔dislike starts the new verdict uncommitted', () => {
    const { adapter, state } = makeAdapter();
    const { result } = renderHook(() => useFeedbackSheet(adapter));

    result.current.feedbackHandlers.onLeafPicked(suggestion, 'dislike', ['a', 'b'], 1, true);
    state.verdict = 'dislike';
    result.current.onVerdict(suggestion, 'like');

    expect(state.verdict).toBe('like');
    expect(state.committed).toBe(false);
    expect(state.path).toEqual([]);
  });
});
