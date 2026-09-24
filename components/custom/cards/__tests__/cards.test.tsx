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
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockRouterPush(...a) } }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
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
// Icons render their real icon-font glyph (a private-use character), as on
// device, so a label that would leak it is caught (see icon-glyph-a11y).
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
// lucide icons (the CardActionBar row on ArticleSuggestionCard) → plain views.
jest.mock('lucide-react-native', () => {
  const { View } = require('react-native');
  return {
    ThumbsUp: (p: any) => <View testID="icon-thumbsup" fill={p.fill} color={p.color} />,
    ThumbsDown: (p: any) => <View testID="icon-thumbsdown" fill={p.fill} color={p.color} />,
    Bookmark: (p: any) => <View testID="icon-bookmark" fill={p.fill} color={p.color} />,
    Crosshair: (p: any) => <View testID="icon-crosshair" fill={p.fill} color={p.color} />,
    Share2: (p: any) => <View testID="icon-share" fill={p.fill} color={p.color} />,
    Share: (p: any) => <View testID="icon-share" fill={p.fill} color={p.color} />,
    Ellipsis: (p: any) => <View testID="icon-more" color={p.color} />,
  };
});

// ── Custom children → light stubs that surface the props we assert on ──
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  // `numberOfLines` is passed through, not dropped: the compact card's clamp is
  // a geometry decision (see its `useAdaptiveLineClamp` comment) and a mock that
  // swallows the prop makes it untestable.
  return {
    __esModule: true,
    default: ({ text, numberOfLines }: any) => (
      <Text numberOfLines={numberOfLines}>{text}</Text>
    ),
  };
});
// Identity on `base`, which IS the hook's documented 1x return. Mocked because
// the jest environment reports a 2x `fontScale`, so the real hook here would
// always yield the ceiling and the base could never be observed. The scaling
// itself is covered in lib/typography/__tests__/useAdaptiveLineClamp.test.ts.
const mockUseAdaptiveLineClamp = jest.fn((base: number) => base);
jest.mock('@/lib/typography/useAdaptiveLineClamp', () => ({
  useAdaptiveLineClamp: (...args: [number, number]) =>
    (global as any).__mockUseAdaptiveLineClamp(...args),
}));
(global as any).__mockUseAdaptiveLineClamp = mockUseAdaptiveLineClamp;
jest.mock('@/components/custom/ArticleMetaRow', () => {
  const { Text, View } = require('react-native');
  // `centerAccessory` is rendered, not dropped. The compact card's priority
  // chip lives in this slot, and a mock that swallows it would make "the chip
  // is in the meta row, not the footer" untestable — while still passing.
  return {
    ArticleMetaRow: ({ publicationName, read, centerAccessory, showFlag, countryCode }: any) => (
      <View testID="meta-row" showFlag={showFlag} countryCode={countryCode}>
        <Text>{publicationName ?? ''}</Text>
        {read ? <View testID="read-eye-icon" /> : null}
        {centerAccessory ?? null}
      </View>
    ),
  };
});
jest.mock('@/components/custom/RelevanceChip', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="relevance-chip" /> };
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
// The tree level renders inside the ••• sheet; its own suite covers it.
jest.mock('@/components/custom/feedback-tree/FeedbackTreeLevel', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => <Text testID={`tree-level-${p.root}`}>tree</Text> };
});
jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(async () => ({ version: 1, root: [], likeRoot: [] })),
  refreshFeedbackTree: jest.fn(async () => {}),
}));
jest.mock('@/components/custom/cards/overlay-context', () => ({
  buildOverlayContext: jest.fn(async (s: any) => ({ articleTitle: s.title })),
}));

