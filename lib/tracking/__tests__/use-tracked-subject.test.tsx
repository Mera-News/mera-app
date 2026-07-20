// use-tracked-subject.test.tsx — the Track/Untrack button hook.
//
// Verifies the reworked track path opens the floating Mera chat (article-feedback
// context + trackSubject snapshot + seeded auto-send message) instead of the old
// proposal sheet, and that the untrack path stays immediate.

const mockIsSubjectTracked = jest.fn();
const mockUntrackStoryFromSubject = jest.fn();

jest.mock('../track-actions', () => ({
  isSubjectTracked: (...args: unknown[]) => mockIsSubjectTracked(...args),
  untrackStoryFromSubject: (...args: unknown[]) => mockUntrackStoryFromSubject(...args),
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
  mockIsSubjectTracked.mockResolvedValue(false);
  mockUntrackStoryFromSubject.mockResolvedValue(undefined);
});

describe('useTrackedSubject — track path', () => {
  it('opens the floating chat on the article-feedback context with a track subject + seed', async () => {
    const { result } = renderHook(() => useTrackedSubject(subject));
    await waitFor(() => expect(mockIsSubjectTracked).toHaveBeenCalled());

    act(() => result.current.toggle());

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
        stableClusterId: 'sc-1',
        publicationName: 'The Hindu',
      },
    });
    expect(seed).toBe('trackedStories.trackChatSeed');
    // Track is confirmed later in chat — button does NOT optimistically flip.
    expect(result.current.tracked).toBe(false);
    expect(mockUntrackStoryFromSubject).not.toHaveBeenCalled();
  });
});

describe('useTrackedSubject — untrack path', () => {
  it('untracks immediately and flips optimistic state when already tracked', async () => {
    mockIsSubjectTracked.mockResolvedValue(true);
    const { result } = renderHook(() => useTrackedSubject(subject));
    await waitFor(() => expect(result.current.tracked).toBe(true));

    act(() => result.current.toggle());

    expect(mockUntrackStoryFromSubject).toHaveBeenCalledWith(subject);
    expect(result.current.tracked).toBe(false);
    expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
  });
});
