// use-track-button: what Follow does, for every surface that offers it (the
// shared ••• sheet and the Saved card's inline row, both through the sheet).
//
// It reports state and exposes the actions; the SHEET draws the result as a
// level (the "already following" level), so Follow looks like every other •••
// sub-menu instead of opening a centred dialog of its own.
//
// Behaviour (Q13):
//   untracked → the unchanged proposal flow (floating chat + auto-sent seed).
//               Following is free on every plan, so no plan check sits here.
//   tracked   → the "already following" level: re-following isn't possible,
//               and it offers "Go to story". It deliberately does NOT offer
//               untrack; that destructive path lives on the story timeline,
//               behind its own confirm.

import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useTrackedSubject } from '@/lib/tracking/use-tracked-subject';
import { router } from 'expo-router';
import { useCallback } from 'react';

type FollowOutcome = 'tracked' | 'start';

export interface UseTrackButton {
  /** Whether an active story already covers this subject (label + state). */
  tracked: boolean;
  /** What a Follow tap should do now. */
  resolve: () => FollowOutcome;
  /** Start the proposal flow (floating chat + seed). */
  startTracking: () => void;
  /** Open the already-followed story's timeline. */
  goToStory: () => void;
}

/**
 * @param subject What is being followed + where.
 * @param active  Gate the underlying subscription (e.g. only while a sheet is
 *                open). Defaults to true.
 */
export function useTrackButton(
  subject: FeedbackSubject,
  active: boolean = true,
): UseTrackButton {
  const { tracked, trackedStoryId, startTracking } = useTrackedSubject(subject, active);

  const resolve = useCallback((): FollowOutcome => (tracked ? 'tracked' : 'start'), [tracked]);

  const goToStory = useCallback(() => {
    if (!trackedStoryId) return;
    router.push({
      pathname: '/logged-in/story-timeline',
      params: { trackedStoryId },
    });
  }, [trackedStoryId]);

  return { tracked, resolve, startTracking, goToStory };
}
