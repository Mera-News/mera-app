// Article-Feedback Service — local-only log of taps on the
// `ArticleFeedbackPrompt` widget (like / improve / dislike). Drives the
// "liked" acknowledgment state on the suggestion/detail screens via
// `hasLiked`, restored on remount. Idempotent per (article_id, sentiment) —
// repeated taps of the same sentiment on the same article do not create
// duplicate rows. `removeArticleFeedback` lets a sentiment be retracted
// (e.g. re-tapping "like" to un-like), deleting the matching row(s).
//
// ── D15: a BARE verdict is PROVISIONAL and is discarded ─────────────────────
// A thumb tap on its own is not evidence — it says "something about this",
// never what. The app used to speculate from it anyway: two context-less
// dislikes were enough for the 3-hourly digest (feedback-digest's
// `aggregateCandidates`) to lower a topic weight, with nothing shown to the
// user. That aggregation is deliberately retired here.
//
// The row is still written (it drives the inline feedback surface, the
// un-vote, and the impression bookkeeping), but a row whose `context_json`
// carries no non-empty `treePath` is REAPED AT WRITE: `processed_at` is
// stamped immediately, so the existing `processed_at IS NULL` predicate in
// `getUnprocessedFeedback` / `countUnprocessedFeedback` excludes it by
// construction and it can never reach the digest.
//
// `processed_at` therefore means "not pending for the digest" rather than
// "the digest folded this in". The two ways a row leaves that state:
//   • context ARRIVES  → `updateFeedbackContextPath` with a non-empty path
//     clears `processed_at`, so a part-way tree path IS digestible (that is
//     what feeds the digest's contextful `pathCandidates`);
//   • context COMMITS  → a terminal leaf applies its persona actions on the
//     spot (D16, InlineFeedbackTree / FeedbackTreeOverlay) and then calls
//     `markFeedbackProcessedFor`, so the digest can never double-apply it.
//
// ── F2/F3: what the UI may call "committed" ─────────────────────────────────
// `treePath` is written on every tap in the tree — INCLUDING descending a
// branch, which commits nothing. Deriving the filled thumb from
// `treePath.length > 0` therefore promised "this changed your persona" the
// instant the user merely navigated, one tap after the caption promised the
// opposite; abandoning the panel with × left that promise standing, and it
// survived a process restart because the path is a real row write.
//
// So the UI discriminator is now its OWN persisted field: `context_json.committed`,
// set only by a call that passes `committed: true` — a TERMINAL leaf settling, or
// a chat escalation. It is STICKY: once a leaf has applied, walking back up the
// breadcrumb must not un-fill the thumb, because the change is still in force
// and un-voting (which reverts it) is the only way out.
//
// `processed_at`'s re-open rule is deliberately NOT changed here — see
// `updateFeedbackContextPath`.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import logger from '../../logger';
import { revertChange } from './persona-change-log-service';
import type ArticleFeedbackModel from '../models/ArticleFeedback';

const articleFeedbackCol = database.get<ArticleFeedbackModel>('article_feedback');

/** DEPRECATED: `'improve'` has no writer anywhere in the app and is filtered
 *  out of `getUnprocessedFeedback`/`countUnprocessedFeedback`, so a row of this
 *  sentiment would be invisible to every consumer. Kept in the union only
 *  because a pre-existing test asserts it round-trips (see
 *  `__tests__/article-feedback-service.test.ts`); delete both together. */
export type ArticleFeedbackSentiment = 'like' | 'improve' | 'dislike';

/**
 * True when a stored `context_json` snapshot carries a non-empty `treePath` —
 * the D15 commit discriminator. A verdict WITH one has a reason attached (the
 * user picked at least one tree node, or escalated to Mera along a path); a
 * verdict without one is a bare tap and stays provisional.
 */
function hasTreeContext(contextJson: string | null | undefined): boolean {
  if (!contextJson) return false;
  try {
    const parsed = JSON.parse(contextJson);
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.treePath) &&
      parsed.treePath.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * True when a stored `context_json` snapshot has been COMMITTED — a terminal
 * leaf settled (or the user escalated to Mera along the path). This, and not
 * `treePath`, is what a filled thumb means: `treePath` also records a branch
 * descent, which changes nothing.
 */
function isCommitted(contextJson: string | null | undefined): boolean {
  if (!contextJson) return false;
  try {
    const parsed = JSON.parse(contextJson);
    return !!parsed && typeof parsed === 'object' && parsed.committed === true;
  } catch {
    return false;
  }
}

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

    // D15 — reap-at-write: a verdict with no tree path is provisional, so it is
    // born already-processed and never reaches the digest. Context arriving
    // later (updateFeedbackContextPath) re-opens it.
    const provisional = !hasTreeContext(input.contextJson);

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
        if (provisional) r.processedAt = Date.now();
      });
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'record' },
    });
  }
}

/** The persona-change-log ids a committed verdict's leaf actually applied, as
 *  stored on its `context_json`. Empty for a verdict that never committed. */
function readChangeLogIds(contextJson: string | null | undefined): string[] {
  if (!contextJson) return [];
  try {
    const parsed = JSON.parse(contextJson);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.changeLogIds)) return [];
    return parsed.changeLogIds.filter((x: unknown): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * Removes any feedback row(s) matching (articleId, sentiment) — e.g.
 * un-liking by re-tapping an already-liked button — AND reverts whatever the
 * verdict's tree leaf actually applied to the persona. No-op if no matching row
 * exists.
 *
 * The revert is the other half of D15's trust contract. Once a terminal leaf
 * applies on the spot (D16), "unfilled" would otherwise be able to mean "this
 * changed your persona, and the change is still in force" — the same
 * UI-says-one-thing / persona-says-another problem this wave exists to remove.
 * This is the single choke point every surface's un-vote (and every like↔dislike
 * FLIP, via `recordVerdictFeedback`) already funnels through, so the contract
 * cannot drift per surface.
 *
 * Best-effort, per id, exactly like the sweeps: the row deletion and the thumb
 * state are the user's stated intent and are never blocked by a revert failure.
 * A partial revert reverts what it can and logs the shortfall rather than
 * rolling the successes back.
 *
 * `revertChange` (Phase 3) runs the retroactive sweeps and sets the feed-dirty
 * flag itself, so reverting a leaf that minted a hard filter also un-excludes
 * its casualties. Nothing here re-implements that.
 */
