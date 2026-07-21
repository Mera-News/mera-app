// Card-hierarchy render + behavior tests. Heavy UI primitives and the
// WatermelonDB service seams are stubbed (same pattern as the other component
// tests) so the cards render under jest-expo without the native DB.
/* eslint-disable @typescript-eslint/no-require-imports */

// RN's native Modal host component is mis-transformed by jest-expo. Proxy the
// module and stub Modal to a passthrough (renders children unless visible=false).
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const ReactLib = require('react');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Modal') {
        return ({ visible, children }: any) =>
          visible === false ? null : ReactLib.createElement(ReactLib.Fragment, null, children);
      }
      return (target as any)[prop];
    },
  });
});

// ── UI primitives → plain RN views ──
jest.mock('react-native-css-interop/jsx-runtime', () => {
  const R = require('react/jsx-runtime');
  return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const R = require('react/jsx-dev-runtime');
  return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/card', () => {
  const { View } = require('react-native');
  return { Card: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/image', () => {
  const { View } = require('react-native');
  return { Image: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});

// ── Custom children → light stubs that surface the props we assert on ──
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});
jest.mock('@/components/custom/ArticleMetaRow', () => {
  const { Text, View } = require('react-native');
  return {
    ArticleMetaRow: ({ publicationName, read }: any) => (
      <View>
        <Text>{publicationName ?? ''}</Text>
        {read ? <View testID="read-eye-icon" /> : null}
      </View>
    ),
  };
});
jest.mock('@/components/custom/RelevanceChip', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="relevance-chip" /> };
});
jest.mock('@/components/custom/chat/StreamingIndicator', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="streaming" /> };
});
jest.mock('@/components/custom/MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="mera-logo" /> };
});
jest.mock('@/components/custom/feedback-tree/FeedbackTreeOverlay', () => ({
  __esModule: true,
  default: () => null,
}));

// ── Service / store seams (all touch the native DB or native modules) ──
// Names are `mock`-prefixed so jest.mock factories may reference them.
const mockRecordArticleFeedback = jest.fn((..._a: any[]) => Promise.resolve());
const mockRemoveArticleFeedback = jest.fn((..._a: any[]) => Promise.resolve());
const mockHasLiked = jest.fn((..._a: any[]) => Promise.resolve(false));
jest.mock('@/lib/database/services/article-feedback-service', () => ({
  recordArticleFeedback: (...a: any[]) => mockRecordArticleFeedback(...a),
  removeArticleFeedback: (...a: any[]) => mockRemoveArticleFeedback(...a),
  hasLiked: (...a: any[]) => mockHasLiked(...a),
}));
const mockSaveSuggestion = jest.fn((..._a: any[]) => Promise.resolve());
const mockSaveStandaloneArticle = jest.fn((..._a: any[]) => Promise.resolve());
const mockDeleteSavedSuggestion = jest.fn((..._a: any[]) => Promise.resolve(true));
const mockIsSuggestionSaved = jest.fn((..._a: any[]) => Promise.resolve(false));
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
  saveSuggestion: (...a: any[]) => mockSaveSuggestion(...a),
  saveStandaloneArticle: (...a: any[]) => mockSaveStandaloneArticle(...a),
  deleteSavedSuggestion: (...a: any[]) => mockDeleteSavedSuggestion(...a),
  isSuggestionSaved: (...a: any[]) => mockIsSuggestionSaved(...a),
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getVisitCountForPublication: jest.fn(() => Promise.resolve(0)),
}));
// The universal actions row now hosts a "Track story" button backed by the
// tracking layer (which reaches Apollo + WatermelonDB). Stub the hook so these
// pure-render tests don't drag the native DB/network stack into the graph.
jest.mock('@/lib/tracking/use-tracked-subject', () => ({
  useTrackedSubject: () => ({ tracked: false, toggle: jest.fn() }),
}));
jest.mock('@/lib/database/services/fact-service', () => ({
  getFactsForTopicTexts: jest.fn(() => Promise.resolve([])),
}));
jest.mock('@/lib/hooks/useShareArticle', () => ({
  useShareArticle: () => jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticSuccess: jest.fn(),
}));
const mockExpand = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => ({ expand: mockExpand }) },
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

