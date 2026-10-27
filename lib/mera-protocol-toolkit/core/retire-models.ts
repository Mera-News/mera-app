// Boot-time retirement of on-device models no longer in the catalogue.
//
// Runs once after hydrateAllStores(), for OnDevice users only. Local Cloud
// users go through the boot purge in use-app-root instead, which deletes every
// model file except the current catalogue model. Nothing
// here may block boot: every failure is captured and swallowed.

import { deleteSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { RETIRED_MODEL_IDS } from './model-catalog';
import { deleteBaseModel, isModelDownloaded } from './modelManager';
import { RETIRED_TEXT_ENGINE_SETTING } from './text-engine';

/** The notice's notification type: one per day at most. */
export const ON_DEVICE_FALLBACK_NOTICE = 'on-device-fallback';

/**
 * Deletes the files of every retired model (the Qwen text model among them,
 * D37), then enforces the one rule that matters: OnDevice mode requires On this
 * phone to be runnable, Kev on disk AND the built-in model available.
 *
 * A phone that cannot run it (a phone with no built-in model that used the
 * retired text model, Apple Intelligence switched off, a file the OS evicted
 * from Caches) falls back to Cloud LOCALLY ONLY, and says so: a notice in the
 * notifications inbox, with a toast when the app can show one. Never silently
 * (D37). The server persona keeps saying OnDevice, which is the reader's intent:
 * the settings screen reads it and shows why, and the download path or the
 * foreground restore promote the phone back once it can run.
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

  deleteSetting(RETIRED_TEXT_ENGINE_SETTING).catch(() => {});

  const store = useMeraProtocolStore.getState();
  if (store.processingMode !== ProcessingMode.OnDevice) return;
  if ((await localModeFor(ProcessingMode.OnDevice)) === ProcessingMode.OnDevice) return;

  store.setProcessingMode(ProcessingMode.Cloud);
  store.setModelState('not_downloaded');
  store.setDownloadProgress(0);
}

/** Lazy: the toast manager reaches components, and this module is in the toolkit barrel. */
async function showFallbackNotice(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { toastManager } = require('@/lib/toast-manager') as typeof import('@/lib/toast-manager');
    await toastManager.showNotifiedToast({
      type: ON_DEVICE_FALLBACK_NOTICE,
      source: 'mera-protocol',
      title: 'meraProtocol.fallbackNoticeTitle',
      body: 'meraProtocol.fallbackNoticeBody',
      dedupeDaily: true,
    });
  } catch (err) {
    logger.captureException(err, { tags: { component: 'retire-models', method: 'fallback-notice' } });
  }
}

/**
 * The mode this phone may run for a given server persona mode: OnDevice only
 * when On this phone can run now, else Cloud. Every copy of the server mode into
 * the local store goes through this, so the local Private cloud fallback is never
 * undone by a persona read while the server keeps the on-device intent. When the
 * answer moves a phone that is on OnDevice now to Cloud, the reader is told
 * (D37): the notice fires here, where every such move passes.
 */
export async function localModeFor(mode: ProcessingMode): Promise<ProcessingMode> {
  if (mode !== ProcessingMode.OnDevice) return mode;
  const runnable = await isModelDownloaded().catch(() => false);
  if (runnable) return mode;
  if (useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice) await showFallbackNotice();
  return ProcessingMode.Cloud;
}
