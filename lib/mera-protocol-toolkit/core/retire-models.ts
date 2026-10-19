// Boot-time retirement of on-device models no longer in the catalogue.
//
// Runs once after hydrateAllStores(), for OnDevice users only (Cloud users
// already have every model purged by the boot step in use-app-root). Nothing
// here may block boot: every failure is captured and swallowed.

import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { RETIRED_MODEL_IDS } from './model-catalog';
import { deleteBaseModel, isModelDownloaded } from './modelManager';

/**
 * Deletes the files of every retired model, then enforces the one rule that
 * matters: OnDevice mode requires BOTH on-device models on disk.
 *
 * A phone missing either (an update from the single-model catalogue, a
 * half-finished download, a file the OS evicted from Caches) falls back to Cloud
 * LOCALLY ONLY. The server persona keeps saying OnDevice, which is the reader's
 * intent: the settings screen reads it, offers the download, and the download
 * path promotes the phone back once both files land.
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
}
