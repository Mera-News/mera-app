import type { NewsSearchHit } from '@/lib/generated/graphql-types';
import { articleFixtures, type BuildContext } from '../articles';

/** Two hits for any query: the first two fixture articles. */
export function searchHits(ctx: BuildContext, limit?: number | null): NewsSearchHit[] {
    const { articles, publications } = articleFixtures;
    return articles.slice(0, Math.min(2, limit ?? 2)).map((a, i) => ({
        __typename: 'NewsSearchHit',
        _id: a.id,
        title_en: a.title,
        image_url: `${ctx.origin.replace(/\/$/, '')}/assets/img/${a.imageIndex}.jpg`,
        publication_name: publications[a.publicationIndex].name,
        country_code: publications[a.publicationIndex].countryCode,
        pubDate: new Date(ctx.now - a.minutesAgo * 60_000).toISOString(),
        score: 0.9 - i * 0.1,
    }));
}
