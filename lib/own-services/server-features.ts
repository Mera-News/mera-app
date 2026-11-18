import { ownNewsOn, ownNewsState } from './own-news-state';
import { podPaired } from './pod-state';

/** Server fact checks are Mera-only: off while the person uses their own news server or pod. */
export const serverFactChecksOffered = (): boolean => !ownNewsOn() && !podPaired();

/** The same, subscribed to the mode so screens re-render when it changes. */
export function useServerFactChecksOffered(): boolean {
  const own = ownNewsState.useStore((s) => s.hydrated && s.value?.on === true);
  return !own && !podPaired();
}
