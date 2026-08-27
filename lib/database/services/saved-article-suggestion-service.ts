// Saved Article Suggestion Service — device-local "save for later".
//
// Backs a long-lived, user-owned table (saved_article_suggestions) with no
// TTL — rows persist until released. A saved row is a full snapshot of a
// ForYouSuggestion captured at save time, so it stays renderable even after
// the ephemeral article_suggestions feed cache is pruned. The WMDB row id ==
// the source suggestion's server `_id`.
//
// The table also backs RETENTION, for two independent reasons (see
// RETENTION_ORIGINS): a fact check and a followed story each need their article
// to stay openable after the 48h feed prune and the server's own expiry, exactly
// like a save does. Retention rows are not saves — they never publish bookmark
// state, never appear on the Saved screen, and are released once NO reason still
// holds them. See `keepArticleForRetention` below.

import { Q } from '@nozbe/watermelondb';
import { publishSavedState } from '@/lib/saved-state';
import database from '../index';
import logger from '../../logger';
import { ArticleSuggestionStatus } from '../article-suggestion-status';
import { listFactChecksForArticle } from './fact-check-record-service';
import {
  isTrackedStoryMember,
  listTrackedMemberArticleIds,
} from './tracked-story-service';
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

/**
 * The origins that mark a row as RETENTION rather than a user save.
 *
 * One constant, not a literal at each site, because the origin is filtered in
 * four places and a new reason leaking onto the Saved screen — rendering a
 * bookmark for an article the reader never saved, whose un-save tap then
 * destroys someone else's retention copy — is the obvious failure mode.
 */
export const RETENTION_ORIGINS = ['fact_check', 'tracked_story'] as const;
export type RetentionOrigin = (typeof RETENTION_ORIGINS)[number];

/** Is this row retention rather than a user save? A NULL origin (pre-v38 rows)
 *  is a user save and must answer false. */
function isRetentionOrigin(origin: string | null | undefined): boolean {
  return RETENTION_ORIGINS.includes(origin as RetentionOrigin);
}

/**
 * Which reasons still hold this article's retention row.
 *
 * `origin` is a single scalar and can only record ONE reason, so it cannot
 * answer this. Without the check the two reasons destroy each other's rows: an
 * article retained by a fact check whose story the reader then follows would
 * lose its retention the moment that fact check is deleted, even though the
 * story is still followed — the exact bug this retention exists to prevent,
 * reached through a different door.
 */
async function retentionReasonsLive(
  articleId: string,
): Promise<{ factCheck: boolean; trackedStory: boolean }> {
  const [checks, tracked] = await Promise.all([
    listFactChecksForArticle(articleId),
    isTrackedStoryMember(articleId),
  ]);
  return { factCheck: checks.length > 0, trackedStory: tracked };
}

/** A saved row, discriminated by origin so the Saved screen can render the right
 *  card variant (suggestion card vs standalone card). Retention rows never
 *  reach here — see RETENTION_ORIGINS. */
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
 *  retention row is not a save: counting it would render a filled bookmark on an
 *  article the user never saved, and the un-save tap would then destroy the
 *  retention copy. */
export async function isSuggestionSaved(serverId: string): Promise<boolean> {
  const row = await findRow(serverId);
  return row !== null && !isRetentionOrigin(row.origin);
}

/**
 * The open path's lookup. Deliberately UNFILTERED by origin — resolving a
 * retention row here is the entire point of retention, and adding an origin
 * filter would break both retention reasons with a symptom identical to the bug
 * they exist to prevent ("This article is no longer available").
 */
export async function getSavedSuggestionByServerId(
  serverId: string,
): Promise<ForYouSuggestion | null> {
  const row = await findRow(serverId);
  return row ? toForYouSuggestion(row) : null;
}

/**
 * Same lookup, plus whether the row is a user SAVE or RETENTION.
 *
 * The detail screen needs the distinction for one reason: a save is the offline
 * path and earns the "showing cached content" banner, while a retention row is
 * resolved ONLINE (the server simply expired the article) where that banner
 * would be false and would contradict the working Read button below it.
 */
