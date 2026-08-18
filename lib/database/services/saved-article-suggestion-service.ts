// Saved Article Suggestion Service — device-local "save for later".
//
// Backs a long-lived, user-owned table (saved_article_suggestions) with no
// TTL — rows persist until released. A saved row is a full snapshot of a
// ForYouSuggestion captured at save time, so it stays renderable even after
// the ephemeral article_suggestions feed cache is pruned. The WMDB row id ==
// the source suggestion's server `_id`.
//
// The table also backs FACT-CHECK RETENTION (`origin = 'fact_check'`): a fact
// check must keep its article openable after the 48h feed prune and the
// server's own expiry, exactly like a save does. Those rows are not saves —
// they never publish bookmark state, never appear on the Saved screen, and are
// released when the last fact check for the article goes. See
// `keepArticleForFactCheck` below.

import { Q } from '@nozbe/watermelondb';
import { publishSavedState } from '@/lib/saved-state';
import database from '../index';
import logger from '../../logger';
import { ArticleSuggestionStatus } from '../article-suggestion-status';
import { listFactChecksForArticle } from './fact-check-record-service';
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
  // Announce BEFORE awaiting the write so the bookmark flips on the same frame
  // as the tap; the write is local SQLite and does not fail in practice, and a
  // stale-true is self-correcting on the next mount read.
  publishSavedState(s._id, true);
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
  publishSavedState(id, true);
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

/** "Did the USER save this" — the question every bookmark surface asks. A
 *  fact-check retention row is not a save: counting it would render a filled
 *  bookmark on an article the user never saved, and the un-save tap would then
 *  destroy the retention copy. */
export async function isSuggestionSaved(serverId: string): Promise<boolean> {
  const row = await findRow(serverId);
  return row !== null && row.origin !== 'fact_check';
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
  // JS filter, not Q.notEq: SQL `!=` also excludes the NULL origin of pre-v38
  // rows, which are user saves and must stay.
  return rows.filter((row) => row.origin !== 'fact_check').map(toForYouSuggestion);
}

/** All saved rows, newest-saved first, discriminated by origin so the Saved
 *  screen renders the suggestion card or the standalone card as appropriate.
 *  A null `origin` column (pre-v38 rows) is treated as 'suggestion'. */
export async function loadSavedItems(): Promise<SavedItem[]> {
  const rows = await savedSuggestionsCol
    .query(Q.sortBy('saved_at', Q.desc))
    .fetch();
  // Fact-check retention rows are not saves and must not reach the Saved
  // screen. Filter BEFORE mapping: the mapper treats every non-'article'
  // origin as a suggestion card. JS filter, not Q.notEq (see loadSavedSuggestions).
  return rows
    .filter((row) => row.origin !== 'fact_check')
    .map((row) =>
      row.origin === 'article'
        ? { origin: 'article' as const, savedId: row.id, article: toNewsArticle(row) }
        : { origin: 'suggestion' as const, suggestion: toForYouSuggestion(row) },
    );
}

// --- Delete ---

export async function deleteSavedSuggestion(serverId: string): Promise<boolean> {
  const row = await findRow(serverId);
  if (!row) {
    // Nothing to delete. Still publish `false`: reaching here means some surface
    // believed the article was saved when it was not, and that surface needs
    // correcting. The boolean return lets callers skip a "Removed" toast for a
    // deletion that did not happen.
    publishSavedState(serverId, false);
    return false;
  }
  // Un-saving must not orphan a live fact check: while any fact_checks row
  // still references the article, the snapshot survives as a retention row
  // (origin 'fact_check') instead of being destroyed. The un-save itself still
  // "works" from the user's view — the row leaves the Saved screen and the
  // bookmark clears.
  const retainForFactCheck =
    (await listFactChecksForArticle(row.articleId)).length > 0;
  // A suggestion-keyed save (row id = suggestion _id ≠ article id) is invisible
  // to the article-id fallback, so retention needs an ARTICLE-keyed row; skip
  // the transfer when one already exists.
  const articleKeyedRow =
    retainForFactCheck && row.id !== row.articleId
      ? await findRow(row.articleId)
      : null;

  await database.write(async () => {
    if (!retainForFactCheck) {
      await row.destroyPermanently();
      return;
    }
    if (row.id === row.articleId) {
      await row.update((r) => {
        r.origin = 'fact_check';
      });
      return;
    }
    if (!articleKeyedRow) {
      // Transfer the snapshot to an article-keyed retention row. Covers fact
      // checks that predate retention (no keep ever ran for them).
      await savedSuggestionsCol.create((r) => {
        r._raw.id = row.articleId;
        r.articleId = row.articleId;
        r.clusterMembershipsJson = row.clusterMembershipsJson;
        r.relevance = row.relevance;
        r.reason = row.reason;
        r.relevanceGenerationCompleted = row.relevanceGenerationCompleted;
        r.reasonGenerationCompleted = row.reasonGenerationCompleted;
        r.countryCode = row.countryCode;
        r.languageCode = row.languageCode;
        r.publicationName = row.publicationName;
        r.titleEn = row.titleEn;
        r.titleOriginal = row.titleOriginal;
        r.descriptionEn = row.descriptionEn;
        r.articleUrl = row.articleUrl;
        r.imageUrl = row.imageUrl;
        r.matchedTopicTextsJson = row.matchedTopicTextsJson;
        r.origin = 'fact_check';
        r.createdAt = row.createdAt;
        r.firstPubDate = row.firstPubDate;
        r.savedAt = row.savedAt;
      });
    }
    await row.destroyPermanently();
  });
  publishSavedState(serverId, false);
  return true;
}

