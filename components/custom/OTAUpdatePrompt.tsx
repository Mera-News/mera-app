import { useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

import OTAUpdateModal from '@/components/custom/OTAUpdateModal';
import logger from '@/lib/logger';
import { isTransientNetworkError } from '@/lib/utils/transient-error';

/**
 * Dev-only preview override for the update modal (there is no real pending
 * update in a dev client — `Updates.isEnabled` is false). Flip to true to see
 * the modal in the simulator; never ships true.
 */
const DEV_FORCE_UPDATE_MODAL = false;

/**
 * Watches for a fetched-and-pending OTA update and takes over the screen with
 * the mandatory-update modal (OTAUpdateModal). This used to be a tappable
 * toast; it became a takeover deliberately — the toast was ignorable, so
 * users sat on stale JS until their next cold start (and the toast itself
 * shipped broken as an icon-only panel, see lib/toast-manager.ts's note on
 * className-styled primitives).
 */
export default function OTAUpdatePrompt() {
  const { isUpdatePending } = Updates.useUpdates();

  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;

    const checkForUpdate = async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
        }
      } catch (error) {
        // The OTA check is best-effort — a timed-out / lost connection is
        // expected on mobile and recovers on the next foreground. Don't report
        // those (they were noisy `error`s); only surface genuinely unexpected
        // failures.
        if (isTransientNetworkError(error)) return;
        logger.captureException(error as Error, {
          tags: { component: 'OTAUpdatePrompt', method: 'checkForUpdate' },
        });
      }
    };

    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        checkForUpdate();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  return (
    <OTAUpdateModal
      visible={isUpdatePending || (__DEV__ && DEV_FORCE_UPDATE_MODAL)}
    />
  );
}
