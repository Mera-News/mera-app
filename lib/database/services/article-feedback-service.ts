// Article-Feedback Service — local-only log of taps on the
// `ArticleFeedbackPrompt` widget (like / improve / dislike). Drives the
// "liked" acknowledgment state on the suggestion/detail screens via
// `hasLiked`, restored on remount. Idempotent per (article_id, sentiment) —
// repeated taps of the same sentiment on the same article do not create
// duplicate rows. `removeArticleFeedback` lets a sentiment be retracted
// (e.g. re-tapping "like" to un-like), deleting the matching row(s).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import logger from '../../logger';
import type ArticleFeedbackModel from '../models/ArticleFeedback';

const articleFeedbackCol = database.get<ArticleFeedbackModel>('article_feedback');

export type ArticleFeedbackSentiment = 'like' | 'improve' | 'dislike';

export interface RecordArticleFeedbackInput {
  articleId: string;
  suggestionId?: string | null;
  sentiment: ArticleFeedbackSentiment;
  title: string;
  // ── Origin-aware feedback (schema v38) — all optional & backward-compatible.
  // The legacy ArticleFeedbackPrompt callers omit these (persisted as null);
  // the universal ArticleActionsRow fills them from its FeedbackSubject.
  origin?: 'suggestion' | 'article' | null;
  surface?: string | null;
  /** JSON snapshot of FeedbackSubject extras (scopeKey, stableClusterId, …). */
  contextJson?: string | null;
}

/**
 * Records a feedback tap for an article. Idempotent per (articleId,
 * sentiment) — if a row already exists for that pair, this is a no-op so
 * repeated taps (e.g. re-liking after remount) never create duplicates.
 */
export async function recordArticleFeedback(
  input: RecordArticleFeedbackInput,
): Promise<void> {
  const articleId = (input.articleId ?? '').trim();
  if (!articleId) return;

  try {
    const existing = await articleFeedbackCol
      .query(
        Q.where('article_id', articleId),
        Q.where('sentiment', input.sentiment),
      )
      .fetch();
    if (existing.length > 0) return;

    await database.write(async () => {
      await articleFeedbackCol.create((r) => {
        r.articleId = articleId;
        r.suggestionId = input.suggestionId ?? null;
        r.sentiment = input.sentiment;
        r.title = input.title;
        r.origin = input.origin ?? null;
        r.surface = input.surface ?? null;
        r.contextJson = input.contextJson ?? null;
        r.createdAt = new Date();
      });
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'record' },
    });
  }
}

/**
 * Removes any feedback row(s) matching (articleId, sentiment) — e.g.
 * un-liking by re-tapping an already-liked button. No-op if no matching row
 * exists.
 */
export async function removeArticleFeedback(
  articleId: string,
  sentiment: ArticleFeedbackSentiment,
): Promise<void> {
  const id = (articleId ?? '').trim();
  if (!id) return;

  try {
    const existing = await articleFeedbackCol
      .query(Q.where('article_id', id), Q.where('sentiment', sentiment))
      .fetch();
    if (existing.length === 0) return;

    await database.write(async () => {
      for (const row of existing) {
        await row.destroyPermanently();
      }
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'remove' },
    });
  }
}

/** Verdict sentiments the feed surface records (a subset of the full union). */
export type VerdictSentiment = 'like' | 'dislike';

/**
 * Records a verdict feedback row with LATEST-WINS semantics: recording one
 * sentiment removes any existing OPPOSITE-sentiment row for the same article
 * first (a card can't be both liked and disliked). Kept separate from the plain
 * `recordArticleFeedback` so the card action rows (which allow like + dislike to
 * coexist independently) keep their existing behavior.
 */
export async function recordVerdictFeedback(
  input: RecordArticleFeedbackInput & { sentiment: VerdictSentiment },
): Promise<void> {
  const articleId = (input.articleId ?? '').trim();
  if (!articleId) return;
  const opposite: VerdictSentiment = input.sentiment === 'like' ? 'dislike' : 'like';
  await removeArticleFeedback(articleId, opposite);
  await recordArticleFeedback(input);
}

/**
 * Merges a feedback-tree path into an existing verdict row's `context_json`
 * (under `treePath`). No-op if no matching (articleId, sentiment) row exists.
 * The path is the array of node ids/labels the user tapped in the inline tree.
 */
