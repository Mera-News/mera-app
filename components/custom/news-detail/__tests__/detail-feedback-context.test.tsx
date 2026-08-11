// The article-detail feedback gap (P4c).
//
// `ArticleFeedbackPrompt` used to fabricate a partial ForYouSuggestion behind an
// `as unknown as` cast from a `feedbackContext` prop that ArticleDetailScreen
// never passed — so every article-detail verdict persisted `context_json: null`
// and the digest's publication / category / event / topic candidates were a
// no-op for the whole surface. These tests pin the persisted snapshot.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
// The action row is CardActionBar now, so this file renders lucide icons. The
// mock must enumerate EVERY icon the row imports — a missing entry resolves to
// `undefined` and takes the whole suite file down, not just one assertion.
jest.mock('lucide-react-native', () => {
  const { View } = require('react-native');
  return {
    ThumbsUp: (p: any) => <View testID="icon-thumbsup" fill={p.fill} color={p.color} />,
    ThumbsDown: (p: any) => <View testID="icon-thumbsdown" fill={p.fill} color={p.color} />,
    Bookmark: (p: any) => <View testID="icon-bookmark" fill={p.fill} color={p.color} />,
    Crosshair: (p: any) => <View testID="icon-crosshair" fill={p.fill} color={p.color} />,
    Share2: (p: any) => <View testID="icon-share" fill={p.fill} color={p.color} />,
  };
});
jest.mock('@/components/custom/MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/cards/CardFeedbackSurface', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/lib/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticSuccess: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/hooks/useShareArticle', () => ({ useShareArticle: () => jest.fn() }));
jest.mock('@/components/custom/tracked-stories/use-track-button', () => ({
  useTrackButton: () => ({ tracked: false, onPress: jest.fn(), dialog: null }),
}));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => ({ expand: jest.fn() }) },
}));
jest.mock('@/lib/services/swipe-feedback', () => ({ openFeedbackChatWithPath: jest.fn() }));

const mockRecordVerdictFeedback = jest.fn(async () => {});
jest.mock('@/lib/database/services/article-feedback-service', () => ({
  getArticleVerdict: jest.fn(async () => ({ verdict: null, path: [] })),
  recordVerdictFeedback: (...a: any[]) => mockRecordVerdictFeedback(...(a as [])),
  removeArticleFeedback: jest.fn(async () => {}),
  updateFeedbackContextPath: jest.fn(async () => {}),
}));

const mockGetSuggestionFeedbackContext = jest.fn();
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getSuggestionFeedbackContext: (...a: any[]) => mockGetSuggestionFeedbackContext(...(a as [])),
  // The real (pure) helpers — the two paths must name a place identically.
  geoTextFromTags: (tags: any[]) => {
    for (const t of tags ?? []) {
      const n = t?.city?.trim() || t?.region?.trim() || t?.countryCode?.trim();
      if (n) return n;
    }
    return null;
  },
  // Its uncooked twin: the tag field verbatim, which is what a structured
  // `place` filter compares against (see placeValueFromTags' own doc).
  placeValueFromTags: (tags: any[]) => {
    for (const t of tags ?? []) {
      const n = t?.city?.trim() || t?.region?.trim() || t?.countryCode?.trim();
      if (n) return n;
    }
    return null;
  },
}));

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import ArticleFeedbackPrompt from '../../ArticleFeedbackPrompt';

const SUGGESTION_ROW = {
  suggestion: {
    _id: 'sugg-9',
    articleId: 'art-1',
    clusters: [{ clusterId: 'c1', confidence: 0.9, stableClusterId: 'stable-1' }],
    relevance: 0.72,
    reason: 'because',
    status: 'complete',
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
    rawScore: 0.6,
    eventType: 'election',
    headlineScope: null,
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
  },
  matchedTopicTexts: ['cricket'],
  linkedFacts: [],
  entities: ['BCCI'],
  category: 'Sports',
  clusterSize: 5,
  geoText: 'mumbai',
};