// Saved suggestions have no TTL — they persist until the user deletes them.

// --- Fact-check retention ---

/** What a fact-check keep has in hand. The full shapes come from the two
 *  article screens; the degraded shape is built from the server's own
 *  FactCheckRow (title/url/publication) when no screen object is available —
 *  enough for the article-detail fallback to render the read block. */
export type FactCheckKeepInput =
  | { articleId: string; article: NewsArticle }
  | { articleId: string; suggestion: ForYouSuggestion }
  | {
      articleId: string;
      title?: string | null;
      articleUrl?: string | null;
      publicationName?: string | null;
    };

/**
 * Retain the article a fact check references, like a save does, so it stays
 * openable after the 48h feed prune. Article-keyed row (`_raw.id` = article
 * `_id`), `origin = 'fact_check'`.
 *
 * NOT a save: never publishes bookmark state and never bumps `savedAt` on an
 * existing row. A user-saved row (any other origin) already retains the
 * article and is left alone — the un-save path downgrades it to 'fact_check'
 * while checks still reference it. A degraded input never overwrites an
 * existing snapshot: the fact-check poll loop re-enters with row-derived data
 * on every poll and must not wipe a rich snapshot captured at request time.
 *
 * Never throws — a failed keep must never fail the fact-check ask it rode in on.
 */
export async function keepArticleForFactCheck(
  input: FactCheckKeepInput,
): Promise<void> {
  const articleId = (input?.articleId ?? '').trim();
  if (!articleId) return;
  try {
    const existing = await findRow(articleId);
    if (existing && existing.origin !== 'fact_check') return;

    const full = 'article' in input || 'suggestion' in input;
    if (existing && !full) return;

    const apply = (r: SavedArticleSuggestionModel) => {
      if ('article' in input) {
        applyArticleSnapshot(r, input.article);
      } else if ('suggestion' in input) {
        applySnapshot(r, input.suggestion);
      } else {
        r.articleId = articleId;
        r.clusterMembershipsJson = JSON.stringify([]);
        r.relevance = 0;
        r.reason = '';
        r.relevanceGenerationCompleted = false;
        r.reasonGenerationCompleted = false;
        r.countryCode = null;
        r.languageCode = null;
        r.publicationName = input.publicationName ?? null;
        r.titleEn = input.title ?? null;
        r.titleOriginal = input.title ?? null;
        r.descriptionEn = null;
        r.articleUrl = input.articleUrl ?? null;
        r.imageUrl = null;
        r.matchedTopicTextsJson = JSON.stringify([]);
        r.createdAt = new Date();
        r.firstPubDate = new Date();
      }
      // After the helpers: both stamp their own origin ('article'/'suggestion').
      r.origin = 'fact_check';
    };

    await database.write(async () => {
      if (existing) {
        await existing.update(apply);
        return;
      }
      await savedSuggestionsCol.create((r) => {
        r._raw.id = articleId;
        apply(r);
        r.savedAt = new Date();
      });
    });
  } catch (err) {
    logger.captureException(err, {
      tags: {
        service: 'saved-article-suggestion-service',
        method: 'keepArticleForFactCheck',
      },
      extra: { articleId },
    });
  }
}

/**
 * Drop the retention row for an article whose fact check was just deleted —
 * but only when it was the LAST one (post-v52 an article can hold several
 * claim rows) and only a 'fact_check'-origin row (a user save is not ours to
 * destroy). Returns whether a row was destroyed.
 */
export async function releaseFactCheckRetention(
  articleId: string,
): Promise<boolean> {
  if (!articleId) return false;
  try {
    if ((await listFactChecksForArticle(articleId)).length > 0) return false;
    const row = await findRow(articleId);
    if (!row || row.origin !== 'fact_check') return false;
    await database.write(async () => {
      await row.destroyPermanently();
    });
    return true;
  } catch (err) {
    logger.captureException(err, {
      tags: {
        service: 'saved-article-suggestion-service',
        method: 'releaseFactCheckRetention',
      },
      extra: { articleId },
    });
    return false;
  }
}

/**
 * Safety-net sweep (data-cleanup task): destroy every 'fact_check'-origin row
 * whose article no longer has any fact_checks row. Catches rows orphaned by a
 * backup restore (this table is backed up, `fact_checks` deliberately is not)
 * and any missed delete path. Returns the number destroyed.
 */
export async function deleteOrphanedFactCheckRetention(): Promise<number> {
  try {
    const rows = await savedSuggestionsCol
      .query(Q.where('origin', 'fact_check'))
      .fetch();
    if (rows.length === 0) return 0;
    const orphans: SavedArticleSuggestionModel[] = [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- tiny set: one row per
      // fact-checked article, and this runs once a day off the UI path.
      const refs = await listFactChecksForArticle(row.articleId);
      if (refs.length === 0) orphans.push(row);
    }
    if (orphans.length === 0) return 0;
    await database.write(async () => {
      await database.batch(...orphans.map((r) => r.prepareDestroyPermanently()));
    });
    return orphans.length;
  } catch (err) {
    logger.captureException(err, {
      tags: {
        service: 'saved-article-suggestion-service',
        method: 'deleteOrphanedFactCheckRetention',
      },
    });
    return 0;
  }
}

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
    // `entities` is likewise absent (no column), so story-grouping's entity edge
    // can never fire for a saved row; `eventType: null` already guarantees that
    // independently, since the edge requires two EQUAL non-null event types.
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