export async function getSavedSuggestionWithKind(
  serverId: string,
): Promise<{ suggestion: ForYouSuggestion; retained: boolean } | null> {
  const row = await findRow(serverId);
  if (!row) return null;
  return {
    suggestion: toForYouSuggestion(row),
    retained: isRetentionOrigin(row.origin),
  };
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
  return rows.filter((row) => !isRetentionOrigin(row.origin)).map(toForYouSuggestion);
}

/** All saved rows, newest-saved first, discriminated by origin so the Saved
 *  screen renders the suggestion card or the standalone card as appropriate.
 *  A null `origin` column (pre-v38 rows) is treated as 'suggestion'. */
export async function loadSavedItems(): Promise<SavedItem[]> {
  const rows = await savedSuggestionsCol
    .query(Q.sortBy('saved_at', Q.desc))
    .fetch();
  // Retention rows are not saves and must not reach the Saved screen. Filter
  // BEFORE mapping: the mapper treats every non-'article' origin as a
  // suggestion card. JS filter, not Q.notEq (see loadSavedSuggestions).
  return rows
    .filter((row) => !isRetentionOrigin(row.origin))
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

/** What a keep has in hand. The full shapes come from the two article screens
 *  (fact check) or the local suggestion row (followed story); the degraded shape
 *  is built from the server's own FactCheckRow (title/url/publication) when no
 *  richer object is available — enough for the article-detail fallback to render
 *  the read block, but with no description and often no image, so callers should
 *  reach for a full shape whenever one exists. */
export type RetentionKeepInput =
  | { articleId: string; article: NewsArticle }
  | { articleId: string; suggestion: ForYouSuggestion }
  | {
      articleId: string;
      title?: string | null;
      articleUrl?: string | null;
      publicationName?: string | null;
    };

/** Historical name for {@link RetentionKeepInput}, kept so the fact-check call
 *  sites read unchanged. */
export type FactCheckKeepInput = RetentionKeepInput;

/**
 * Retain an article, like a save does, so it stays openable after the 48h feed
 * prune and the server's own expiry. Article-keyed row (`_raw.id` = article
 * `_id`), stamped with the reason that asked for it.
 *
 * NOT a save: never publishes bookmark state and never bumps `savedAt` on an
 * existing row. A USER-saved row already retains the article and is left alone —
 * the un-save path downgrades it back to a retention origin while a reason still
 * holds it. A degraded input never overwrites an existing snapshot: the
 * fact-check poll loop re-enters with row-derived data on every poll and must
 * not wipe a rich snapshot captured at request time.
 *
 * A row already held by the OTHER reason is upgraded in place, not skipped, and
 * keeps its existing origin rather than churning it — `origin` only decides
 * which sweep classifies the row, and both sweeps check both reasons anyway.
 * Bailing here instead (the pre-tracked_story behaviour) would silently record
 * no retention for the second reason.
 *
 * Never throws — a failed keep must never fail the action it rode in on.
 */
export async function keepArticleForRetention(
  input: RetentionKeepInput,
  origin: RetentionOrigin,
): Promise<void> {
  const articleId = (input?.articleId ?? '').trim();
  if (!articleId) return;
  try {
    const existing = await findRow(articleId);
    // Only a USER save blocks the keep. A sibling retention origin does not.
    if (existing && !isRetentionOrigin(existing.origin)) return;

    const full = 'article' in input || 'suggestion' in input;
    if (existing && !full) return;

    // Captured BEFORE the update: `apply` runs against the existing record, and
    // the two snapshot helpers stamp their own origin ('article'/'suggestion')
    // on the way through — so reading `existing.origin` inside `apply` reads the
    // value the helper just wrote, not the one the row had.
    const priorOrigin = existing?.origin ?? null;

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
      // Keep an existing retention row's origin rather than churning it.
      r.origin = priorOrigin && isRetentionOrigin(priorOrigin) ? priorOrigin : origin;
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
        method: 'keepArticleForRetention',
      },
      extra: { articleId, origin },
    });
  }
}

/** Back-compat wrapper so the fact-check call sites read unchanged. */
export async function keepArticleForFactCheck(
  input: RetentionKeepInput,
): Promise<void> {
  return keepArticleForRetention(input, 'fact_check');
}

