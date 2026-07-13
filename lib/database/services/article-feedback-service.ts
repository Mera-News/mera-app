// Article-Feedback Service — local-only log of taps on the
// `ArticleFeedbackPrompt` widget (like / improve / dislike). Drives the
// "liked" acknowledgment state on the suggestion/detail screens via
// `hasLiked`, restored on remount. Idempotent per (article_id, sentiment) —
// repeated taps of the same sentiment on the same article do not create
// duplicate rows.

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
