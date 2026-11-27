// AllCaughtUpCard's fold variants, the "reports" row, the card-size freeze and the compact
// row's feedback wiring.
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import ArticleCardBase from '@/components/custom/cards/ArticleCardBase';
import SimilarArticlesRow from '@/components/custom/cards/SimilarArticlesRow';
import { newFeedRowSession, resolveFeedRowDisplay } from '@/components/custom/feed/feed-row-display';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const { useRef } = require('react');
  return {
    __esModule: true,
    default: { View },
    Easing: require('react-native').Easing,
    useSharedValue: (v: unknown) => useRef({ value: v }).current,
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => false,
    cancelAnimation: () => {},
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withSpring: (v: unknown) => v,
    withSequence: (v: unknown) => v,
    withDelay: (_d: unknown, v: unknown) => v,
    interpolate: () => 0,
    runOnJS: (f: unknown) => f,
  };
});

const mockMenuArgs: { current: Record<string, unknown> | null } = { current: null };
jest.mock('@/components/custom/cards/use-article-menu', () => ({
  useArticleMenu: (args: Record<string, unknown>) => {
    mockMenuArgs.current = args;
    return { open: jest.fn(), element: null, accessibilityActions: [], onAccessibilityAction: jest.fn(), openPublication: jest.fn() };
  },
}));
jest.mock('@/components/custom/cards/use-article-actions', () => ({
  useArticleActions: () => ({
    answered: false, saved: false, onToggleSave: jest.fn(), onShare: jest.fn(), archiveItem: undefined, onVerdictRecorded: jest.fn(),
  }),
}));

beforeAll(initI18nEn);

describe('AllCaughtUpCard Feed variants', () => {
  it('seen label: its own header text', async () => {
    const { getByTestId } = await render(<AllCaughtUpCard variant="label" seen />);
    expect(getByTestId('fold-seen-label').props.children).toBe('Stories you already saw');
    expect(getByTestId('fold-seen-label').props.accessibilityRole).toBe('header');
  });
  it('label: a plain header; mounting it (a virtualized cell scrolling back) announces nothing', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const { getByTestId } = await render(<AllCaughtUpCard variant="label" />);
    expect(getByTestId('fold-label').props.children).toBe('Good to know');
    expect(getByTestId('fold-label').props.accessibilityRole).toBe('header');
    expect(announce).not.toHaveBeenCalled();
  });
  it('end: keeps Refresh without "ready to read more", with the still mindfulness line', async () => {
    const { getByTestId, getByText, queryByText } = await render(<AllCaughtUpCard variant="end" onRefresh={() => {}} />);
    expect(getByText("That's everything for now.")).toBeTruthy();
    expect(getByText('Mera keeps reading in the background. Check back later.')).toBeTruthy();
    expect(getByTestId('all-caught-up-mindful')).toBeTruthy();
    expect(getByTestId('all-caught-up-refresh')).toBeTruthy();
    expect(queryByText('Are you ready to read more?')).toBeNull();
  });
  it('end: the held line sits above Refresh', async () => {
    const { getByTestId } = await render(<AllCaughtUpCard variant="end" held onRefresh={() => {}} />);
    expect(getByTestId('fold-held-line')).toBeTruthy();
    expect(getByTestId('all-caught-up-refresh')).toBeTruthy();
  });
  it('reading: the quiet line only', async () => {
    const { getByText } = await render(<AllCaughtUpCard variant="reading" />);
    expect(getByText('Mera is still reading. New stories will show up here.')).toBeTruthy();
  });
});