// ── Service / store seams (all touch the native DB or native modules) ──
// Names are `mock`-prefixed so jest.mock factories may reference them.
const mockRecordArticleFeedback = jest.fn((..._a: any[]) => Promise.resolve());
const mockRemoveArticleFeedback = jest.fn((..._a: any[]) => Promise.resolve());
const mockHasLiked = jest.fn((..._a: any[]) => Promise.resolve(false));
jest.mock('@/lib/database/services/article-feedback-service', () => ({
  // Latest wins: every row records through the exclusive writer.
  recordVerdictFeedback: (...a: any[]) => mockRecordArticleFeedback(...a),
  getArticleVerdict: jest.fn(async () => ({ verdict: null, path: [] })),
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
  useTrackButton: () => ({
    tracked: false,
    resolve: () => 'start',
    startTracking: jest.fn(),
    goToStory: jest.fn(),
    seePlans: jest.fn(async () => {}),
  }),
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
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { StyleSheet } from 'react-native';
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
import ArticleSuggestionCompactCard from '../ArticleSuggestionCompactCard';
// eslint-disable-next-line import/first
import { ArticleImagePlaceholder } from '../ArticleImagePlaceholder';
// eslint-disable-next-line import/first
import { COMPACT_HEADLINE_LINES, COMPACT_IMAGE_SIZE, COMPACT_IMAGE_TILE } from '../ArticleCompactCardBase';
// eslint-disable-next-line import/first
import { privateUseLabelLeaks } from '@/lib/__test-helpers__/icon-glyph-a11y';
import ArticleActionsRow from '../ArticleActionsRow';
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

  // F24: the note gets the width. It sits on its own row under the chip,
  // left-aligned, never in a ragged right-aligned column beside it.
  it('puts the note on its own full-width row under the chip, left-aligned', () => {
    const { getByText, getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    const noteRow = getByTestId('card-reason-text');
    const chip = getByTestId('relevance-chip');
    // The chip is not inside the note's row, and the note is not inside the
    // chip's row.
    let n: any = chip;
    while (n) {
      expect(n).not.toBe(noteRow);
      n = n.parent;
    }
    let m: any = getByText('Because you follow Berlin');
    let inNoteRow = false;
    while (m) {
      if (m === noteRow) inNoteRow = true;
      expect(m).not.toBe(chip.parent);
      m = m.parent;
    }
    expect(inNoteRow).toBe(true);
    expect(String(getByText('Because you follow Berlin').props.className ?? '')).not.toContain('text-right');
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

  // Pressed feedback is OPT-IN on card bases (not a Pressable default) and
  // multiplies with the dimmed treatment rather than replacing it.
  // The pressed state is React state applied as a STATIC style (PressableCard):
  // a function `style` on a Pressable is dropped on device here.
  it('reacts to a press: 0.7 while held, full opacity at rest', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    const card = () => getByTestId('card-sugg-1');
    expect(typeof card().props.style).not.toBe('function');
    expect(StyleSheet.flatten(card().props.style)?.opacity ?? 1).toBe(1);
    act(() => {
      fireEvent(card(), 'pressIn');
    });
    expect(StyleSheet.flatten(card().props.style).opacity).toBeCloseTo(0.7);
    act(() => {
      fireEvent(card(), 'pressOut');
    });
    expect(StyleSheet.flatten(card().props.style)?.opacity ?? 1).toBe(1);
  });

  it('a dimmed card still reacts to a press (0.75 x 0.7)', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} dimmed />,
    );
    const card = () => getByTestId('card-sugg-1');
    expect(StyleSheet.flatten(card().props.style).opacity).toBeCloseTo(0.75);
    act(() => {
      fireEvent(card(), 'pressIn');
    });
    expect(StyleSheet.flatten(card().props.style).opacity).toBeCloseTo(0.525);
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

  // Owner review: compact rows carry NO inline action row. One small ••• at the
  // right end of the publisher line (44pt target) opens the shared menu, which
  // gains Like / Not for me / Save / Share on compact surfaces.
  it('draws no inline action row, only a 44pt ••• on the publisher line', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    for (const id of ['card-action-like', 'card-action-dislike', 'card-action-save', 'card-action-share']) {
      expect(queryByTestId(id)).toBeNull();
    }
    const more = getByTestId('compact-card-more');
    const { StyleSheet } = require('react-native');
    expect(StyleSheet.flatten(more.props.style)).toEqual(expect.objectContaining({ minWidth: 44, minHeight: 44 }));
    // Same line as the publisher.
    const line = getByTestId('compact-card-footer');
    const inLine = (n: any): boolean => {
      for (let p = n; p; p = p.parent) if (p === line) return true;
      return false;
    };
    expect(inLine(more)).toBe(true);
    expect(inLine(getByText('Die Zeit'))).toBe(true);
  });

  it('the compact menu leads with Like, Not for me, Save and Share', () => {
    const { getByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    fireEvent.press(getByTestId('compact-card-more'));
    for (const id of ['menu-like', 'menu-dislike', 'menu-save', 'menu-share', 'card-action-mera']) {
      expect(getByTestId(id)).toBeTruthy();
    }
  });

  it('moves the country flag to the top row, beside the language', () => {
    const { getByTestId, queryByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    const meta = getByTestId('meta-row');
    expect(meta.props.showFlag).toBe(true);
    expect(meta.props.countryCode).toBe('DE');
    expect(queryByTestId('compact-footer-flag')).toBeNull();
  });

  it('opens the ••• menu from the button and from a long-press', async () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    expect(queryByTestId('article-menu')).toBeNull();
    fireEvent.press(getByTestId('compact-card-more'));
    expect(getByTestId('article-menu')).toBeTruthy();
    fireEvent.press(getByTestId('article-menu-cancel'));
    // The sheet slides down before it goes.
    await waitFor(() => expect(queryByTestId('article-menu')).toBeNull());
    fireEvent(getByText('Standalone headline'), 'longPress');
    expect(getByTestId('article-menu')).toBeTruthy();
  });

  it('keeps a surface-supplied long-press instead of the menu', () => {
    const onLongPress = jest.fn();
    const { getByText, queryByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} onLongPress={onLongPress} />,
    );
    fireEvent(getByText('Standalone headline'), 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(queryByTestId('article-menu')).toBeNull();
  });

  it('keeps every action as a VoiceOver custom action on the row', () => {
    const { getByTestId } = render(
      <ArticleStandaloneCompactCard testID="row" article={makeArticle()} onPress={jest.fn()} />,
    );
    const names = (getByTestId('row').props.accessibilityActions ?? []).map((a: any) => a.name);
    expect(names.slice(0, 4)).toEqual(['like', 'dislike', 'save', 'share']);
    expect(names).toContain('ask');
  });
});

describe('no image ⇒ no image region (either card base)', () => {
  // NEITHER card base draws a watermark for an imageless article any more. The
  // dimmed Mera glyph read as a broken photo rather than as a deliberate
  // marker, so the full-size card drops its band and starts at the meta row,
  // and the compact row drops its image square and lets the headline run the
  // full width. `ArticleImagePlaceholder` survives for exactly one consumer,
  // the chat "About this story" card, and is unit-tested directly below rather
  // than through whichever card happens to mount one.
  //
  // Lookups still pass `includeHiddenElements: true` because the placeholder
  // hides itself from the a11y tree, and RNTL v13 excludes that subtree from
  // default queries. Without the flag these assertions would pass whether the
  // watermark rendered or not.
  it('renders no placeholder at all on a full-size card with no image', () => {
    const { queryByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion({ image_url: null })} onPress={jest.fn()} />,
    );
    expect(queryByTestId('placeholder-ground', { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId('mera-logo', { includeHiddenElements: true })).toBeNull();
  });

  it('renders the real image instead of the placeholder when the full-size card has an image', () => {
    const { queryByTestId } = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion({ image_url: 'https://example.com/a.jpg' })}
        onPress={jest.fn()}
      />,
    );
    expect(queryByTestId('placeholder-ground', { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId('mera-logo', { includeHiddenElements: true })).toBeNull();
  });

  it('renders no placeholder and no image on a compact card with no image', () => {
    const { queryByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle({ image_url: null })} onPress={jest.fn()} />,
    );
    expect(queryByTestId('placeholder-ground', { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId('mera-logo', { includeHiddenElements: true })).toBeNull();
    // The whole square is absent, not merely empty — that is what lets the
    // headline column run to the card's right edge.
    expect(queryByTestId('article-image')).toBeNull();
  });

  it('renders the real image instead of the placeholder when the compact card has an image', () => {
    const { queryByTestId } = render(
      <ArticleStandaloneCompactCard
        article={makeArticle({ image_url: 'https://example.com/a.jpg' })}
        onPress={jest.fn()}
      />,
    );
    expect(queryByTestId('placeholder-ground', { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId('mera-logo', { includeHiddenElements: true })).toBeNull();
  });

  // `showImage` tracks LOADED, not merely PASSED IN. The guard used to be
  // `imageUrl ? <Image/> : <Placeholder/>`, which never noticed a 404 or a
  // timeout and left an empty quarter-width column on every surface that
  // renders this shared chrome (saved suggestions, related articles, story
  // timeline, publication history, persona article list). A broken image must
  // end up looking exactly like no image, which now means no square at all.
  it('drops the image square after the compact card image fails to load (onError)', () => {
    const { getByTestId, queryByTestId } = render(
      <ArticleStandaloneCompactCard
        article={makeArticle({ image_url: 'https://example.com/broken.jpg' })}
        onPress={jest.fn()}
      />,
    );
    expect(getByTestId('article-image')).toBeTruthy();

    fireEvent(getByTestId('article-image'), 'error');

    expect(queryByTestId('article-image')).toBeNull();
    expect(queryByTestId('placeholder-ground', { includeHiddenElements: true })).toBeNull();
    expect(queryByTestId('mera-logo', { includeHiddenElements: true })).toBeNull();
  });
});

describe('compact card image loading tile (F39)', () => {
  it('puts a tile behind the square so the image never pops into a blank hole', () => {
    const { UNSAFE_root } = render(
      <ArticleStandaloneCompactCard article={makeArticle({ image_url: 'https://x/i.jpg' } as any)} onPress={jest.fn()} />,
    );
    const square = UNSAFE_root.findAll(
      (n: any) => typeof n.type === 'string' && n.props?.style?.width === COMPACT_IMAGE_SIZE,
    )[0];
    expect(square.props.style.backgroundColor).toBe(COMPACT_IMAGE_TILE);
  });
});

describe('compact card headline clamp', () => {
  // 3 is not an arbitrary nicety. The image square is 78px and the `md` line box
  // is 24px, so three lines (72px) fit INSIDE the square and four (96px) would
  // make the row taller. Two lines spent the difference on an ellipsis. If the
  // square or the type token ever changes, this number has to be rederived —
  // which is exactly why it is pinned rather than left implicit.
  //
  // The clamp asked for is what is pinned here, not the scaled result: the jest
  // environment reports a 2x `fontScale`, so the scaled value in this harness is
  // the CEILING, never the base. How base becomes a scaled value is the hook's
  // own contract and is tested in lib/typography/__tests__.
  const LONG = 'A headline long enough to need every line it is given';

  it('asks for 3 lines with a ceiling of 4, and that reaches the headline', () => {
    const { getByText } = render(
      <ArticleStandaloneCompactCard
        article={makeArticle({ title_en_internal_only: LONG })}
        onPress={jest.fn()}
      />,
    );
    expect(mockUseAdaptiveLineClamp).toHaveBeenCalledWith(COMPACT_HEADLINE_LINES, 4);
    // The mock is identity on `base`, so this is the 1x rendering.
    expect(getByText(LONG).props.numberOfLines).toBe(COMPACT_HEADLINE_LINES);
  });

  // The image is sized against the text beside it, so a change to either the
  // clamp or the type scale must move it too. Written as the arithmetic rather
  // than as `105` for the same reason the component is: the failure mode is
  // silent, an image that no longer lines up with the block it was cut to fit.
  it('sizes the image as the headline block plus the footer line', () => {
    const HEADLINE_LINE_BOX = 24; // tailwind fontSize.base
    const FOOTER_LINE_BOX = 21; // tailwind fontSize.sm
    const FOOTER_GAP = 12;
    expect(COMPACT_IMAGE_SIZE).toBe(
      COMPACT_HEADLINE_LINES * HEADLINE_LINE_BOX + FOOTER_GAP + FOOTER_LINE_BOX,
    );
    expect(COMPACT_IMAGE_SIZE).toBe(105);
  });
});

describe('compact card priority chip', () => {
  it('renders the chip inside the meta row, not the footer', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCompactCard suggestion={makeSuggestion()} onPress={jest.fn()} />,
    );
    const metaRow = getByTestId('meta-row');
    const chip = getByTestId('relevance-chip');
    // Walk up from the chip: the meta row has to be one of its ancestors.
    let n: any = chip.parent;
    while (n && n !== metaRow) n = n.parent;
    expect(n).toBe(metaRow);
  });

  it('renders no chip while the suggestion is unscored', () => {
    const { queryByTestId } = render(
      <ArticleSuggestionCompactCard
        suggestion={makeSuggestion({ status: ArticleSuggestionStatus.Unscored })}
        onPress={jest.fn()}
      />,
    );
    expect(queryByTestId('relevance-chip')).toBeNull();
  });
});

describe('ArticleImagePlaceholder (direct)', () => {
  // Tested directly rather than through a card: the chat "About this story"
  // card is its only remaining consumer, and mounting that pulls in the
  // WatermelonDB lookup it uses to resolve an image url. The behavior under
  // test belongs to the placeholder either way.
  it('hides itself from the accessibility tree (decorative, not an article photo)', () => {
    const { getByTestId, queryByTestId } = render(<ArticleImagePlaceholder />);

    // Excluded from a default (non-hidden) query — this is the behavior we want.
    expect(queryByTestId('placeholder-ground')).toBeNull();

    // Walk up from the ground View to the View carrying the hiding props. The
    // ground is a child of that wrapper, so the walk terminates on the wrapper
    // itself; asserting both props pins that it did not run past it to some
    // ancestor that happens to set `accessible`.
    let n: any = getByTestId('placeholder-ground', { includeHiddenElements: true }).parent;
    while (n && n.props?.accessible === undefined) n = n.parent;
    expect(n?.props?.accessible).toBe(false);
    expect(n?.props?.importantForAccessibility).toBe('no-hide-descendants');
    expect(n?.props?.accessibilityElementsHidden).toBe(true);
  });

  it('renders the Mera glyph it exists to show', () => {
    const { getByTestId } = render(<ArticleImagePlaceholder />);
    expect(getByTestId('mera-logo', { includeHiddenElements: true })).toBeTruthy();
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

  // The Saved card's inline thumbs open the SAME sheet as the ••• menu,
  // straight at the tree's root: no second Modal, no Back row.
  it('opens the shared sheet at the tree root, with no Back row, on a thumb', async () => {
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <ArticleActionsRow subject={subject} article={makeArticle()} />,
    );
    fireEvent.press(getByLabelText('articleFeedback.likeLabel'));
    expect(await waitFor(() => getByTestId('tree-level-like'))).toBeTruthy();
    expect(queryByTestId('sheet-back')).toBeNull();
    expect(getByTestId('article-menu-cancel')).toBeTruthy();
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

// Owner review: the importance badge and the AI disclosure share ONE row
// (badge left, disclosure right), the note runs full width below, and there is
// no fact chip and no second disclosure line under the note.
describe('ArticleSuggestionCard note block', () => {
  it('puts the AI disclosure at the right end of the badge row, once', () => {
    const { getByTestId, queryAllByText, queryByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion({ _id: 'sugg-note' })} onPress={jest.fn()} onVerdict={jest.fn()} />,
    );
    const row = getByTestId('card-reason-badge-row');
    expect(String(row.props.className)).toContain('justify-between');
    const inRow = (n: any): boolean => {
      for (let p = n; p; p = p.parent) if (p === row) return true;
      return false;
    };
    const disclosures = queryAllByText('aiDisclosure.caption');
    expect(disclosures).toHaveLength(1);
    expect(inRow(disclosures[0])).toBe(true);
    expect(queryByTestId('card-fact-chip')).toBeNull();
  });
});

// Owner: the Feed card's thumbs open the SAME ••• sheet as the menu, straight
// at the tree root with no Back row. One behaviour throughout the app; the
// inline floating panel is gone.
describe('ArticleSuggestionCard thumbs open the shared sheet', () => {
  const handlers = () => ({
    onLeafPicked: jest.fn(),
    onInvokeMera: jest.fn(),
    onBrowseRelated: jest.fn(),
  });

  it.each([
    ['like', 'articleFeedback.likeLabel'],
    ['dislike', 'articleFeedback.dislikeLabel'],
  ])('a %s thumb records the verdict, then opens the sheet at its tree root with no Back row', async (v, label) => {
    const onVerdict = jest.fn();
    const s = makeSuggestion();
    const { getByLabelText, getByTestId, queryByTestId } = render(
      <ArticleSuggestionCard suggestion={s} onPress={jest.fn()} onVerdict={onVerdict} feedbackHandlers={handlers()} />,
    );
    fireEvent.press(getByLabelText(label));
    expect(onVerdict).toHaveBeenCalledWith(s, v);
    const tree = await waitFor(() => getByTestId(`tree-level-${v}`));
    // Inside the sheet, not an inline panel on the card.
    let inSheet = false;
    for (let p: any = tree; p; p = p.parent) if (p.props?.testID === 'article-menu') inSheet = true;
    expect(inSheet).toBe(true);
    expect(queryByTestId('sheet-back')).toBeNull();
    expect(getByTestId('article-menu-cancel')).toBeTruthy();
  });

  it('never mounts the inline panel, even with a stored verdict', () => {
    const { queryByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} onVerdict={jest.fn()} verdict="dislike" feedbackHandlers={handlers()} />,
    );
    expect(queryByTestId('tree-level-dislike')).toBeNull();
    expect(queryByTestId('article-menu')).toBeNull();
  });

  it('a second tap on the recorded thumb removes it and opens nothing', async () => {
    const onVerdict = jest.fn();
    const s = makeSuggestion();
    const { getByLabelText, queryByTestId } = render(
      <ArticleSuggestionCard suggestion={s} onPress={jest.fn()} onVerdict={onVerdict} verdict="like" feedbackHandlers={handlers()} />,
    );
    fireEvent.press(getByLabelText('articleFeedback.likeLabel'));
    expect(onVerdict).toHaveBeenCalledWith(s, 'like');
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('article-menu')).toBeNull();
  });

  it('the VoiceOver like action opens the same sheet', async () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} onVerdict={jest.fn()} feedbackHandlers={handlers()} />,
    );
    act(() => {
      getByTestId('card-sugg-1').props.onAccessibilityAction({ nativeEvent: { actionName: 'inline-like' } });
    });
    expect(await waitFor(() => getByTestId('tree-level-like'))).toBeTruthy();
  });
});

describe('ArticleSuggestionCard VoiceOver actions', () => {
  it('reaches the action row through custom actions, inline buttons first', () => {
    const onVerdict = jest.fn();
    const { getByTestId } = render(
      <ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} onVerdict={onVerdict} />,
    );
    const root = getByTestId('card-sugg-1');
    const names = root.props.accessibilityActions.map((x: any) => x.name);
    expect(names.slice(0, 2)).toEqual(['inline-like', 'inline-dislike']);
    act(() => {
      root.props.onAccessibilityAction({ nativeEvent: { actionName: 'inline-dislike' } });
    });
    expect(onVerdict).toHaveBeenCalledWith(expect.objectContaining({ _id: 'sugg-1' }), 'dislike');
  });
});

describe('ArticleSuggestionCompactCard action row', () => {
  it('records a like from the menu\'s Like with the suggestion subject', async () => {
    const { getByTestId } = render(
      <ArticleSuggestionCompactCard suggestion={makeSuggestion()} onPress={jest.fn()} surface="for_you" />,
    );
    act(() => {
      getByTestId('card-sugg-1').props.onAccessibilityAction({ nativeEvent: { actionName: 'like' } });
    });
    await waitFor(() =>
      expect(mockRecordArticleFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ articleId: 'art-1', suggestionId: 'sugg-1', sentiment: 'like', origin: 'suggestion', surface: 'for_you' }),
      ),
    );
  });
});

