// Saved Article Suggestion Service — device-local "save for later".
//
// Backs a long-lived, user-owned table (saved_article_suggestions) with a
// 30-day TTL. A saved row is a full snapshot of a ForYouSuggestion captured at
// save time, so it stays renderable even after the ephemeral article_suggestions
// feed cache is pruned. The WMDB row id == the source suggestion's server `_id`.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import { ArticleSuggestionStatus } from '../article-suggestion-status';
import type SavedArticleSuggestionModel from '../models/SavedArticleSuggestion';
import type { ForYouSuggestion, ClusterMembership } from '../../stores/for-you-store';
import type { NewsArticle } from '../../generated/graphql-types';

const savedSuggestionsCol = database.get<SavedArticleSuggestionModel>(
  'saved_article_suggestions',
);

/** Minimal context a standalone-article save carries. Structural (not the full
 *  FeedbackSubject) so this lib service stays free of a components/ import. */
export interface StandaloneSaveContext {
  surface?: string;
}

/** A saved row, discriminated by origin so the Saved screen can render the right
 *  card variant (suggestion card vs standalone card). */
export type SavedItem =
  | { origin: 'suggestion'; suggestion: ForYouSuggestion }
  | { origin: 'article'; savedId: string; article: NewsArticle };

// --- Write: save (upsert by server id) ---

/**
 * Saves (or re-saves) a suggestion for later. Identity is the source server
 * `_id` (== WMDB row id). Re-saving an already-saved suggestion refreshes its
 * snapshot fields and bumps `savedAt` (so it floats to the top of the list).
 */
export async function saveSuggestion(s: ForYouSuggestion): Promise<void> {
  const now = new Date();
  const existing = await findRow(s._id);

  await database.write(async () => {
    if (existing) {
      await existing.update((r) => {
        applySnapshot(r, s);
        r.savedAt = now;
      });
      return;
    }
    await savedSuggestionsCol.create((r) => {
      r._raw.id = s._id;
      applySnapshot(r, s);
      r.savedAt = now;
    });
  });
}

/**
 * Saves (or re-saves) a STANDALONE NewsArticle for later — the article has no
 * personalization (no relevance/reason/facts), so the snapshot leaves those
 * columns at their empty/unscored defaults and stamps `origin = 'article'`.
 * Identity is the article `_id` (== WMDB row id). Re-saving refreshes the
 * snapshot and bumps `savedAt`.
 */
export async function saveStandaloneArticle(
  article: NewsArticle,
  _context?: StandaloneSaveContext,
): Promise<void> {
  const id = (article?._id ?? '').trim();
  if (!id) return;
  const now = new Date();
  const existing = await findRow(id);

  await database.write(async () => {
    if (existing) {
      await existing.update((r) => {
        applyArticleSnapshot(r, article);
        r.savedAt = now;
      });
      return;
    }
    await savedSuggestionsCol.create((r) => {
      r._raw.id = id;
      applyArticleSnapshot(r, article);
      r.savedAt = now;
    });
  });
}

// --- Read ---

export async function isSuggestionSaved(serverId: string): Promise<boolean> {
  return (await findRow(serverId)) !== null;
}

export async function getSavedSuggestionByServerId(
  serverId: string,
): Promise<ForYouSuggestion | null> {
  const row = await findRow(serverId);
  return row ? toForYouSuggestion(row) : null;
}

/** All saved suggestions, newest-saved first. Maps EVERY row (both origins) to a
 *  ForYouSuggestion — retained for the suggestion-only callers/tests. Prefer
 *  {@link loadSavedItems} where the origin matters for rendering. */
export async function loadSavedSuggestions(): Promise<ForYouSuggestion[]> {
  const rows = await savedSuggestionsCol
    .query(Q.sortBy('saved_at', Q.desc))
    .fetch();
  return rows.map(toForYouSuggestion);
}

/** All saved rows, newest-saved first, discriminated by origin so the Saved
 *  screen renders the suggestion card or the standalone card as appropriate.
 *  A null `origin` column (pre-v38 rows) is treated as 'suggestion'. */
export async function loadSavedItems(): Promise<SavedItem[]> {
  const rows = await savedSuggestionsCol
    .query(Q.sortBy('saved_at', Q.desc))
    .fetch();
  return rows.map((row) =>
    row.origin === 'article'
      ? { origin: 'article' as const, savedId: row.id, article: toNewsArticle(row) }
      : { origin: 'suggestion' as const, suggestion: toForYouSuggestion(row) },
  );
}

// --- Delete ---

export async function deleteSavedSuggestion(serverId: string): Promise<boolean> {
  const row = await findRow(serverId);
  if (!row) return false;
  await database.write(async () => {
    await row.destroyPermanently();
  });
  return true;
}

// Saved suggestions have no TTL — they persist until the user deletes them.