// eslint-disable-next-line import/first
import { fireEvent, render, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import React from 'react';
// eslint-disable-next-line import/first
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
// eslint-disable-next-line import/first
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
// eslint-disable-next-line import/first
import type { NewsArticle } from '@/lib/generated/graphql-types';
// eslint-disable-next-line import/first
import ArticleSuggestionCard from '../ArticleSuggestionCard';
// eslint-disable-next-line import/first
import ArticleStandaloneCard from '../ArticleStandaloneCard';
// eslint-disable-next-line import/first
import ArticleStandaloneCompactCard from '../ArticleStandaloneCompactCard';
// eslint-disable-next-line import/first
import ArticleActionsRow from '../ArticleActionsRow';
// eslint-disable-next-line import/first
import CompactActionsSheet from '../CompactActionsSheet';
// eslint-disable-next-line import/first
import type { FeedbackSubject } from '../feedback-subject';

function makeSuggestion(overrides: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: 'sugg-1',
    articleId: 'art-1',
    clusters: [],
    relevance: 0.8,
    reason: 'Because you follow Berlin',
    status: ArticleSuggestionStatus.Complete,
    country_code: 'DE',
    language_code: 'de',
    publication_name: 'Der Spiegel',
    title_en: 'A headline',
    title_original: 'Eine Überschrift',
    description_en: 'desc',
    article_url: 'https://example.com/a',
    image_url: null,
    userTopicIds: [],
    createdAt: new Date().toISOString(),
    firstPubDate: new Date().toISOString(),
    rawScore: null,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    ...overrides,
  };
}

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    _id: 'art-9',
    article_url: 'https://example.com/s',
    source_uri: 'https://example.com/s',
    title: 'Standalone title',
    title_en_internal_only: 'Standalone headline',
    description: 'd',
    image_url: null,
    original_language_code: 'de',
    pubDate: new Date().toISOString(),
    publicationSource: {
      _id: 'p1',
      publication_name: 'Die Zeit',
      country_code: 'DE',
    },
    ...overrides,
  } as NewsArticle;
}

beforeEach(() => jest.clearAllMocks());

describe('ArticleSuggestionCard', () => {
  it('renders the reason box (RelevanceChip + reason text) when complete with a reason', () => {
    const { getByText, getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    expect(getByText('Because you follow Berlin')).toBeTruthy();
    expect(getByTestId('relevance-chip')).toBeTruthy();
  });

  it('shows no reason box while unscored', () => {
    const { queryByTestId } = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion({ status: ArticleSuggestionStatus.Unscored, reason: '' })}
        onPress={jest.fn()}
      />,
    );
    expect(queryByTestId('relevance-chip')).toBeNull();
  });

  it('does not render the actions row unless showActions is set (pixel-identical default)', () => {
    const { queryByLabelText } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    expect(queryByLabelText('articleFeedback.likeLabel')).toBeNull();
  });

  it('fires onPress with its own suggestion', () => {
    const onPress = jest.fn();
    const s = makeSuggestion();
    const { getByText } = render(<ArticleSuggestionCard suggestion={s} onPress={onPress} />);
    fireEvent.press(getByText('A headline'));
    expect(onPress).toHaveBeenCalledWith(s);
  });

  it('does not render the read eye icon by default', () => {
    const { queryByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    expect(queryByTestId('read-eye-icon')).toBeNull();
  });

  it('renders the read eye icon in the meta row when read', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} read />,
    );
    expect(getByTestId('read-eye-icon')).toBeTruthy();
  });
});

describe('ArticleStandaloneCard', () => {
  it('never renders a RelevanceChip (no personalization chrome)', () => {
    const { queryByTestId } = render(
      <ArticleStandaloneCard article={makeArticle()} onPress={jest.fn()} />,
    );
    expect(queryByTestId('relevance-chip')).toBeNull();
  });

  it('renders the standalone actions row inline', () => {
    const { getByLabelText } = render(
      <ArticleStandaloneCard article={makeArticle()} onPress={jest.fn()} />,
    );
    expect(getByLabelText('articleFeedback.likeLabel')).toBeTruthy();
  });

  it('threads the article category + publication name into the persisted context snapshot', async () => {
    const { getByLabelText } = render(
      <ArticleStandaloneCard article={makeArticle({ category: 'Politics' })} onPress={jest.fn()} />,
    );
    fireEvent.press(getByLabelText('articleFeedback.dislikeLabel'));
    await waitFor(() => expect(mockRecordArticleFeedback).toHaveBeenCalled());
    const arg = mockRecordArticleFeedback.mock.calls[0][0];
    expect(JSON.parse(arg.contextJson)).toMatchObject({ category: 'Politics', publication: 'Die Zeit' });
  });
});

