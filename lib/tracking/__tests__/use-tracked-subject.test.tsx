// use-tracked-subject.test.tsx — the Track/Untrack button hook.
//
// Verifies the reworked track path opens the floating Mera chat (article-feedback
// context + trackSubject snapshot + seeded auto-send message) instead of the old
// proposal sheet, and that the untrack path stays immediate.

// The hook SUBSCRIBES to tracked state (it is not a one-shot read), so the seam
// is an observable. `emitTracked` lets a test push a later value — the case that
// matters: the story is minted inside the floating chat, long after mount.
// The hook SUBSCRIBES to the matching story's ID (not just a flag), so the
// "already following" dialog can navigate to it. `emitTracked` pushes a later
// value — the case that matters: the story is minted inside the floating chat,
// long after mount.
let trackedSubscribers: ((v: string | null) => void)[] = [];
let trackedCurrent: string | null = null;
const mockObserveSubjectTrackedId = jest.fn(() => ({
  subscribe: ({ next }: { next: (v: string | null) => void }) => {
    trackedSubscribers.push(next);
    next(trackedCurrent);
    return {
      unsubscribe: () => {
        trackedSubscribers = trackedSubscribers.filter((f) => f !== next);
      },
    };
  },
}));
const emitTracked = (v: string | null) => {
  trackedCurrent = v;
  trackedSubscribers.forEach((f) => f(v));
};

jest.mock('../track-actions', () => ({
  observeSubjectTrackedId: (...args: unknown[]) => mockObserveSubjectTrackedId(...(args as [])),
}));

const mockOpenArticleFeedback = jest.fn();

jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: () => ({ openArticleFeedback: mockOpenArticleFeedback }),
  },
}));

jest.mock('../../haptics', () => ({
  hapticLight: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useTrackedSubject } from '../use-tracked-subject';
import type { FeedbackSubject } from '../../../components/custom/cards/feedback-subject';

const subject: FeedbackSubject = {
  origin: 'suggestion',
  surface: 'for_you',
  articleId: 'art-1',
  suggestionId: 'sugg-1',
  title: 'Protest escalates in Sonbhadra',
  publicationName: 'The Hindu',
  stableClusterId: 'sc-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  trackedSubscribers = [];
  trackedCurrent = null;
});

describe('useTrackedSubject — track path', () => {
  it('opens the floating chat on the article-feedback context with a track subject + seed', async () => {
    const { result } = renderHook(() => useTrackedSubject(subject));
    await waitFor(() => expect(mockObserveSubjectTrackedId).toHaveBeenCalled());

    act(() => result.current.startTracking());

    expect(mockOpenArticleFeedback).toHaveBeenCalledTimes(1);
    const [context, seed] = mockOpenArticleFeedback.mock.calls[0];
    expect(context).toEqual({
      kind: 'article-suggestion',
      articleId: 'art-1',
      suggestionId: 'sugg-1',
      articleTitle: 'Protest escalates in Sonbhadra',
      trackSubject: {
        origin: 'suggestion',
        surface: 'for_you',
        articleId: 'art-1',
        title: 'Protest escalates in Sonbhadra',
        pubDate: null,
        stableClusterId: 'sc-1',
        publicationName: 'The Hindu',
      },
    });
    expect(seed).toBe('trackedStories.trackChatSeed');
    // Track is confirmed later in chat — button does NOT optimistically flip.
    expect(result.current.tracked).toBe(false);
  });
});

// Q13 REPLACES the old behaviour. Tapping a tracked story used to untrack it
// immediately; it must not, because untracking destroys everything saved for the
// story. The hook now does NOTHING on an already-tracked subject and the caller
// (components/custom/tracked-stories/use-track-button) shows a dialog offering
// "Go to story" instead.
describe('useTrackedSubject — already tracked', () => {
  it('startTracking is a NO-OP: no untrack, no second proposal', async () => {
    trackedCurrent = 'story-9';
    const { result } = renderHook(() => useTrackedSubject(subject));
    await waitFor(() => expect(result.current.tracked).toBe(true));

    act(() => result.current.startTracking());

    expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
  });

  it('exposes the matching story id so the dialog can navigate to it', async () => {
    trackedCurrent = 'story-9';
    const { result } = renderHook(() => useTrackedSubject(subject));
    await waitFor(() => expect(result.current.trackedStoryId).toBe('story-9'));
  });
});

describe('useTrackedSubject — live tracked state', () => {
  // The regression: tracking is confirmed inside the FLOATING chat, which
  // outlives this screen. With a one-shot mount read the button stayed on
  // "Track story" forever, and the next tap opened a SECOND proposal.
  it('flips to tracked when the story is minted later, with no remount', async () => {
    const { result } = renderHook(() => useTrackedSubject(subject));
    await waitFor(() => expect(result.current.tracked).toBe(false));

    act(() => emitTracked('story-9'));

    await waitFor(() => expect(result.current.tracked).toBe(true));
    expect(result.current.trackedStoryId).toBe('story-9');

    // And the button stops starting new proposals.
    act(() => result.current.startTracking());
    expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
  });

  it('reflects an untrack performed elsewhere', async () => {
    trackedCurrent = 'story-9';
    const { result } = renderHook(() => useTrackedSubject(subject));
    await waitFor(() => expect(result.current.tracked).toBe(true));

    act(() => emitTracked(null));

    await waitFor(() => expect(result.current.tracked).toBe(false));
    expect(result.current.trackedStoryId).toBeNull();
  });

  it('does not subscribe when inactive', () => {
    renderHook(() => useTrackedSubject(subject, false));
    expect(mockObserveSubjectTrackedId).not.toHaveBeenCalled();
  });
});