const STANDALONE_ARTICLE = {
  _id: 'art-2',
  title: 'Titre',
  title_en_internal_only: 'A standalone story',
  description: 'd',
  article_url: 'https://example.com/a',
  image_url: null,
  pubDate: '2026-07-25T00:00:00.000Z',
  original_language_code: 'fr',
  category: 'Politics',
  entities: ['Assembly'],
  event_type: 'protest',
  geo_tags: [{ city: 'Lyon', region: 'ARA', countryCode: 'FR' }],
  publicationSource: { _id: 'p1', publication_name: 'Le Monde', country_code: 'FR' },
};

/** The context_json string handed to recordVerdictFeedback, parsed. */
function persistedContext(): Record<string, unknown> {
  const [input] = mockRecordVerdictFeedback.mock.calls[0] as unknown as [
    { contextJson: string | null },
  ];
  expect(input.contextJson).not.toBeNull();
  return JSON.parse(input.contextJson as string);
}

beforeEach(() => jest.clearAllMocks());

describe('article-detail verdicts persist a real context', () => {
  it('sources the LOCAL suggestion row by articleId, including the category only the row has', async () => {
    mockGetSuggestionFeedbackContext.mockResolvedValue(SUGGESTION_ROW);
    const { getByTestId } = render(
      <ArticleFeedbackPrompt articleId="art-1" title="A story" />,
    );

    fireEvent.press(getByTestId('card-action-dislike'));
    await waitFor(() => expect(mockRecordVerdictFeedback).toHaveBeenCalledTimes(1));

    // Resolved by articleId alone — the screen passes no suggestionId.
    expect(mockGetSuggestionFeedbackContext).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
    );

    const [input] = mockRecordVerdictFeedback.mock.calls[0] as unknown as [
      { origin: string; surface: string; suggestionId?: string },
    ];
    expect(input.origin).toBe('suggestion');
    expect(input.surface).toBe('detail');
    expect(input.suggestionId).toBe('sugg-9');

    expect(persistedContext()).toEqual({
      publication: 'The Hindu',
      category: 'Sports',
      eventType: 'election',
      stableClusterId: 'stable-1',
      relevance: 0.72,
      matchedTopics: [{ topicId: 't1', text: 'cricket' }],
    });
  });

  it('falls back to the ARTICLE when there is no local row (Explore / shared link)', async () => {
    mockGetSuggestionFeedbackContext.mockResolvedValue(null);
    const { getByTestId } = render(
      <ArticleFeedbackPrompt
        articleId="art-2"
        title="A standalone story"
        article={STANDALONE_ARTICLE as never}
      />,
    );

    fireEvent.press(getByTestId('card-action-like'));
    await waitFor(() => expect(mockRecordVerdictFeedback).toHaveBeenCalledTimes(1));

    const [input] = mockRecordVerdictFeedback.mock.calls[0] as unknown as [{ origin: string }];
    expect(input.origin).toBe('article');
    // category / event_type come from the article's own GraphQL fields, which
    // the detail query did not even select before this wave.
    expect(persistedContext()).toEqual({
      publication: 'Le Monde',
      category: 'Politics',
      eventType: 'protest',
    });
  });

  it('a thumb tapped BEFORE the lookup lands still persists the full context', async () => {
    let release: (v: unknown) => void = () => {};
    mockGetSuggestionFeedbackContext.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const { getByTestId } = render(
      <ArticleFeedbackPrompt articleId="art-1" title="A story" />,
    );

    // Tap while the row lookup is still in flight — the exact ordering that
    // used to write `context_json: null`.
    fireEvent.press(getByTestId('card-action-dislike'));
    expect(mockRecordVerdictFeedback).not.toHaveBeenCalled();

    await act(async () => {
      release(SUGGESTION_ROW);
    });

    await waitFor(() => expect(mockRecordVerdictFeedback).toHaveBeenCalledTimes(1));
    expect(persistedContext()).toEqual(
      expect.objectContaining({ publication: 'The Hindu', category: 'Sports' }),
    );
  });
});