describe('ArticleStandaloneCompactCard', () => {
  it('shows the publisher name by default', () => {
    const { getByText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    expect(getByText('Die Zeit')).toBeTruthy();
  });

  it('hides the source when hideSource is set', () => {
    const { queryByText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} hideSource />,
    );
    expect(queryByText('Die Zeit')).toBeNull();
  });

  it('does not mount the "…" actions button by default (pixel-identical)', () => {
    const { queryByLabelText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    expect(queryByLabelText('More actions')).toBeNull();
  });
});

describe('ArticleActionsRow', () => {
  const subject: FeedbackSubject = {
    origin: 'article',
    surface: 'explore',
    articleId: 'art-9',
    title: 'Standalone headline',
    publicationName: 'Die Zeit',
    countryCode: 'DE',
  };

  it('records a like carrying the subject origin + surface', async () => {
    const { getByLabelText } = render(
      <ArticleActionsRow subject={subject} article={makeArticle()} />,
    );
    fireEvent.press(getByLabelText('articleFeedback.likeLabel'));
    await waitFor(() =>
      expect(mockRecordArticleFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          articleId: 'art-9',
          sentiment: 'like',
          origin: 'article',
          surface: 'explore',
        }),
      ),
    );
  });

  it('records a dislike (origin/surface) and opens the feedback tree', async () => {
    const { getByLabelText } = render(
      <ArticleActionsRow subject={subject} article={makeArticle()} />,
    );
    fireEvent.press(getByLabelText('articleFeedback.dislikeLabel'));
    await waitFor(() =>
      expect(mockRecordArticleFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ sentiment: 'dislike', origin: 'article', surface: 'explore' }),
      ),
    );
  });

  it('saves a standalone article via saveStandaloneArticle', async () => {
    const article = makeArticle();
    const { getByLabelText } = render(
      <ArticleActionsRow subject={subject} article={article} />,
    );
    fireEvent.press(getByLabelText('savedSuggestions.savedToastTitle'));
    await waitFor(() => expect(mockSaveStandaloneArticle).toHaveBeenCalled());
    expect(mockSaveSuggestion).not.toHaveBeenCalled();
  });

  it('saves a suggestion via saveSuggestion for the suggestion origin', async () => {
    const s = makeSuggestion();
    const suggestionSubject: FeedbackSubject = {
      origin: 'suggestion',
      surface: 'for_you',
      articleId: s.articleId,
      suggestionId: s._id,
      title: s.title_en ?? '',
    };
    const { getByLabelText } = render(
      <ArticleActionsRow subject={suggestionSubject} suggestion={s} />,
    );
    fireEvent.press(getByLabelText('savedSuggestions.savedToastTitle'));
    await waitFor(() => expect(mockSaveSuggestion).toHaveBeenCalledWith(s));
    expect(mockSaveStandaloneArticle).not.toHaveBeenCalled();
  });
});

describe('CompactActionsSheet', () => {
  const subject: FeedbackSubject = {
    origin: 'article',
    surface: 'triage',
    articleId: 'art-9',
    title: 'Standalone headline',
  };

  it('lists all actions (chat/like/dislike/save/share) when open with a shareable url', () => {
    const { getByText } = render(
      <CompactActionsSheet
        visible
        onClose={jest.fn()}
        subject={subject}
        article={makeArticle()}
        share={{ url: 'https://example.com/s', titleEnglish: 'Standalone headline' }}
      />,
    );
    expect(getByText('Mera')).toBeTruthy();
    expect(getByText('articleFeedback.likeLabel')).toBeTruthy();
    expect(getByText('articleFeedback.dislikeLabel')).toBeTruthy();
    expect(getByText('savedSuggestions.savedToastTitle')).toBeTruthy();
    expect(getByText('articleDetail.share')).toBeTruthy();
  });

  it('renders nothing when not visible', () => {
    const { queryByText } = render(
      <CompactActionsSheet visible={false} onClose={jest.fn()} subject={subject} article={makeArticle()} />,
    );
    expect(queryByText('articleFeedback.likeLabel')).toBeNull();
  });
});