export async function removeArticleFeedback(
  articleId: string,
  sentiment: ArticleFeedbackSentiment,
): Promise<void> {
  const id = (articleId ?? '').trim();
  if (!id) return;

  let changeLogIds: string[] = [];
  try {
    const existing = await articleFeedbackCol
      .query(Q.where('article_id', id), Q.where('sentiment', sentiment))
      .fetch();
    if (existing.length === 0) return;

    changeLogIds = existing.flatMap((row) => readChangeLogIds(row.contextJson));

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

  // Outside the try above: the verdict is already gone, and a revert failure
  // must not be reported as a failure to un-vote.
  await revertAppliedChanges(changeLogIds, id, sentiment);
}

/**
 * Reverts the persona changes a verdict's leaf applied. Each id is independent:
 * one failure never prevents the others, and the shortfall is logged with the
 * counts so a systematic failure is visible.
 */
async function revertAppliedChanges(
  changeLogIds: string[],
  articleId: string,
  sentiment: ArticleFeedbackSentiment,
): Promise<void> {
  if (changeLogIds.length === 0) return;
  let reverted = 0;
  for (const changeLogId of changeLogIds) {
    try {
      await revertChange(changeLogId);
      reverted += 1;
    } catch (error) {
      logger.captureException(error, {
        tags: { service: 'article-feedback', method: 'revertOnUnvote' },
        extra: { changeLogId, articleId, sentiment },
      });
    }
  }
  if (reverted < changeLogIds.length) {
    logger.addBreadcrumb(
      '[article-feedback] un-vote reverted only part of the applied change',
      'article-feedback',
      { articleId, sentiment, reverted, total: changeLogIds.length },
      'warning',
    );
  }
}

/**
 * Records the persona-change-log ids a terminal leaf just applied onto the
 * verdict row, so a later un-vote can revert exactly those changes. Merged into
 * the same `context_json` snapshot as `treePath`; ids ACCUMULATE, since a user
 * can pick more than one leaf before changing their mind.
 */
export async function recordFeedbackChangeLogIds(
  articleId: string,
  sentiment: VerdictSentiment,
  changeLogIds: string[],
): Promise<void> {
  const id = (articleId ?? '').trim();
  const ids = (changeLogIds ?? []).filter((x) => !!x);
  if (!id || ids.length === 0) return;
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
        const merged = new Set([...readChangeLogIds(row.contextJson), ...ids]);
        snapshot.changeLogIds = Array.from(merged);
        await row.update((r) => {
          r.contextJson = JSON.stringify(snapshot);
        });
      }
    });
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'recordChangeLogIds' },
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
 *
 * A NON-EMPTY path clears `processed_at` (the row becomes digestible via the
 * contextful `pathCandidates`); an empty path (the user backed all the way out)
 * puts it back to provisional. That rule is UNCHANGED and deliberately so — a
 * part-way path being digestible is the documented intent of D15 and is asserted
 * by a pre-existing test.
 *
 * `committed` is a SEPARATE, narrower marker and the only thing the UI's filled
 * state may read (F2/F3). Pass it from a terminal leaf or a chat escalation;
 * a branch descent must not. It is sticky — once true it stays true for the life
 * of the row, since the leaf's persona change is still in force until un-vote
 * reverts it. It is written only when true, so an uncommitted row's snapshot is
 * byte-for-byte what it was before this field existed.
 */
export async function updateFeedbackContextPath(
  articleId: string,
  sentiment: VerdictSentiment,
  treePath: string[],
  committed = false,
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
        // Sticky, and written ONLY when true — never `committed: false`.
        if (committed || snapshot.committed === true) snapshot.committed = true;
        const contextful = treePath.length > 0;
        await row.update((r) => {
          r.contextJson = JSON.stringify(snapshot);
          r.processedAt = contextful ? null : Date.now();
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
 *
 * Under D15 the `processed_at IS NULL` predicate is ALSO the contextful filter:
 * a bare verdict is stamped processed at write, so only rows carrying a
 * `context_json.treePath` ever appear here. The query is unchanged — the
 * discrimination happens at the writer (see the file header).
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
 * Returns the article's current verdict (like|dislike|null), any stored
 * feedback-tree path, and whether that verdict was ever COMMITTED — used to
 * restore the detail screen's inline feedback surface across remounts. Under the
 * verdict model (recordVerdictFeedback) at most one of like/dislike exists; a
 * stray both-present state prefers 'like'.
 *
 * `path` restores WHERE the user was in the tree; `committed` is the only thing
 * a filled thumb may be derived from. They are not the same question: a path
 * exists the moment a branch is opened (F2). `committed` is optional on the
 * return type so existing mocks of this function keep type-checking.
 */
export async function getArticleVerdict(
  articleId: string,
): Promise<{ verdict: VerdictSentiment | null; path: string[]; committed?: boolean }> {
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
    return { verdict, path, committed: isCommitted(row.contextJson) };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-feedback', method: 'getArticleVerdict' },
    });
    return { verdict: null, path: [] };
  }
}