/** Retain a followed story's member article. Always prefer a full
 *  `suggestion` input: the degraded shape carries no description and no image,
 *  and the article URL is the whole reason this retention exists — without it
 *  the detail screen renders a header with no Read button. */
export async function keepArticleForTrackedStory(
  input: RetentionKeepInput,
): Promise<void> {
  return keepArticleForRetention(input, 'tracked_story');
}

/**
 * Drop an article's retention row now that ONE reason has let go of it —
 * but only if no OTHER reason still holds it, and never a user save.
 *
 * The cross-reason check is the whole point. `origin` records one reason, so
 * without it deleting a fact check would destroy the row of an article whose
 * story is still followed, and unfollowing would destroy the row of an article
 * whose fact check is still live. Either way the reader gets "This article is no
 * longer available" on a story they explicitly kept.
 *
 * Returns whether a row was destroyed. Never throws.
 */
async function releaseRetention(
  articleId: string,
  reason: RetentionOrigin,
): Promise<boolean> {
  const id = (articleId ?? '').trim();
  if (!id) return false;
  try {
    const reasons = await retentionReasonsLive(id);
    const survivor: RetentionOrigin | null = reasons.factCheck
      ? 'fact_check'
      : reasons.trackedStory
        ? 'tracked_story'
        : null;

    const row = await findRow(id);
    // A user save owns the row; releasing a retention reason is not our cue to
    // destroy it. Same guard the pre-tracked_story code had, generalized.
    if (!row || !isRetentionOrigin(row.origin)) return false;

    if (survivor !== null) {
      // Something still holds it. Re-stamp so the origin names a LIVE reason —
      // otherwise the row keeps pointing at the reason that just let go and the
      // wrong sweep would treat it as an orphan.
      if (row.origin !== survivor) {
        await database.write(async () => {
          await row.update((r) => {
            r.origin = survivor;
          });
        });
      }
      return false;
    }

    await database.write(async () => {
      await row.destroyPermanently();
    });
    return true;
  } catch (err) {
    logger.captureException(err, {
      tags: {
        service: 'saved-article-suggestion-service',
        method: 'releaseRetention',
      },
      extra: { articleId: id, reason },
    });
    return false;
  }
}

/**
 * The last fact check for an article was deleted (post-v52 an article can hold
 * several claim rows). Release its retention unless a followed story still
 * holds it.
 */
export async function releaseFactCheckRetention(
  articleId: string,
): Promise<boolean> {
  return releaseRetention(articleId, 'fact_check');
}

/**
 * A followed story dropped this member — the story was deleted, or the reader
 * disowned the article. Release its retention unless a fact check still holds it.
 *
 * Callers must release AFTER the snapshot is gone: `isTrackedStoryMember` reads
 * the snapshots, so releasing first would still see the article as a member and
 * decline every time.
 */
export async function releaseTrackedStoryRetention(
  articleId: string,
): Promise<boolean> {
  return releaseRetention(articleId, 'tracked_story');
}

/**
 * Safety-net sweep (data-cleanup task): destroy every retention row that no
 * reason still holds. Catches rows orphaned by a backup restore (this table is
 * backed up, `fact_checks` and tracked stories are not necessarily in step with
 * it) and any missed release path. Returns the number destroyed.
 *
 * Checks BOTH reasons per row regardless of the row's own origin — a row stamped
 * 'fact_check' whose check is gone may still be a live followed-story member,
 * and destroying it here would undo the release path's cross-reason care.
 */
export async function deleteOrphanedRetention(): Promise<number> {
  try {
    const rows = await savedSuggestionsCol
      .query(Q.where('origin', Q.oneOf([...RETENTION_ORIGINS])))
      .fetch();
    if (rows.length === 0) return 0;
    // One query for the whole tracked-story reference set rather than one per
    // row: the fact-check side is already per-article and cheap, this is not.
    const trackedIds = await listTrackedMemberArticleIds();
    const orphans: SavedArticleSuggestionModel[] = [];
    for (const row of rows) {
      if (trackedIds.has(row.articleId)) continue;
      // eslint-disable-next-line no-await-in-loop -- tiny set: one row per
      // retained article, and this runs once a day off the UI path.
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
        method: 'deleteOrphanedRetention',
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
