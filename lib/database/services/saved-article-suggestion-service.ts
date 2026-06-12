// Saved Article Suggestion Service — device-local "save for later".
//
// Backs a long-lived, user-owned table (saved_article_suggestions) with a
// 30-day TTL. A saved row is a full snapshot of a ForYouSuggestion captured at
// save time, so it stays renderable even after the ephemeral article_suggestions
// feed cache is pruned. The WMDB row id == the source suggestion's server `_id`.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type SavedArticleSuggestionModel from '../models/SavedArticleSuggestion';
import type { ForYouSuggestion, ClusterMembership } from '../../stores/for-you-store';

const savedSuggestionsCol = database.get<SavedArticleSuggestionModel>(
  'saved_article_suggestions',
);

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

/** All saved suggestions, newest-saved first. */
export async function loadSavedSuggestions(): Promise<ForYouSuggestion[]> {
  const rows = await savedSuggestionsCol
    .query(Q.sortBy('saved_at', Q.desc))
    .fetch();
  return rows.map(toForYouSuggestion);
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
  r.relevanceGenerationCompleted = s.relevanceGenerationCompleted;
  r.reasonGenerationCompleted = s.reasonGenerationCompleted;
  r.countryCode = s.country_code;
  r.languageCode = s.language_code;
  r.publicationName = s.publication_name;
  r.titleEn = s.title_en;
  r.titleOriginal = s.title_original;
  r.descriptionEn = s.description_en;
  r.articleUrl = s.article_url;
  r.imageUrl = s.image_url;
  r.matchedTopicTextsJson = JSON.stringify(s.userTopicIds ?? []);
  r.createdAt = parseDate(s.createdAt) ?? new Date();
  r.firstPubDate = parseDate(s.firstPubDate) ?? new Date();
}

function toForYouSuggestion(row: SavedArticleSuggestionModel): ForYouSuggestion {
  return {
    _id: row.id,
    articleId: row.articleId,
    clusters: parseClusterMemberships(row.clusterMembershipsJson),
    relevance: row.relevance,
    reason: row.reason,
    relevanceGenerationCompleted: row.relevanceGenerationCompleted,
    reasonGenerationCompleted: row.reasonGenerationCompleted,
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
