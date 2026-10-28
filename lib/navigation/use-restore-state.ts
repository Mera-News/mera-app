// The React side of the resume spot (`resume-spot.ts`): whether a restore is
// rebuilding the stacks, and a pushed screen saying whether its entity exists.
//
// Kept apart from resume-spot.ts so the gate and the restart marker load no
// React Navigation.

import { useRoute } from '@react-navigation/native';
import { useEffect, useSyncExternalStore } from 'react';

import { isRestoreInProgress, reportRestoredScreen, subscribeResumeSpot } from './resume-spot';

/** True while a restore rebuilds the stacks (their pushes run with no animation). */
export function useRestoreInProgress(): boolean {
  return useSyncExternalStore(subscribeResumeSpot, isRestoreInProgress);
}

/**
 * An article or publication screen: report 'ready' once its entity loaded,
 * 'missing' when it is gone (never for a network error). 'loading' reports
 * nothing. Only a restored screen acts on it.
 */
export function useReportRestoredScreen(status: 'loading' | 'ready' | 'missing'): void {
  const route = useRoute();
  useEffect(() => {
    if (status !== 'loading') reportRestoredScreen(route.key, status);
  }, [route.key, status]);
}
