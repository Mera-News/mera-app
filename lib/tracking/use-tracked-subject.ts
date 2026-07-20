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
import { isSubjectTracked, untrackStoryFromSubject } from './track-actions';

export interface UseTrackedSubject {
  tracked: boolean;
  toggle: () => void;
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
  const [tracked, setTracked] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    isSubjectTracked(subject)
      .then((v) => {
        if (!cancelled) setTracked(v);
      })
      .catch(() => {
        /* non-fatal — default to not-tracked */
      });
    return () => {
      cancelled = true;
    };
    // Re-run on the identity keys, not the whole subject object ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, subject.stableClusterId, subject.articleId]);

  const toggle = useCallback(() => {
    if (tracked) {
      // Untrack stays immediate (confirm-then-untrack lives in the caller).
      hapticLight();
      setTracked(false);
      void untrackStoryFromSubject(subject);
    } else {
      // Track now happens INSIDE the floating Mera chat: open it on the
      // article-feedback context (carrying the origin snapshot the proposeTrack
      // tool follows against), seeded with an auto-sent "follow this story"
      // message. The story is minted only once the user accepts the in-chat
      // proposal — so we do NOT flip optimistic state here; the button re-reads
      // isSubjectTracked on its next mount.
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
            stableClusterId: subject.stableClusterId ?? null,
            publicationName: subject.publicationName ?? null,
          },
        },
        t('trackedStories.trackChatSeed'),
      );
    }
    // Toggle keyed on the identity fields + current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked, subject.stableClusterId, subject.articleId, subject.title, subject.surface]);

  return { tracked, toggle };
}