// A TAP on a compact row never reaches the publisher URL: it hands the tap to
// `onPress`, which navigates to a detail screen. Opening the publisher from a
// row goes through the ••• menu, which offers the translate route beside it.
describe('ArticleStandaloneCompactCard — never opens the article URL directly', () => {
  it('renders no direct-open button', () => {
    const { queryByTestId } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />,
    );
    expect(queryByTestId('card-action-open-article')).toBeNull();
  });

  it('tapping the row calls onPress and opens no browser / records no visit', async () => {
    const onPress = jest.fn();
    const { getByText } = render(
      <ArticleStandaloneCompactCard article={makeArticle()} onPress={onPress} />,
    );
    fireEvent.press(getByText('Standalone headline'));
    expect(onPress).toHaveBeenCalled();
    await waitFor(() => expect(mockOpenArticleInAppBrowser).not.toHaveBeenCalled());
    expect(mockRecordPublicationVisit).not.toHaveBeenCalled();
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

// Owner: ONE behaviour for every entry point. A tap on a thumb (inline) or on
// "I like it" / "Not for me" (•••) records the verdict AT ONCE and the thumb
// fills at once; the sheet that opens is optional refinement, and Cancel keeps
// the verdict. D15 still holds: a bare verdict is stored and shown but stamped
// processed at write, so it never reaches the digest.
describe('a recorded verdict is immediate and identical on every path', () => {
  const subject: FeedbackSubject = {
    origin: 'article',
    surface: 'explore',
    articleId: 'art-9',
    title: 'Standalone headline',
    publicationName: 'Die Zeit',
    countryCode: 'DE',
  };

  it('the Feed card fills a recorded verdict before any leaf is picked', () => {
    const { getByTestId } = render(
      <ArticleSuggestionCard
        suggestion={makeSuggestion()}
        onPress={jest.fn()}
        onVerdict={jest.fn()}
        verdict="dislike"
        feedbackHandlers={{ onLeafPicked: jest.fn(), onInvokeMera: jest.fn(), onBrowseRelated: jest.fn() }}
      />,
    );
    expect(getByTestId('icon-thumbsdown').props.fill).toBe('#EF4444');
  });

  it('inline thumb then Cancel, and ••• "I like it" then Cancel, store the same verdict and both read as liked', async () => {
    // Inline path: the Saved standalone card's row.
    const inline = render(<ArticleActionsRow subject={subject} article={makeArticle()} />);
    fireEvent.press(inline.getByLabelText('articleFeedback.likeLabel'));
    await waitFor(() => inline.getByTestId('article-menu-cancel'));
    fireEvent.press(inline.getByTestId('article-menu-cancel'));
    await waitFor(() => expect(mockRecordArticleFeedback).toHaveBeenCalledTimes(1));
    const inlineCall = mockRecordArticleFeedback.mock.calls[0][0];
    expect(inline.getByTestId('icon-thumbsup').props.fill).toBe('#22C55E');
    inline.unmount();

    // ••• path: a compact row's menu.
    const menu = render(<ArticleStandaloneCompactCard article={makeArticle({ _id: 'art-9' })} onPress={jest.fn()} />);
    fireEvent.press(menu.getByTestId('compact-card-more'));
    fireEvent.press(menu.getByTestId('menu-like'));
    await waitFor(() => menu.getByTestId('tree-level-like'));
    fireEvent.press(menu.getByTestId('article-menu-cancel'));
    await waitFor(() => expect(mockRecordArticleFeedback).toHaveBeenCalledTimes(2));
    const menuCall = mockRecordArticleFeedback.mock.calls[1][0];

    // Same stored state: one like row for the article, nothing removed.
    for (const key of ['articleId', 'sentiment', 'origin']) {
      expect(menuCall[key]).toEqual(inlineCall[key]);
    }
    expect(mockRemoveArticleFeedback).not.toHaveBeenCalled();
    fireEvent.press(menu.getByTestId('compact-card-more'));
    expect(menu.getByTestId('menu-like').props.accessibilityLabel).toBe('articleMenu.removeLike');
  });
});

// Batch 16: the ••• sheet's title must be what the card shows (same component,
// same text / original / language), not the pipeline's English title.
describe('the ••• sheet title matches the card title', () => {
  const titleProps = (r: any) =>
    r.UNSAFE_root.findAll((n: any) => n.type === require('@/components/custom/TranslatableDynamic').default)
      .map((n: any) => ({ text: n.props.text, originalText: n.props.originalText, originalLanguage: n.props.originalLanguage }));

  it('on a compact suggestion row', () => {
    const s = makeSuggestion({ title_en: 'Cybersecurity experts warn that the FBI breach could', title_original: 'Cyber experts warn FBI breach could', language_code: 'en' });
    const r = render(<ArticleSuggestionCompactCard suggestion={s} onPress={jest.fn()} surface="for_you" />);
    const [card] = titleProps(r);
    fireEvent.press(r.getByTestId('compact-card-more'));
    const all = titleProps(r);
    expect(all.length).toBeGreaterThan(1);
    expect(all[all.length - 1]).toEqual(card);
  });

  it('on a Feed card', () => {
    const s = makeSuggestion({ title_en: 'Cybersecurity experts warn that the FBI breach could', title_original: 'Cyber experts warn FBI breach could', language_code: 'en' });
    const r = render(<ArticleSuggestionCard suggestion={s} onPress={jest.fn()} onVerdict={jest.fn()} />);
    const [card] = titleProps(r);
    fireEvent.press(r.getByTestId('card-action-more'));
    const all = titleProps(r);
    expect(all.length).toBeGreaterThan(1);
    expect(all[all.length - 1]).toEqual(card);
  });
});


// The Dashboard's floating card surface is ONE component (FlatCardSurface),
// shared with the followed-story rows, so the two can never drift apart.
describe('flat card surface is shared', () => {
  it('a flat article card draws the shared card-surface', () => {
    const { getByTestId } = render(<ArticleSuggestionCard suggestion={makeSuggestion()} onPress={jest.fn()} flat />);
    expect(getByTestId('card-surface').props.className).toEqual(expect.stringContaining('border-white/10'));
  });
});

// No card, row or button reads out an icon-font glyph to VoiceOver.
describe('no icon glyph in any card label', () => {
  it.each([
    ['compact suggestion row', () => <ArticleSuggestionCompactCard suggestion={makeSuggestion()} onPress={jest.fn()} surface="for_you" />],
    ['compact article row', () => <ArticleStandaloneCompactCard article={makeArticle()} onPress={jest.fn()} />],
    ['standalone card', () => <ArticleStandaloneCard article={makeArticle()} onPress={jest.fn()} />],
  ] as const)('%s', (_n, make) => {
    const r = render(make());
    expect(privateUseLabelLeaks(r.UNSAFE_root)).toEqual([]);
  });
  // KNOWN LEAK, pending a decision: a full-size (Feed / Dashboard) card root has
  // no explicit label, so VoiceOver reads all its text run together, including
  // the AI disclosure's `auto-awesome` glyph. Fixing it means designing the
  // card's spoken label (or hiding the decorative icon, which needs a device
  // check on Fabric), so it is escalated rather than guessed.
  it.todo('Feed and Dashboard card roots read no icon glyph');
});
