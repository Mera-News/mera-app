// Boot-time retirement of on-device models no longer in the catalogue.
//
// Runs once after hydrateAllStores(), for OnDevice users only (Cloud users
// already have every model purged by the boot step in app/_layout.tsx). Nothing
// here may block boot: every failure is captured and swallowed.

import { AccountService } from '@/lib/account-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { RETIRED_MODEL_IDS } from './model-catalog';
import { deleteBaseModel, isModelDownloaded } from './modelManager';

/**
 * Deletes the files of every retired model, then enforces the one rule that
 * matters: OnDevice mode requires the selected model to be on disk.
 *
 * A user who was on a retired model had their selection remapped to the
 * default at hydrate, so their selected model is not downloaded and they fall
 * back to Cloud here, the same way confirmDeleteModel handles a deleted model.
 * The settings screen keeps their on-device intent and promotes them back to
 * OnDevice once they download a model from the catalogue. The same rule covers
 * a model file the OS evicted from Caches.
 */
export async function retireLegacyModels(): Promise<void> {
  for (const modelId of RETIRED_MODEL_IDS) {
    try {
      await deleteBaseModel(modelId);
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'retire-models', method: 'delete-retired' },
        extra: { modelId },
      });
    }
  }

  const store = useMeraProtocolStore.getState();
  if (store.processingMode !== ProcessingMode.OnDevice) return;

  let downloaded = false;
  try {
    downloaded = await isModelDownloaded();
  } catch {
    downloaded = false;
  }
  if (downloaded) return;

  store.setProcessingMode(ProcessingMode.Cloud);
  store.setModelState('not_downloaded');
  store.setDownloadProgress(0);

  // Local identity, never the session (only the logout button logs out, and the
  // session may not have resolved this early in boot).
  const userId = useUserStore.getState().userId;
  if (!userId) return;
  try {
    await AccountService.updateProcessingMode(userId, ProcessingMode.Cloud);
  } catch (err) {
    // Best effort. The settings screen will not re-promote OnDevice without a
    // model on disk, so a failed write here cannot strand the user.
    logger.captureException(err, {
      tags: { component: 'retire-models', method: 'update-processing-mode' },
    });
  }
}
