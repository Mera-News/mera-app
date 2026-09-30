// publication-local-articles: one publication's articles that are already on
// the device, for the publication page while offline. Read-only.
//
// The feed rows (`article_suggestions`) carry the SOURCE's `publication_name`,
// never a publisher id, so a publication is matched by every name it is known
// by (its source names, see publisher-source-names.ts). Rows the feed will
// never show (`excluded`) are left out. Returned in the same `NewsArticle`
// shape the online list uses, newest first, so the page renders one list type.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import { ArticleSuggestionStatus } from '../article-suggestion-status';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import type { NewsArticle } from '../../generated/graphql-types';
import { publisherPrefNames } from './publication-pref-level';

/** Cap on rows returned: an offline page is a glance, not an archive. */
export const PUBLICATION_LOCAL_ARTICLES_LIMIT = 50;

function toNewsArticle(row: ArticleSuggestionModel): NewsArticle {
  return {
    _id: row.articleId,
    article_url: row.articleUrl ?? '',
    source_uri: row.articleUrl ?? '',
    title: row.titleOriginal ?? row.titleEn ?? '',
    title_en: row.titleEn ?? undefined,
    title_en_internal_only: row.titleEn ?? undefined,
    description: row.descriptionEn ?? '',
    description_en: row.descriptionEn ?? undefined,
    image_url: row.imageUrl ?? undefined,
    original_language_code: row.languageCode ?? undefined,
    category: row.category ?? undefined,
    pubDate: row.firstPubDate.toISOString(),
    publicationSource: {
      _id: row.articleId,
      publication_name: row.publicationName ?? '',
      country_code: row.countryCode ?? '',
    } as NewsArticle['publicationSource'],
  } as NewsArticle;
}

/**
 * On-device articles whose `publication_name` is one of `names`, newest
 * first, one per article id. An empty name list returns nothing.
 */
export async function getLocalArticlesForPublication(
  names: readonly string[],
  limit: number = PUBLICATION_LOCAL_ARTICLES_LIMIT,
): Promise<NewsArticle[]> {
  const exact = publisherPrefNames(names);
  if (exact.length === 0) return [];
  const rows = await database
    .get<ArticleSuggestionModel>('article_suggestions')
    .query(
      Q.where('publication_name', Q.oneOf(exact)),
      Q.where('status', Q.notEq(ArticleSuggestionStatus.Excluded)),
      Q.sortBy('first_pub_date', Q.desc),
    )
    .fetch();
  const seen = new Set<string>();
  const out: NewsArticle[] = [];
  for (const row of rows) {
    if (!row.articleId || seen.has(row.articleId)) continue;
    seen.add(row.articleId);
    out.push(toNewsArticle(row));
    if (out.length >= limit) break;
  }
  return out;
}
