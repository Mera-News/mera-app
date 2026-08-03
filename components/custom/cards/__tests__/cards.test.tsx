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
  return { Image: (p: any) => <View testID="article-image" {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/icon', () => {
  const { View } = require('react-native');
  return {
    Icon: (props: any) => <View testID="icon" {...props} />,
    ExternalLinkIcon: 'ExternalLinkIcon',
  };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
// lucide icons (the CardActionBar row on ArticleSuggestionCard) → plain views.
jest.mock('lucide-react-native', () => {
  const { View } = require('react-native');
  return {
    ThumbsUp: (p: any) => <View testID="icon-thumbsup" fill={p.fill} color={p.color} />,
    ThumbsDown: (p: any) => <View testID="icon-thumbsdown" fill={p.fill} color={p.color} />,
    Bookmark: (p: any) => <View testID="icon-bookmark" fill={p.fill} color={p.color} />,
    Share2: (p: any) => <View testID="icon-share" fill={p.fill} color={p.color} />,
  };
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
// Mocked to avoid the InlineFeedbackTree → feedback-tree-service → DB import chain.
jest.mock('@/components/custom/cards/CardFeedbackSurface', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="card-feedback-surface" /> };
});
// Mocked to avoid pulling in the (un-transformable) gluestack icon ESM via
// @/components/ui/icon — ArticleCompactCardBase imports SourceFlag directly.
jest.mock('@/components/custom/SourceFlag', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    SourceFlag: (p: any) => <View testID="source-flag" {...p} />,
    default: (p: any) => <View testID="source-flag" {...p} />,
  };
});
jest.mock('@/components/custom/chat/StreamingIndicator', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="streaming" /> };
});
jest.mock('@/components/custom/MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID="mera-logo" {...p} /> };
});
// ArticleImagePlaceholder draws its warm off-white gradient with react-native-svg (same
// house pattern as SectionGradientPanel) — mocked to plain views, same as
// every other react-native-svg consumer's test (SectionGradientPanel.test.tsx,
// MeraLogo.test.tsx).
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  const Passthrough = (props: any) => <View {...props} />;
  return {
    __esModule: true,
    default: (props: any) => <View testID="placeholder-svg" {...props} />,
    Svg: (props: any) => <View testID="placeholder-svg" {...props} />,
    Defs: Passthrough,
    LinearGradient: Passthrough,
    Stop: Passthrough,
    Rect: Passthrough,
  };
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
const mockRecordPublicationVisit = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getVisitCountForPublication: jest.fn(() => Promise.resolve(0)),
  recordPublicationVisit: (...a: any[]) => mockRecordPublicationVisit(...a),
}));
const mockOpenArticleInAppBrowser = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/web-browser-utils', () => ({
  openArticleInAppBrowser: (...a: any[]) => mockOpenArticleInAppBrowser(...a),
}));
let mockBlurImages = false;
jest.mock('@/lib/stores/blur-images-store', () => ({
  useBlurImagesStore: (selector: any) => selector({ blurImages: mockBlurImages }),
}));
// The universal actions row now hosts a "Track story" button backed by the
// tracking layer (which reaches Apollo + WatermelonDB). Stub the hook so these
// pure-render tests don't drag the native DB/network stack into the graph.
// The track button's press behaviour + its "already following" dialog. Mocked
// because the real module renders a Gluestack Modal (which pulls @legendapp/motion,
// untransformed ESM under jest) and is not what these card tests exercise.
jest.mock('@/components/custom/tracked-stories/use-track-button', () => ({
  useTrackButton: () => ({ tracked: false, onPress: jest.fn(), dialog: null }),
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

/** Walk up from a node to find the nearest resolved `opacity` style. */
function opacityOf(node: any): number | undefined {
  let n: any = node;
  while (n) {
    const st = n.props?.style;
    const flat = Array.isArray(st) ? Object.assign({}, ...st) : st;
    if (flat && typeof flat.opacity === 'number') return flat.opacity;
    n = n.parent;
  }
  return undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBlurImages = false;
});

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

  // The Saved list floats a delete button over the card's top-right corner. The
  // meta row (time · language · country FLAG) is right-aligned, so it runs under
  // that button wherever the button is moved to — on an imageless card the flag
  // was almost entirely covered. The row must reserve the space instead.
  it('reserves meta-row space for a host control when the card has NO image', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion()} // image_url: null
        onPress={jest.fn()}
        metaRowRightReserve={72}
      />,
    );
    // 72 quoted from the card's outer edge, minus the content VStack's own px-4.
    expect(getByTestId('card-meta-row').props.style).toEqual({ paddingRight: 56 });
  });

  it('does NOT reserve when the card HAS a hero image (no layout regression)', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion({ image_url: 'https://example.com/a.jpg' })}
        onPress={jest.fn()}
        metaRowRightReserve={72}
      />,
    );
    // The 192px hero already pushes the meta row clear of the control.
    expect(getByTestId('card-meta-row').props.style).toBeUndefined();
  });

  it('does not reserve when no host control is declared', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    expect(getByTestId('card-meta-row').props.style).toBeUndefined();
  });

  it('does not render the action row without onVerdict (pixel-identical default)', () => {
    const { queryByLabelText } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    expect(queryByLabelText('articleFeedback.likeLabel')).toBeNull();
  });

  it('renders the action row when onVerdict is provided', () => {
    const { getByLabelText } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} onVerdict={jest.fn()} />,
    );
    expect(getByLabelText('articleFeedback.likeLabel')).toBeTruthy();
    expect(getByLabelText('articleFeedback.dislikeLabel')).toBeTruthy();
  });

  it('fires onVerdict with its own suggestion for like + dislike', () => {
    const onVerdict = jest.fn();
    const s = makeSuggestion();
    const { getByLabelText } = render(
      <ArticleSuggestionCard suggestion={s} onPress={jest.fn()} onVerdict={onVerdict} />,
    );
    fireEvent.press(getByLabelText('articleFeedback.likeLabel'));
    expect(onVerdict).toHaveBeenCalledWith(s, 'like');
    fireEvent.press(getByLabelText('articleFeedback.dislikeLabel'));
    expect(onVerdict).toHaveBeenCalledWith(s, 'dislike');
  });

  it('fills the thumb-up green when the verdict is like', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} onVerdict={jest.fn()} verdict="like" />,
    );
    expect(getByTestId('icon-thumbsup').props.fill).toBe('#22C55E');
  });

  it('toggles the card-internal save via the bookmark', async () => {
    const { getByLabelText } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} onVerdict={jest.fn()} />,
    );
    fireEvent.press(getByLabelText('savedSuggestions.saveAction'));
    await waitFor(() => expect(mockSaveSuggestion).toHaveBeenCalled());
  });

  it('shows the share icon only when the suggestion has an article url', () => {
    const withUrl = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion({ article_url: 'https://example.com/a' })}
        onPress={jest.fn()}
        onVerdict={jest.fn()}
      />,
    );
    expect(withUrl.getByLabelText('articleDetail.share')).toBeTruthy();

    const noUrl = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion({ article_url: null })}
        onPress={jest.fn()}
        onVerdict={jest.fn()}
      />,
    );
    expect(noUrl.queryByLabelText('articleDetail.share')).toBeNull();
  });

  it('fires onPress with its own suggestion', () => {
    const onPress = jest.fn();
    const s = makeSuggestion();
    const { getByText } = render(<ArticleSuggestionCard suggestion={s} onPress={onPress} />);
    fireEvent.press(getByText('A headline'));
    expect(onPress).toHaveBeenCalledWith(s);
  });

  it('dims the whole card when dimmed (opacity 0.75)', () => {
    const { getByText } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} dimmed />,
    );
    expect(opacityOf(getByText('A headline'))).toBe(0.75);
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
  it('renders the publication name in the compact footer', () => {
    const { queryByText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    // The redesigned compact card surfaces the source publication in its footer
    // (flag + publisher name), so the name is now expected to render.
    expect(queryByText('Die Zeit')).toBeTruthy();
  });

  it('never mounts a "…" actions button (the compact actions menu was removed)', () => {
    const { queryByLabelText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    expect(queryByLabelText('More actions')).toBeNull();
  });
});