export async function updateFeedbackContextPath(
  articleId: string,
  sentiment: VerdictSentiment,
  treePath: string[],
): Promise<void> {
  const id = (articleId ?? '').trim();
  if (!id) return;
  try {
    const existing = await articleFeedbackCol
      .query(Q.where('article_id', id), Q.where('sentiment', sentiment))
      .fetch();
    if (existing.length === 0) return;

    await database.write(async () => {
      for (const row of existing) {
        let snapshot: Record<string, unknown> = {};
        if (row.contextJson) {
          try {
            const parsed = JSON.parse(row.contextJson);
            if (parsed && typeof parsed === 'object') snapshot = parsed as Record<string, unknown>;
          } catch {
            /* corrupt json — overwrite with a fresh snapshot */
          }
        }
        snapshot.treePath = treePath;
        await row.update((r) => {
          r.contextJson = JSON.stringify(snapshot);
        });
      }
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'updateContextPath' },
    });
  }
}

/**
 * Returns all UNPROCESSED verdict rows (processed_at null, sentiment
 * like|dislike) — the deferred daily-plan wave claims these to fold into the
 * persona. Newest-first.
 */
export async function getUnprocessedFeedback(): Promise<ArticleFeedbackModel[]> {
  try {
    return await articleFeedbackCol
      .query(
        Q.where('processed_at', null),
        Q.where('sentiment', Q.oneOf(['like', 'dislike'])),
        Q.sortBy('created_at', Q.desc),
      )
      .fetch();
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'getUnprocessed' },
    });
    return [];
  }
}

/** Count of unprocessed verdict rows (processed_at null, sentiment like|dislike). */
export async function countUnprocessedFeedback(): Promise<number> {
  try {
    return await articleFeedbackCol
      .query(
        Q.where('processed_at', null),
        Q.where('sentiment', Q.oneOf(['like', 'dislike'])),
      )
      .fetchCount();
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'countUnprocessed' },
    });
    return 0;
  }
}

/** Stamps the given row ids as processed (processed_at = now). */
export async function markFeedbackProcessed(rowIds: string[]): Promise<void> {
  const ids = rowIds.filter((id) => !!id);
  if (ids.length === 0) return;
  try {
    const rows = await articleFeedbackCol.query(Q.where('id', Q.oneOf(ids))).fetch();
    if (rows.length === 0) return;
    const now = Date.now();
    await database.write(async () => {
      await database.batch(
        rows.map((row) => row.prepareUpdate((r) => {
          r.processedAt = now;
        })),
      );
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'markProcessed' },
    });
  }
}

/**
 * Stamps the matching (articleId, sentiment) verdict row(s) as processed —
 * called when the Mera chat applies the proposals derived from that verdict.
 */
export async function markFeedbackProcessedFor(
  articleId: string,
  sentiment: VerdictSentiment,
): Promise<void> {
  const id = (articleId ?? '').trim();
  if (!id) return;
  try {
    const rows = await articleFeedbackCol
      .query(Q.where('article_id', id), Q.where('sentiment', sentiment))
      .fetch();
    if (rows.length === 0) return;
    const now = Date.now();
    await database.write(async () => {
      await database.batch(
        rows.map((row) => row.prepareUpdate((r) => {
          r.processedAt = now;
        })),
      );
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'markProcessedFor' },
    });
  }
}

/**
 * Returns true if a 'like' row already exists for the given article — used
 * to restore the "liked" button state after leaving and reopening the
 * article.
 */
export async function hasLiked(articleId: string): Promise<boolean> {
  const id = (articleId ?? '').trim();
  if (!id) return false;

  try {
    const count = await articleFeedbackCol
      .query(Q.where('article_id', id), Q.where('sentiment', 'like'))
      .fetchCount();
    return count > 0;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'hasLiked' },
    });
    return false;
  }
}

/**
 * Returns the article's current verdict (like|dislike|null) plus any stored
 * feedback-tree path — used to restore the detail screen's inline feedback
 * surface across remounts. Under the verdict model (recordVerdictFeedback) at
 * most one of like/dislike exists; a stray both-present state prefers 'like'.
 */
export async function getArticleVerdict(
  articleId: string,
): Promise<{ verdict: VerdictSentiment | null; path: string[] }> {
  const id = (articleId ?? '').trim();
  if (!id) return { verdict: null, path: [] };

  try {
    const rows = await articleFeedbackCol
      .query(Q.where('article_id', id), Q.where('sentiment', Q.oneOf(['like', 'dislike'])))
      .fetch();
    if (rows.length === 0) return { verdict: null, path: [] };

    const row = rows.find((r) => r.sentiment === 'like') ?? rows[0];
    const verdict = row.sentiment === 'like' ? 'like' : 'dislike';

    let path: string[] = [];
    if (row.contextJson) {
      try {
        const parsed = JSON.parse(row.contextJson);
        if (parsed && Array.isArray(parsed.treePath)) {
          path = parsed.treePath.filter((x: unknown): x is string => typeof x === 'string');
        }
      } catch {
        /* corrupt json — no path to restore */
      }
    }
    return { verdict, path };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'getArticleVerdict' },
    });
    return { verdict: null, path: [] };
  }
}
