// Related coverage rows: the card's `title` is the ORIGINAL headline (the compact card
// passes it to TranslatableDynamic as originalText beside the source language code), and
// English only when no original exists. English beside a `hi` code reads as "already in
// a Hindi reader's language", so a Hindi app showed English and never translated.
import { suggestionToNewsArticle, toNewsArticle } from '@/components/custom/news-detail/useArticleSuggestionScreen';
import type { ArticleSummary } from '@/lib/generated/graphql-types';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { renderHook, waitFor } from '@testing-library/react-native';
import { useArticleDetailScreen } from '@/components/custom/news-detail/useArticleDetailScreen';
import { useNetworkStore } from '@/lib/stores/network-store';
import { ARTICLE_IDS } from '@/test/mock-backend/fixtures/articles';
import { initI18nEn, mockGql, server, signInFixtureAccount } from '@/test/helpers';

const hindiSuggestion = {
    articleId: 'a1',
    title_en: 'Monsoon reaches Delhi',
    title_original: 'दिल्ली पहुंचा मानसून',
    language_code: 'hi',
    createdAt: '2026-10-24T00:00:00Z',
} as unknown as ForYouSuggestion;

describe('related rows keep the original headline', () => {
    it('a Hindi local sibling keeps title_original as the card title', () => {
        const a = suggestionToNewsArticle(hindiSuggestion);
        expect(a.title).toBe('दिल्ली पहुंचा मानसून');
        expect(a.title_en_internal_only).toBe('Monsoon reaches Delhi');
        expect(a.original_language_code).toBe('hi');
    });

    it('a local sibling with no original falls back to English', () => {
        const a = suggestionToNewsArticle({ ...hindiSuggestion, title_original: null } as unknown as ForYouSuggestion);
        expect(a.title).toBe('Monsoon reaches Delhi');
    });
});

const summary = {
    _id: 's1',
    title_en: 'Election results announced',
    title_original: '選挙結果が発表された',
    language_code: 'ja',
    pubDate: '2026-10-24T00:00:00Z',
} as unknown as ArticleSummary;

describe('server related rows keep the original headline', () => {
    it('a Japanese summary keeps title_original as the card title, English as the internal title', () => {
        const a = toNewsArticle(summary);
        expect(a.title).toBe('選挙結果が発表された');
        expect(a.title_en_internal_only).toBe('Election results announced');
        expect(a.original_language_code).toBe('ja');
    });

    it('a server that predates title_original falls back to English', () => {
        expect(toNewsArticle({ ...summary, title_original: undefined }).title).toBe('Election results announced');
    });
});

describe('the article-detail route maps its related rows the same way', () => {
    beforeAll(initI18nEn);
    beforeEach(async () => {
        await signInFixtureAccount();
        useNetworkStore.setState({ isConnected: true });
    });

    it('a Japanese related row keeps title_original as the card title', async () => {
        server.use(
            mockGql('GetRelatedArticlesPageFiltered', {
                relatedArticlesPage: {
                    __typename: 'RelatedArticlesPage',
                    articles: [{ __typename: 'ArticleSummary', ...summary, article_url: null, image_url: null, country_code: 'JPN', publication_name: 'Asahi', description_en: null }],
                    pageInfo: { __typename: 'PageInfo', endCursor: null, hasNextPage: false, pageSize: 1 },
                    restarted: false,
                },
            }),
        );
        const { result } = renderHook(() => useArticleDetailScreen({ articleId: ARTICLE_IDS[0] }));
        await waitFor(() => expect(result.current.relatedRows.length).toBe(1));
        expect(result.current.relatedRows[0].article.title).toBe('選挙結果が発表された');
        expect(result.current.relatedRows[0].article.title_en_internal_only).toBe('Election results announced');
    });
});