describe('ArticleImagePlaceholder (via the card bases)', () => {
  // The placeholder wraps itself in accessible={false} +
  // importantForAccessibility="no-hide-descendants" — RNTL v13 EXCLUDES that
  // whole subtree from default queries (mirroring how aria-hidden works in
  // DOM Testing Library), so every lookup into it needs
  // `includeHiddenElements: true`. That exclusion is itself proof the
  // decorative-hiding works: a sighted a11y query genuinely can't "see" it.
  it('shows the dark-gradient watermark placeholder on a full-size card with no image', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion({ image_url: null })} onPress={jest.fn()} />,
    );
    expect(getByTestId('placeholder-svg', { includeHiddenElements: true })).toBeTruthy();
    expect(getByTestId('mera-logo', { includeHiddenElements: true })).toBeTruthy();
  });

  it('hides the placeholder from the accessibility tree (decorative, not an article photo)', () => {
    const { getByTestId, queryByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion({ image_url: null })} onPress={jest.fn()} />,
    );
    // Excluded from a default (non-hidden) query — this is the behavior we want.
    expect(queryByTestId('placeholder-svg')).toBeNull();
    // Walk up from the mocked Svg to the wrapping View that carries the
    // accessibility-hiding props.
    let n: any = getByTestId('placeholder-svg', { includeHiddenElements: true }).parent;
    while (n && n.props?.accessible === undefined) n = n.parent;
    expect(n?.props?.accessible).toBe(false);
    expect(n?.props?.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('renders the real image instead of the placeholder when the full-size card has an image', () => {
    const { queryByTestId } = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion({ image_url: 'https://example.com/a.jpg' })}
        onPress={jest.fn()}
      />,
    );
    expect(queryByTestId('placeholder-svg', { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId('mera-logo', { includeHiddenElements: true })).toBeNull();
  });

  it('shows the placeholder on a compact card with no image', () => {
    const { getByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle({ image_url: null })} onPress={jest.fn()} />,
    );
    expect(getByTestId('placeholder-svg', { includeHiddenElements: true })).toBeTruthy();
    expect(getByTestId('mera-logo', { includeHiddenElements: true })).toBeTruthy();
  });

  it('renders the real image instead of the placeholder when the compact card has an image', () => {
    const { queryByTestId } = render(
      <ArticleStandaloneCompactCard
        article={makeArticle({ image_url: 'https://example.com/a.jpg' })}
        onPress={jest.fn()}
      />,
    );
    expect(queryByTestId('placeholder-svg', { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId('mera-logo', { includeHiddenElements: true })).toBeNull();
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
    fireEvent.press(getByLabelText('savedSuggestions.saveAction'));
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
    fireEvent.press(getByLabelText('savedSuggestions.saveAction'));
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
    expect(getByText('savedSuggestions.saveAction')).toBeTruthy();
    expect(getByText('articleDetail.share')).toBeTruthy();
  });

  it('renders nothing when not visible', () => {
    const { queryByText } = render(
      <CompactActionsSheet visible={false} onClose={jest.fn()} subject={subject} article={makeArticle()} />,
    );
    expect(queryByText('articleFeedback.likeLabel')).toBeNull();
  });
});

describe('ArticleStandaloneCompactCard — open-article button', () => {
  it('renders the button and records a visit + opens the browser when pressed', async () => {
    const { getByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    fireEvent.press(getByTestId('card-action-open-article'));
    expect(mockRecordPublicationVisit).toHaveBeenCalledWith(
      expect.objectContaining({ articleUrl: 'https://example.com/s', publicationName: 'Die Zeit' }),
    );
    await waitFor(() =>
      expect(mockOpenArticleInAppBrowser).toHaveBeenCalledWith('https://example.com/s'),
    );
  });

  it('does not render the button when the article has no url', () => {
    const { queryByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle({ article_url: undefined })} onPress={jest.fn()} />,
    );
    expect(queryByTestId('card-action-open-article')).toBeNull();
  });

  it('does not fire the card onPress when the open-article button is pressed', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={onPress} />,
    );
    fireEvent.press(getByTestId('card-action-open-article'));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Blur-images preference — compact card thumbnail', () => {
  it('applies no blurRadius when the preference is off (default)', () => {
    const { getByTestId } = render(
      <ArticleStandaloneCompactCard
        article={makeArticle({ image_url: 'https://example.com/a.jpg' })}
        onPress={jest.fn()}
      />,
    );
    expect(getByTestId('article-image').props.blurRadius).toBeUndefined();
  });

  it('applies blurRadius 24 when the preference is on', () => {
    mockBlurImages = true;
    const { getByTestId } = render(
      <ArticleStandaloneCompactCard
        article={makeArticle({ image_url: 'https://example.com/a.jpg' })}
        onPress={jest.fn()}
      />,
    );
    expect(getByTestId('article-image').props.blurRadius).toBe(24);
  });
});
