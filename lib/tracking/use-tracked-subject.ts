// useTrackedSubject — shared "is this story followed + toggle" state for the
// track button that now lives in THREE places (ArticleActionsRow,
// CompactActionsSheet, ArticleFeedbackPrompt). Each needs the identical
// mount-restore + optimistic-toggle + haptics logic; the hook removes that
// triplicated boilerplate (the specific friction it pays for).

import { useCallback, useEffect, useState } from 'react';
import type { FeedbackSubject } from '../../components/custom/cards/feedback-subject';
import { hapticLight, hapticSuccess } from '../haptics';
import {
  isSubjectTracked,
  trackStoryFromSubject,
  untrackStoryFromSubject,
} from './track-actions';

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
      hapticLight();
      setTracked(false);
      void untrackStoryFromSubject(subject);
    } else {
      hapticSuccess();
      setTracked(true);
      void trackStoryFromSubject(subject);
    }
    // Toggle keyed on the identity fields + current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked, subject.stableClusterId, subject.articleId, subject.title, subject.surface]);

  return { tracked, toggle };
}