// --- Internal helpers ---

async function findRow(
  serverId: string,
): Promise<SavedArticleSuggestionModel | null> {
  try {
    return await savedSuggestionsCol.find(serverId);
  } catch {
    return null;
  }
}

/** Copy every card-renderable field off the ForYouSuggestion onto the row. */
function applySnapshot(
  r: SavedArticleSuggestionModel,
  s: ForYouSuggestion,
): void {
  r.articleId = s.articleId;
  r.clusterMembershipsJson = JSON.stringify(s.clusters ?? []);
  r.relevance = s.relevance;
  r.reason = s.reason;
  // The saved table predates the `status` state machine and keeps its boolean
  // columns (long-lived, no migration). Map status → booleans at the boundary.
  r.relevanceGenerationCompleted = s.status !== ArticleSuggestionStatus.Unscored;
  r.reasonGenerationCompleted = s.status === ArticleSuggestionStatus.Complete;
  r.countryCode = s.country_code;
  r.languageCode = s.language_code;
  r.publicationName = s.publication_name;
  r.titleEn = s.title_en;
  r.titleOriginal = s.title_original;
  r.descriptionEn = s.description_en;
  r.articleUrl = s.article_url;
  r.imageUrl = s.image_url;
  r.matchedTopicTextsJson = JSON.stringify(s.userTopicIds ?? []);
  r.origin = 'suggestion';
  r.createdAt = parseDate(s.createdAt) ?? new Date();
  r.firstPubDate = parseDate(s.firstPubDate) ?? new Date();
}

/** Copy every card-renderable field off a standalone NewsArticle onto the row.
 *  Personalization columns (relevance/reason/status flags/clusters/topics) get
 *  their empty/unscored defaults — a standalone article carries none. */
function applyArticleSnapshot(
  r: SavedArticleSuggestionModel,
  a: NewsArticle,
): void {
  r.articleId = a._id;
  r.clusterMembershipsJson = JSON.stringify([]);
  r.relevance = 0;
  r.reason = '';
  r.relevanceGenerationCompleted = false;
  r.reasonGenerationCompleted = false;
  r.countryCode = a.publicationSource?.country_code ?? null;
  r.languageCode = a.original_language_code ?? null;
  r.publicationName = a.publicationSource?.publication_name ?? null;
  r.titleEn = a.title_en_internal_only ?? a.title_en ?? null;
  r.titleOriginal = a.title ?? null;
  r.descriptionEn = a.description_en ?? null;
  r.articleUrl = a.article_url ?? a.source_uri ?? null;
  r.imageUrl = a.image_url ?? null;
  r.matchedTopicTextsJson = JSON.stringify([]);
  r.origin = 'article';
  r.createdAt = new Date();
  r.firstPubDate = parseDate(a.pubDate) ?? new Date();
}

/** Reconstruct a NewsArticle-shaped object from a saved 'article'-origin row. */
function toNewsArticle(row: SavedArticleSuggestionModel): NewsArticle {
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
    pubDate: row.firstPubDate.toISOString(),
    publicationSource:
      row.publicationName || row.countryCode
        ? ({
            _id: row.articleId,
            publication_name: row.publicationName,
            country_code: row.countryCode,
          } as NewsArticle['publicationSource'])
        : undefined,
  } as NewsArticle;
}

function toForYouSuggestion(row: SavedArticleSuggestionModel): ForYouSuggestion {
  return {
    _id: row.id,
    articleId: row.articleId,
    clusters: parseClusterMemberships(row.clusterMembershipsJson),
    relevance: row.relevance,
    reason: row.reason,
    // Reconstruct status from the saved table's boolean columns.
    status: row.reasonGenerationCompleted
      ? ArticleSuggestionStatus.Complete
      : row.relevanceGenerationCompleted
        ? ArticleSuggestionStatus.ReasonPending
        : ArticleSuggestionStatus.Unscored,
    country_code: row.countryCode,
    language_code: row.languageCode,
    publication_name: row.publicationName,
    title_en: row.titleEn,
    title_original: row.titleOriginal,
    description_en: row.descriptionEn,
    article_url: row.articleUrl,
    image_url: row.imageUrl,
    userTopicIds: parseStringArray(row.matchedTopicTextsJson),
    createdAt: row.createdAt.toISOString(),
    firstPubDate: row.firstPubDate.toISOString(),
    // The saved table predates persona-v3 sectioning fields and doesn't persist
    // them — saved cards render via the priority chip, not the sectioned feed.
    rawScore: null,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
  };
}

function parseClusterMemberships(
  json: string | null | undefined,
): ClusterMembership[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ClusterMembership =>
        m != null &&
        typeof m.clusterId === 'string' &&
        m.clusterId.length > 0 &&
        typeof m.confidence === 'number',
    );
  } catch {
    return [];
  }
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}
