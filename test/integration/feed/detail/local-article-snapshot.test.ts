// findLocalArticleSnapshot on the in-memory DB, rows seeded through the services.
// Replaces components/custom/news-detail/__tests__/local-article-snapshot.test.ts, which mocked
// both DB services.
//
// An external news URL is reachable from one place, a detail screen, so a detail screen that
// dead-ends costs the reader the article AND the translation. Server articles are dropped after
// 48h while this device's read history keeps 30 days, so the dead end is the common case.
import { findLocalArticleSnapshot } from '@/components/custom/news-detail/local-article-snapshot';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import {
    keepArticleForFactCheck,
    keepArticleForTrackedStory,
    saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { seedSuggestion } from './seed';

const visit = (over: Record<string, unknown> = {}) =>
    recordPublicationVisit({
        articleId: 'art-1',
        articleUrl: 'https://zeit.de/story',
        publicationName: 'Die Zeit',
        countryCode: 'DEU',
        titleEn: 'English headline',
        titleOriginal: 'Deutsche Schlagzeile',
        languageCode: 'de',
        imageUrl: 'https://zeit.de/i.jpg',
        pubDate: 1700000000000,
        ...over,
    });

const save = async (id: string, over: Record<string, unknown> = {}) => {
    const s = await seedSuggestion({
        _id: id,
        title_en: 'Saved headline',
        title: 'Saved original',
        article_url: 'https://zeit.de/saved',
        image_url: null,
        ...over,
    } as never);
    await saveSuggestion({ ...s, ...over } as never);
    return s;
};

describe('findLocalArticleSnapshot', () => {
    it('returns null when this device holds nothing for the article', async () => {
        expect(await findLocalArticleSnapshot('art-1')).toBeNull();
    });

    it('prefers a saved row over the visit log', async () => {
        await visit();
        await save('art-1');
        const result = await findLocalArticleSnapshot('art-1');
        expect(result?.source).toBe('saved');
        expect(result?.article.article_url).toBe('https://zeit.de/saved');
    });

    it('falls back to the read history, carrying the URL and source language', async () => {
        await visit();
        const result = await findLocalArticleSnapshot('art-1');
        expect(result?.source).toBe('visit');
        // These two are what ReadTranslateActions runs on: without them the detail screen cannot
        // offer the translate options, which is the whole reason every surface routes here.
        expect(result?.article.article_url).toBe('https://zeit.de/story');
        expect(result?.article.original_language_code).toBe('de');
        expect(result?.article.title_en_internal_only).toBe('English headline');
        expect(result?.article.publicationSource?.publication_name).toBe('Die Zeit');
    });

    it('ignores a visit row with no URL: there would be nothing to read or translate', async () => {
        await visit({ articleUrl: null });
        expect(await findLocalArticleSnapshot('art-1')).toBeNull();
    });

    it('keeps a saved row with no URL: that path is for offline READING', async () => {
        await save('art-1', { article_url: null });
        const result = await findLocalArticleSnapshot('art-1');
        expect(result?.source).toBe('saved');
    });

    it('looks both stores up by the article id it was given', async () => {
        await visit({ articleId: 'art-1' });
        await save('art-2');
        await visit({ articleId: 'art-42', articleUrl: 'https://zeit.de/other' });
        expect((await findLocalArticleSnapshot('art-42'))?.article.article_url).toBe('https://zeit.de/other');
        expect((await findLocalArticleSnapshot('art-2'))?.source).toBe('saved');
        expect(await findLocalArticleSnapshot('art-3')).toBeNull();
    });

    it('reports a followed story member as retained, not saved', async () => {
        const s = await seedSuggestion({ _id: 'art-1' });
        await keepArticleForTrackedStory({ articleId: 'art-1', suggestion: s });
        const result = await findLocalArticleSnapshot('art-1');
        expect(result?.source).toBe('retained');
        expect(result?.article.title_en_internal_only).toBe('English headline');
    });

    it('reports a fact-checked article with only a title and URL as retained', async () => {
        await keepArticleForFactCheck({
            articleId: 'art-1',
            title: 'Checked title',
            articleUrl: 'https://zeit.de/checked',
            publicationName: 'Die Zeit',
        });
        const result = await findLocalArticleSnapshot('art-1');
        expect(result?.source).toBe('retained');
        expect(result?.article.article_url).toBe('https://zeit.de/checked');
    });
});
