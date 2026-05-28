// Download Service — Module-level download orchestrator
// Ensures downloads survive screen navigation and notifies on completion/error
// Progress comes from RNFS native callbacks (no more polling)

import * as Notifications from 'expo-notifications';
import logger from '../../logger';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import type { BaseModelDownloadConfig } from '../types';
import {
  cancelActiveDownload,
  downloadBaseModel,
  type DownloadProgressInfo,
} from './modelManager';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let downloadPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Notification helpers (completion / error only)
// ---------------------------------------------------------------------------

async function hasNotificationPermission(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

async function showCompletionNotification(): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: 'model-download-complete',
      content: {
        title: 'Download Complete',
        body: 'Mera Protocol is now ready for use.',
        data: { type: 'model-download-complete' },
      },
      trigger: null,
    });
  } catch {
    // Best-effort
  }
}

async function showErrorNotification(message: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: 'model-download-error',
      content: {
        title: 'Download Failed',
        body: message,
        data: { type: 'model-download-error' },
      },
      trigger: null,
    });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns true if a download is currently in progress. */
export function isDownloadInProgress(): boolean {
  return downloadPromise !== null;
}

/**
 * Starts the model download if not already in progress.
 * The download promise is held at module level so it survives screen navigation.
 * Progress is reported via native RNFS callbacks (no polling).
 * Notifications are only sent on completion or error.
 */
export function startModelDownload(config: BaseModelDownloadConfig): void {
  if (downloadPromise) return;

  const store = useMeraProtocolStore.getState();
  store.setModelState('downloading');
  store.setDownloadProgress(0);

  downloadPromise = (async () => {
    const canNotify = await hasNotificationPermission();

    try {
      await downloadBaseModel(config, (info: DownloadProgressInfo) => {
        const pct = Math.min(Math.round(info.progress), 99);
        const mbDown = (info.bytesWritten / (1024 * 1024)).toFixed(1);
        const mbTotal = (info.contentLength / (1024 * 1024)).toFixed(0);
        logger.info(`[DownloadService] ${mbDown} MB / ${mbTotal} MB (${pct}%)`);
        useMeraProtocolStore.getState().setDownloadProgress(pct);
      });

      useMeraProtocolStore.getState().setModelState('downloaded');
      useMeraProtocolStore.getState().setDownloadProgress(100);
      if (canNotify) await showCompletionNotification();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Download failed';
      logger.captureException(error, { tags: { source: 'DownloadService', method: 'startModelDownload' } });
      useMeraProtocolStore.getState().setModelError(message);
      if (canNotify) await showErrorNotification(message);
    } finally {
      downloadPromise = null;
    }
  })();
}

/** Cancels the active download. */
export async function cancelModelDownload(): Promise<void> {
  cancelActiveDownload();
  downloadPromise = null;
  useMeraProtocolStore.getState().setModelState('not_downloaded');
  useMeraProtocolStore.getState().setDownloadProgress(0);
}
