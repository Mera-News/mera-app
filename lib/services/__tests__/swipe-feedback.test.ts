// swipe-feedback service tests — verifies the Feed-tab signal writers + the
// Mera chat handoff. The DB services, feedback-tree, i18n, and floating-chat
// store are all mocked; the FeedbackSubject builders are exercised for real.

jest.mock('@/lib/database/services/article-feedback-service', () => ({
  recordVerdictFeedback: jest.fn(async () => {}),
  removeArticleFeedback: jest.fn(async () => {}),
  updateFeedbackContextPath: jest.fn(async () => {}),
}));

const mockOpenArticleFeedback = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => ({ openArticleFeedback: mockOpenArticleFeedback }) },
}));

const TREE = {
  version: 2,
  root: [
    {
      id: 'suggestion',
      labelKey: 'k.sug',
      labelDefault: 'Not a good suggestion',
      children: [
        { id: 'wrong_topic', labelKey: 'k.wt', labelDefault: 'Wrong topic', leaf: {} },
      ],
    },
  ],
  likeRoot: [
    {
      id: 'more_about_topic',
      labelKey: 'k.mat',
      labelDefault: 'More about this topic',
      children: [{ id: 'a_lot_more', labelKey: 'k.alm', labelDefault: 'A lot more', leaf: {} }],
    },
  ],
};
jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(async () => TREE),
}));

jest.mock('@/lib/i18n', () => ({
  __esModule: true,
  default: {
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'defaultValue' in opts) return opts.defaultValue as string; // tree labels
      if (opts && 'path' in opts) return `${key}|${opts.path}`;
      return key;
    },
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import {
  recordVerdictFeedback,
  removeArticleFeedback,
  updateFeedbackContextPath,
} from '@/lib/database/services/article-feedback-service';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { swipeCallbacks } from '@/components/custom/swipe-feed/swipe-callbacks';
import {
  recordSwipeVerdict,
  changeSwipeVerdict,
  updateFeedbackTreePath,
  openFeedbackChatWithPath,
  wireSwipeCallbacks,
} from '../swipe-feedback';

function makeSuggestion(overrides: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: 'sugg-1',
    articleId: 'art-1',
    clusters: [],
    relevance: 0.8,
    reason: '',
    status: 'complete' as ForYouSuggestion['status'],
    country_code: 'IN',
    language_code: 'en',
    publication_name: 'The Hindu',
    title_en: 'A story',
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: '2026-07-20',
    firstPubDate: '2026-07-19',
    rawScore: null,
    eventType: null,
    headlineScope: null,
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('recordSwipeVerdict', () => {
  it('records a verdict with origin/surface + context snapshot (latest-wins)', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');
    expect(recordVerdictFeedback).toHaveBeenCalledTimes(1);
    const arg = (recordVerdictFeedback as jest.Mock).mock.calls[0][0];
    expect(arg).toMatchObject({
      articleId: 'art-1',
      suggestionId: 'sugg-1',
      sentiment: 'like',
      origin: 'suggestion',
      surface: 'swipe',
    });
    // Context snapshot carries the matched topics + relevance.
    expect(JSON.parse(arg.contextJson)).toMatchObject({ relevance: 0.8 });
  });
});

describe('changeSwipeVerdict', () => {
  it('removes the old sentiment and records the new one', async () => {
    await changeSwipeVerdict(makeSuggestion(), 'like', 'dislike');
    expect(removeArticleFeedback).toHaveBeenCalledWith('art-1', 'like');
    expect(recordVerdictFeedback).toHaveBeenCalledTimes(1);
    expect((recordVerdictFeedback as jest.Mock).mock.calls[0][0].sentiment).toBe('dislike');
  });

  it('no-ops when from === to', async () => {
    await changeSwipeVerdict(makeSuggestion(), 'like', 'like');
    expect(removeArticleFeedback).not.toHaveBeenCalled();
    expect(recordVerdictFeedback).not.toHaveBeenCalled();
  });
});

describe('updateFeedbackTreePath', () => {
  it('forwards to updateFeedbackContextPath', async () => {
    await updateFeedbackTreePath(makeSuggestion(), 'dislike', ['a', 'b']);
    expect(updateFeedbackContextPath).toHaveBeenCalledWith('art-1', 'dislike', ['a', 'b']);
  });
});

describe('openFeedbackChatWithPath', () => {
  it('resolves like-root path labels + opens chat with verdict + label breadcrumb', async () => {
    await openFeedbackChatWithPath(makeSuggestion(), 'like', ['more_about_topic', 'a_lot_more']);
    expect(mockOpenArticleFeedback).toHaveBeenCalledTimes(1);
    const [context, message] = mockOpenArticleFeedback.mock.calls[0];
    expect(context).toMatchObject({
      kind: 'article-suggestion',
      articleId: 'art-1',
      suggestionId: 'sugg-1',
      verdict: 'like',
      treePath: ['More about this topic', 'A lot more'],
    });
    expect(message).toBe('swipeFeed.chatHandoffLike|More about this topic → A lot more');
  });

  it('uses the no-path message when the path is empty', async () => {
    await openFeedbackChatWithPath(makeSuggestion(), 'dislike', []);
    const [context, message] = mockOpenArticleFeedback.mock.calls[0];
    expect(context.verdict).toBe('dislike');
    expect(context.treePath).toEqual([]);
    expect(message).toBe('swipeFeed.chatHandoffDislikeNoPath');
  });
});

describe('wireSwipeCallbacks', () => {
  it('installs real implementations onto the swipe-callbacks contract', async () => {
    wireSwipeCallbacks();
    swipeCallbacks.onVerdict(makeSuggestion(), 'like');
    await Promise.resolve();
    await Promise.resolve();
    expect(recordVerdictFeedback).toHaveBeenCalled();
  });
});
