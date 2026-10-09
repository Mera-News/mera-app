// Seeding for the article-detail seam tests: suggestion rows go in through the app's own
// persist path, then out again as the ForYouSuggestion the screens and the saved table take.
import { loadSuggestions, persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-service';
import type { ArticleWithClusters, NewsArticle } from '@/lib/generated/graphql-types';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';

/** One `article_suggestions` row; a Dutch original and an English title unless overridden. */
export async function seedSuggestion(
    over: Partial<ArticleWithClusters> & { _id: string },
): Promise<ForYouSuggestion> {
    const row = {
        title: 'Deutsche Schlagzeile',
        title_en: 'English headline',
        description_en: 'A description',
        article_url: 'https://example.com/story',
        image_url: 'https://example.com/i.jpg',
        country_code: 'DEU',
        language_code: 'de',
        publication_name: 'Die Zeit',
        pubDate: '2026-08-01T00:00:00.000Z',
        clusters: [],
        ...over,
    } as unknown as ArticleWithClusters;
    await persistAndLinkV2Suggestions([row], new Map(), { matchedTopics: new Map() });
    const found = (await loadSuggestions()).find((s) => s._id === over._id);
    if (!found) throw new Error(`seedSuggestion: ${over._id} not stored`);
    return found;
}

/** Put a stored suggestion in the feed store, as hydration does. */
export function putInStore(s: ForYouSuggestion): void {
    useForYouStore.setState({ suggestions: [s] });
}

/** A server article for the detail screen. */
export function newsArticle(id: string, over: Partial<NewsArticle> = {}): NewsArticle {
    return {
        _id: id,
        title: 'Deutsche Schlagzeile',
        title_en_internal_only: 'English headline',
        pubDate: '2026-08-01T00:00:00.000Z',
        article_url: 'https://example.com/story',
        original_language_code: 'de',
        publicationSource: { _id: id, publication_name: 'Die Zeit', country_code: 'DEU' },
        ...over,
    } as NewsArticle;
}
