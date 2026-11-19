import { PodError } from './pod-client';
import { podPaired, podState, savePairing } from './pod-state';
import { podSyncSettled, syncPodInWake } from './pod-runner';

const WAKE_SYNC_MS = 25_000;

/** Off until the person turns it on. It lives in the pairing item, so unpairing or a new pairing removes it. */
export const wakeupsOn = (): boolean => podPaired() && podState.get()?.wakeups === true;

export async function setWakeups(on: boolean): Promise<void> {
  const item = podState.get();
  if (!podPaired() || !item) throw new PodError('failed');
  await savePairing({ ...item, wakeups: on || undefined });
}

/** The same sign-in test as the OS background task: the keychain is readable and holds a session cookie. */
async function signedIn(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authClient, AUTH_COOKIE_KEY } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SecureStore = require('expo-secure-store') as typeof import('expo-secure-store');
  await SecureStore.getItemAsync(AUTH_COOKIE_KEY);
  const cookie = authClient.getCookie();
  return typeof cookie === 'string' && cookie.length > 0;
}

/**
 * A `pod-sync` push: one sync with the person's own server, and nothing else. Signed out, unpaired,
 * with wake-ups off, while a sync runs or within 60 s of the last one, it sends no request at all.
 * Never throws and never reports: a failed wake is just a missed one.
 */
export async function syncFromPodPush(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!(await signedIn())) return;
    await podState.hydrate();
    if (!wakeupsOn() || !podSyncSettled()) return;
    const sync = syncPodInWake();
    sync.catch(() => undefined);
    await Promise.race([sync, new Promise<void>((resolve) => (timer = setTimeout(resolve, WAKE_SYNC_MS)))]);
  } catch {
    // The next push or the next foreground sync tries again.
  } finally {
    clearTimeout(timer);
  }
}
