// useTrackedSubject — shared "is this story followed + toggle" state for the
// track button that now lives in THREE places (ArticleActionsRow,
// CompactActionsSheet, ArticleFeedbackPrompt). Each needs the identical
// mount-restore + optimistic-toggle + haptics logic; the hook removes that
// triplicated boilerplate (the specific friction it pays for).

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedbackSubject } from '../../components/custom/cards/feedback-subject';
import { hapticLight } from '../haptics';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { observeSubjectTrackedId } from './track-actions';

export interface UseTrackedSubject {
  /** True when an ACTIVE tracked story already covers this subject. */
  tracked: boolean;
  /** That story's id — what the "already following" dialog navigates to. Null
   *  when untracked. */
  trackedStoryId: string | null;
  /**
   * Begin following: opens the floating Mera chat's proposal flow.
   *
   * NO-OP when already tracked (Q13). Re-following is not a thing, and the only
   * way to stop is a destructive delete of everything saved for the story — so
   * the button must not silently untrack on a second tap. Callers branch on
   * `tracked` and show the "already following" dialog instead; the dialog +
   * navigation live in components/ (see `useTrackButton`), never here, because
   * this hook is RN-UI-free lib/ code.
   */
  startTracking: () => void;
}

/**
 * @param subject  What is being followed + where.
 * @param active   Gate the mount-restore (e.g. only when a sheet is open).
 *                 Defaults to true. Pass `false` to skip the initial read.
 */
export function useTrackedSubject(
  subject: FeedbackSubject,
  active: boolean = true,
): UseTrackedSubject {
  const { t } = useTranslation();
  const [trackedStoryId, setTrackedStoryId] = useState<string | null>(null);
  const tracked = trackedStoryId !== null;

  // LIVE subscription, not a one-shot read. Tracking is confirmed inside the
  // FLOATING Mera chat, which outlives the screen hosting this button — so a
  // mount-time read left the button saying "Track story" forever after the user
  // had already started following, and the next tap opened a SECOND proposal for
  // the same story. Subscribing means the button flips the moment the row
  // appears (or is untracked, or absorbs this article via the topic reconcile).
  useEffect(() => {
    if (!active) return;
    const sub = observeSubjectTrackedId(subject).subscribe({
      next: (id: string | null) => setTrackedStoryId(id),
      error: () => setTrackedStoryId(null), // non-fatal — default to not-tracked
    });
    return () => sub.unsubscribe();
    // Re-run on the identity keys, not the whole subject object ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, subject.stableClusterId, subject.articleId]);

  const startTracking = useCallback(() => {
    // Already following ⇒ do NOTHING here (Q13). The caller shows the
    // "already following" dialog; re-tracking is impossible and untracking is
    // destructive, so neither may happen on a stray second tap.
    if (tracked) return;
    // Track happens INSIDE the floating Mera chat: open it on the
    // article-feedback context (carrying the origin snapshot the proposeTrack
    // tool follows against), seeded with an auto-sent "follow this story"
    // message — owner-confirmed as intended. The story is minted only once the
    // user accepts the in-chat proposal, so we do NOT flip optimistic state
    // here. The live `observeSubjectTrackedId` subscription above flips the
    // button by itself the instant that row lands, with no remount needed.
    hapticLight();
    useFloatingChatStore.getState().openArticleFeedback(
      {
        kind: 'article-suggestion',
        articleId: subject.articleId,
        suggestionId: subject.suggestionId,
        articleTitle: subject.title,
        trackSubject: {
          origin: subject.origin,
          surface: subject.surface,
          articleId: subject.articleId,
          title: subject.title,
          pubDate: subject.pubDate ?? null,
          stableClusterId: subject.stableClusterId ?? null,
          publicationName: subject.publicationName ?? null,
        },
      },
      t('trackedStories.trackChatSeed'),
    );
    // Keyed on the identity fields + current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked, subject.stableClusterId, subject.articleId, subject.title, subject.surface]);

  return { tracked, trackedStoryId, startTracking };
}
