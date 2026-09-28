// What the Mera Protocol screen needs for the "Background refresh" row: which
// description to show, and a read and a write of the toggle that never throw
// into a render.
//
// The settings module is required lazily: it imports setting-service, which
// opens SQLite at import, and the screen's own test suite must not.

export type BgRefreshDescriptionKey =
  | 'meraProtocol.bgRefreshCloudIos'
  | 'meraProtocol.bgRefreshCloudAndroid'
  | 'meraProtocol.bgRefreshOnDevice';

export const BG_REFRESH_TITLE_KEY = 'meraProtocol.bgRefreshTitle';

/**
 * The copy depends on what the run will actually do. On-device mode fetches
 * and persists only (the phone ranks on open), so it says nothing about
 * ranking or data sharing. Cloud mode names the one platform limit the reader
 * can act on. There is no status line: `getStatusAsync` detects only the iOS
 * simulator and Expo Go, never Low Power Mode or a disabled Background App
 * Refresh, so any "available" line would be a guess.
 */
export function bgRefreshDescriptionKey(onDevice: boolean, os: string): BgRefreshDescriptionKey {
  if (onDevice) return 'meraProtocol.bgRefreshOnDevice';
  return os === 'android' ? 'meraProtocol.bgRefreshCloudAndroid' : 'meraProtocol.bgRefreshCloudIos';
}

/** The toggle, ON when unreadable: that is its default. */
export async function loadBgRefreshToggle(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require('./bg-refresh-settings') as typeof import('./bg-refresh-settings');
    return await settings.isBgRefreshEnabled();
  } catch {
    return true;
  }
}

/** Persist the toggle and re-sync the OS task. Rejects only if the save failed. */
export async function saveBgRefreshToggle(enabled: boolean): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const settings = require('./bg-refresh-settings') as typeof import('./bg-refresh-settings');
  await settings.setBgRefreshEnabled(enabled);
}
