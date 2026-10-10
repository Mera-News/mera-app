// Seeding for the core/results seam tests: article_suggestions go in through the app's own services.
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';

/** Insert articles as `unscored` rows (what feed-sync hydration writes). */
export async function seedArticles(ids: string[]): Promise<void> {
  const fetched = ids.map(
    (id) =>
      ({
        _id: id,
        title: `Title ${id}`,
        title_en: `Title ${id}`,
        description_en: `Description ${id}`,
        publication_name: null,
        country_code: null,
        language_code: 'en',
        category: null,
        geo_tags: null,
        entities: null,
        pubDate: '2026-10-09T08:00:00.000Z',
        clusters: [],
      }) as unknown as ArticleWithClusters,
  );
  await persistAndLinkV2Suggestions(fetched, new Map(), {
    matchedTopics: new Map(ids.map((id) => [id, []])),
    headlineScope: new Map(),
  });
}

/** Score a row the way the scorer does when its note is still owed: it lands in `reason_pending`. */
export async function scorePendingReason(id: string, relevance: number): Promise<void> {
  await saveScoringResult(id, { relevance, reason: '', reasonSkipped: false });
}

/** The stored status and relevance of each row. A row that is not there reads as `undefined`. */
export async function rowsById(
  ids: string[],
): Promise<Record<string, { status: string; relevance: number } | undefined>> {
  const col = database.get<ArticleSuggestionModel>('article_suggestions');
  const out: Record<string, { status: string; relevance: number } | undefined> = {};
  for (const id of ids) {
    out[id] = await col.find(id).then((r) => ({ status: r.status, relevance: r.relevance }), () => undefined);
  }
  return out;
}
