// use-track-button: what Follow does, for every surface that offers it (the
// shared ••• sheet and the Saved card's inline row, both through the sheet).
//
// It reports state and exposes the actions; the SHEET draws the result as a
// level (the "already following" and free-tier levels), so Follow looks like
// every other ••• sub-menu instead of opening a centred dialog of its own.
//
// Behaviour (Q13):
//   untracked → the unchanged proposal flow (floating chat + auto-sent seed),
//               UNLESS entitlement is locked: starting a NEW story needs an
//               active plan, so that case is the free-tier level instead.
//   tracked   → the "already following" level: re-following isn't possible,
//               and it offers "Go to story". It deliberately does NOT offer
//               untrack; that destructive path lives on the story timeline,
//               behind its own confirm. Entitlement-independent.
//
// `getAiAccess() === 'unknown'` (cold start) is treated as entitled: never
// block a paying subscriber for the first second of a launch.

import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useTrackedSubject } from '@/lib/tracking/use-tracked-subject';
import { getAiAccess } from '@/lib/stores/subscription-store';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import { router } from 'expo-router';
import { useCallback } from 'react';

export type FollowOutcome = 'tracked' | 'locked' | 'start';

export interface UseTrackButton {
  /** Whether an active story already covers this subject (label + state). */
  tracked: boolean;
  /** What a Follow tap should do now. Imperative: reads entitlement at the tap. */
  resolve: () => FollowOutcome;
  /** Start the proposal flow (floating chat + seed). */
  startTracking: () => void;
  /** Open the already-followed story's timeline. */
  goToStory: () => void;
  /** Present the plans (the free-tier level's action). */
  seePlans: () => Promise<void>;
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

  const resolve = useCallback((): FollowOutcome => {
    if (tracked) return 'tracked';
    // `getAiAccess()` (imperative), not `useAiAccess()`: this runs in a tap.
    if (getAiAccess() === 'locked') return 'locked';
    return 'start';
  }, [tracked]);

  const seePlans = useCallback(async () => {
    await presentFreeTierPaywall('useTrackButton');
  }, []);

  const goToStory = useCallback(() => {
    if (!trackedStoryId) return;
    router.push({
      pathname: '/logged-in/story-timeline',
      params: { trackedStoryId },
    });
  }, [trackedStoryId]);

  return { tracked, resolve, startTracking, goToStory, seePlans };
}
