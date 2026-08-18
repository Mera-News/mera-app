// iCloud, via CloudKit.
//
// `isCloudAvailable()` is the ONLY truth about whether iCloud can be used, and
// it is a RUNTIME condition, never a build one. It goes false when the user is
// not signed into iCloud, when iCloud Drive is off for this app, and — the one
// that produces the confusing bug report — for a short window right after
// launch, before the CloudKit account status resolves. So availability is
// re-asked at the point of use rather than cached at startup, and the settings
// screen subscribes to changes instead of reading it once.
//
// Never infer availability from `Platform.OS === 'ios'`. An iPhone with iCloud
// switched off is an iPhone.

import { CloudStorage, CloudStorageProvider } from 'react-native-cloud-storage';
import { Platform } from 'react-native';

import type { BackupProvider } from '../types';
import {
  BACKUP_SCOPE,
  REMOTE_DIRECTORY,
  downloadTo,
  listWithPrefix,
  removeRemote,
  uploadTo,
} from './shared';

let instance: CloudStorage | null = null;

/**
 * One instance per provider rather than the static default. The Drive adapter
 * mutates provider options to install its access token, and a shared default
 * instance would mean configuring one provider reconfigured the other.
 */
function storage(): CloudStorage {
  instance ??= new CloudStorage(CloudStorageProvider.ICloud, { scope: BACKUP_SCOPE });
  return instance;
}

/**
 * Whether this PLATFORM can ever offer iCloud. Synchronous and build-time, and
 * deliberately separate from `isAvailable()`, which is a runtime question.
 *
 * The two must not be collapsed, because they call for opposite UI. On Android
 * iCloud can never work, so the row should not exist at all — offering a
 * permanently greyed-out option is noise. On iOS with the user signed out of
 * iCloud it CAN work, so the row belongs there with a hint explaining what to
 * do about it.
 */
export function isICloudSupported(): boolean {
  return Platform.OS === 'ios';
}

export const icloudProvider: BackupProvider = {
  id: 'icloud',

  async isAvailable(): Promise<boolean> {
    if (!isICloudSupported()) return false;
    try {
      return await storage().isCloudAvailable();
    } catch {
      // A throw here is the same answer as false, and a backup screen that
      // crashes is worse than one that says iCloud is unavailable.
      return false;
    }
  },

  upload: (localPath, remotePath) => uploadTo(storage(), localPath, remotePath),
  download: (remotePath, localPath) => downloadTo(storage(), remotePath, localPath),
  list: (prefix) => listWithPrefix(storage(), prefix),
  remove: (remotePath) => removeRemote(storage(), remotePath),
};

/**
 * Notifies on iCloud availability changes.
 *
 * The method is `subscribeToCloudAvailability` / `unsubscribeFromCloudAvailability`
 * — not the `onCloudAvailabilityChanged` the plan named, which does not exist.
 * Returns its own unsubscribe so callers do not have to keep the listener
 * reference alive themselves.
 */
export function subscribeToICloudAvailability(
  listener: (available: boolean) => void,
): () => void {
  const s = storage();
  s.subscribeToCloudAvailability(listener);
  return () => s.unsubscribeFromCloudAvailability(listener);
}

export { REMOTE_DIRECTORY };
