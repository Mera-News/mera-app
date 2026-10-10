// Article Suggestion Service: delete, prune and feed metadata.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import type ArticleSuggestionFactModel from '../models/ArticleSuggestionFact';
import { getSetting, setSetting, deleteSetting } from './setting-service';
import { getFacts } from './fact-service';
import logger from '../../logger';
import { parseMatchedTopicRefs, parseTopicIds } from './article-suggestion-mappers';

const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
const articleSuggestionFactsCol = database.get<ArticleSuggestionFactModel>('article_suggestion_facts');

export async function deleteSuggestionsByServerIds(
  serverIds: string[],
): Promise<number> {
  if (serverIds.length === 0) return 0;

  // Row id == server id, so query the primary-key column directly.
  const suggestions = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(serverIds)))
    .fetch();
  if (suggestions.length === 0) return 0;

  const ids = suggestions.map((s) => s.id);
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(ids)))
    .fetch();

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...suggestions.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  return suggestions.length;
}

export async function deleteSuggestionByServerId(
  serverId: string,
): Promise<boolean> {
  return (await deleteSuggestionsByServerIds([serverId])) > 0;
}

export async function deleteOldSuggestions(cutoffMs: number): Promise<number> {
  const suggestions = await articleSuggestionsCol
    .query(Q.where('created_at', Q.lt(cutoffMs)))
    .fetch();
  if (suggestions.length === 0) return 0;

  const ids = suggestions.map((s) => s.id);
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(ids)))
    .fetch();

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...suggestions.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  return suggestions.length;
}

export async function clearSuggestions(): Promise<void> {
  const [suggestions, links] = await Promise.all([
    articleSuggestionsCol.query().fetch(),
    articleSuggestionFactsCol.query().fetch(),
  ]);

  if (suggestions.length === 0 && links.length === 0) {
    await deleteSetting(FEED_META_KEY);
    return;
  }

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...suggestions.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  await deleteSetting(FEED_META_KEY);
}

/**
 * Deletes suggestions whose matched topic texts are entirely absent from
 * current active facts. Suggestions that still overlap with at least one
 * active topic are preserved (along with their relevance scores).
 * Returns the number of deleted suggestion rows, or -1 if a full clear
 * was performed because no active topics exist.
 */
export async function pruneOrphanedSuggestions(): Promise<number> {
  const facts = await getFacts();
  const activeTopics = new Set<string>();
  for (const fact of facts) {
    for (const topic of fact.metadata?.topics ?? []) {
      if (topic.length > 0) activeTopics.add(topic);
    }
  }

  if (activeTopics.size === 0) {
    await clearSuggestions();
    return -1;
  }

  const allSuggestions = await articleSuggestionsCol.query().fetch();
  const toDelete = allSuggestions.filter((s) => {
    const matched = parseTopicIds(s.matchedTopicTextsJson);
    return matched.length > 0 && matched.every((t) => !activeTopics.has(t));
  });

  if (toDelete.length === 0) return 0;

  const toDeleteIds = new Set(toDelete.map((s) => s.id));
  const allLinks = await articleSuggestionFactsCol.query().fetch();
  const linksToDelete = allLinks.filter((l) => toDeleteIds.has(l.articleSuggestionId));

  await database.write(async () => {
    await database.batch([
      ...linksToDelete.map((l) => l.prepareDestroyPermanently()),
      ...toDelete.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  return toDelete.length;
}

const FEED_META_KEY = 'feed_metadata';

export interface FeedMetadata {
  articleCount: number;
  relevantArticleCount: number;
  hasGeneratedTopics: boolean;
  lastProcessingRunFinishedAt?: number | null;
  /** Epoch ms of the last sync that delivered new articles (the "Updated"
   *  label). Absent/null on blobs written before it existed. */
  lastNewArticlesAt?: number | null;
}

export async function persistFeedMetadata(meta: FeedMetadata): Promise<void> {
  await setSetting(FEED_META_KEY, JSON.stringify(meta));
}

export async function loadFeedMetadata(): Promise<FeedMetadata | null> {
  const raw = await getSetting(FEED_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FeedMetadata;
  } catch {
    return null;
  }
}

/**
 * Destroy suggestions that survive only because of topics that no longer exist.
 *
 * Deleting a fact removes the interest AND (since the cascade fix) its topics —
 * but the suggestions those topics retrieved stayed on the device forever.
 * They are not merely stale: the Dashboard resolves a suggestion to its section
 * through matched topic → fact, so a suggestion whose every matched topic is
 * gone can never render a section again. It occupies the local feed, counts
 * toward "analysed for you", and is re-read on every rebuild, for an interest
 * the user explicitly deleted. Measured 2026-08-03: a device that deleted all
 * but one fact carried 417 such rows and rendered an empty Dashboard.
 *
 * Conservative by construction — a row is destroyed ONLY when all three hold:
 *   1. it carries at least one matched topic with a real `topicId` (rows with
 *      no topic evidence are never judged here), AND
 *   2. none of those topic ids still exists, AND
 *   3. it is not a top-headline row (`headline_scope` set) — those belong to a
 *      scope section and never depended on a fact in the first place.
 *
 * Returns the number destroyed. Never throws: a failure here must not turn a
 * committed fact deletion into an error.
 */
export async function purgeSuggestionsForDeadTopics(
  liveTopicIds: Set<string>,
): Promise<number> {
  try {
    const rows = await articleSuggestionsCol.query().fetch();
    const doomed: ArticleSuggestionModel[] = [];
    for (const row of rows) {
      if (row.headlineScope) continue; // has a scope section regardless
      const refs = parseMatchedTopicRefs(row.matchedTopicsJson);
      const owned = refs.filter((r): r is { topicId: string; text: string } => !!r.topicId);
      if (owned.length === 0) continue; // no topic evidence — leave it alone
      if (owned.some((r) => liveTopicIds.has(r.topicId))) continue; // still owned
      doomed.push(row);
    }
    if (doomed.length === 0) return 0;

    // The join rows carry the suggestion id, so they must go in the same batch
    // or they outlive their parent as unreachable orphans of their own.
    const suggestionIds = new Set(doomed.map((r) => r.id));
    const joins = await articleSuggestionFactsCol.query().fetch();
    const doomedJoins = joins.filter((j) => suggestionIds.has(j.articleSuggestionId));

    await database.write(async () => {
      await database.batch([
        ...doomed.map((r) => r.prepareDestroyPermanently()),
        ...doomedJoins.map((j) => j.prepareDestroyPermanently()),
      ]);
    });
    return doomed.length;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-suggestion', method: 'purgeSuggestionsForDeadTopics' },
    });
    return 0;
  }
}
