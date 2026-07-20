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