describe('reports variant', () => {
  it('shows "N more reports" with the global gate OFF, in the row and the spoken label', async () => {
    const row = await render(<SimilarArticlesRow count={2} variant="reports" />);
    expect(row.getByText('2 more reports')).toBeTruthy();
    const card = await render(<ArticleCompactCardBase titleEnglish="A story" testID="c" similarCount={1} similarVariant="reports" />);
    expect(card.getByText('1 more report')).toBeTruthy();
    expect(card.getByLabelText(/1 more report/)).toBeTruthy();
    const big = await render(<ArticleCardBase titleEnglish="A story" testID="b" footer={<></>} similarCount={3} similarVariant="reports" />);
    expect(big.getByLabelText(/3 more reports/)).toBeTruthy();
  });
  it('a compact row keeps its row at count 0 (a member leaving must not shrink it)', async () => {
    const card = await render(<ArticleCompactCardBase titleEnglish="A story" testID="c" similarCount={0} similarVariant="reports" />);
    expect(card.getByTestId('card-similar-articles')).toBeTruthy();
    expect(card.queryByText(/more report/)).toBeNull();
  });
  it('the default variant stays off with the gate off', async () => {
    const card = await render(<ArticleCompactCardBase titleEnglish="A story" testID="c" similarCount={3} />);
    expect(card.queryByTestId('card-similar-articles')).toBeNull();
  });
});

describe('Feed card meta row (owner)', () => {
  it('compact: the priority chip sits left and the short age in the middle', async () => {
    const { getByTestId, getByText } = await render(
      <ArticleCompactCardBase
        titleEnglish="A story"
        testID="c"
        pubDate={new Date(Date.now() - 4 * 86400e3).toISOString()}
        priorityAccessory={<Text testID="chip">Low</Text>}
      />,
    );
    expect(getByTestId('meta-leading')).toContainElement(getByTestId('chip'));
    expect(getByTestId('meta-age-slot')).toContainElement(getByText('4d ago'));
  });
  it('large: the short age is in the meta row, no separate label line', async () => {
    const { getByText, queryByTestId } = await render(
      <ArticleCardBase titleEnglish="A story" testID="b" publicationName="Pub" pubDate={new Date(Date.now() - 2 * 86400e3).toISOString()} />,
    );
    expect(getByText('2d ago')).toBeTruthy();
    expect(queryByTestId('card-age-label')).toBeNull();
  });
});

function sugg(id: string, relevance: number): ForYouSuggestion {
  return {
    _id: id, articleId: `art-${id}`, clusters: [], relevance, reason: '', status: 'complete' as ForYouSuggestion['status'],
    country_code: null, language_code: 'en', publication_name: 'Pub', title_en: `T ${id}`, title_original: null,
    description_en: null, article_url: null, image_url: null, userTopicIds: [], createdAt: new Date(0).toISOString(),
    firstPubDate: new Date(0).toISOString(), rawScore: null, eventType: null, headlineScope: null, matchedTopics: [],
  };
}
const rowOf = (s: ForYouSuggestion) => ({ id: s._id, suggestion: s, memberCount: 1, memberIds: [s._id], breaking: false, score: 1 });

describe('card size freeze', () => {
  it('High is large, Medium and Low compact, and a rescore does not change it this session', () => {
    const session = newFeedRowSession();
    const med = sugg('m', 0.65);
    expect(resolveFeedRowDisplay(rowOf(sugg('h', 0.85)), new Map(), session).compact).toBe(false);
    expect(resolveFeedRowDisplay(rowOf(med), new Map(), session).compact).toBe(true);
    expect(resolveFeedRowDisplay(rowOf(sugg('l', 0.45)), new Map(), session).compact).toBe(true);
    const rescored = sugg('m', 0.9);
    expect(resolveFeedRowDisplay(rowOf(rescored), new Map([['m', rescored]]), session).compact).toBe(true);
    expect(resolveFeedRowDisplay(rowOf(rescored), new Map(), newFeedRowSession()).compact).toBe(false);
  });
});

describe('compact row feedback wiring', () => {
  it('sends the verdict and the Mera handoff through the Feed handlers and dims on a verdict', async () => {
    const s = sugg('x', 0.6);
    const feedbackHandlers = { onVerdictRecorded: jest.fn(), onInvokeMera: jest.fn() };
    await render(<ArticleSuggestionCompactCard suggestion={s} onPress={() => {}} feedbackHandlers={feedbackHandlers} verdict="dislike" />);
    (mockMenuArgs.current!.onVerdictRecorded as () => void)();
    expect(feedbackHandlers.onVerdictRecorded).toHaveBeenCalledWith(s);
    (mockMenuArgs.current!.onFeedbackChat as (p: string[], a: unknown) => void)(['a'], {});
    expect(feedbackHandlers.onInvokeMera).toHaveBeenCalledWith(s, ['a'], {});
  });
});
