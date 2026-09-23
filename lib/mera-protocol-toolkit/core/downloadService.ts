// Download Service — Module-level download orchestrator
// Ensures downloads survive screen navigation and notifies on completion/error
// Progress comes from RNFS native callbacks (no more polling)

import * as Notifications from 'expo-notifications';
import i18next from 'i18next';
import { holdRestart } from '../../app-restart';
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

// Bumped by every start AND every cancel. A download settles only if it is
// still the current generation: cancelling makes RNFS reject the in-flight
// download a moment later, and without this that rejection overwrote the
// cancel's clean `not_downloaded` with an error state plus a "Download Failed"
// notification, and its `finally` could clear the handle of a download started
// right after the cancel.
let downloadGeneration = 0;

// The download runs in a native background URLSession, so a JS reload does not
// stop it: a reloaded app would forget it (state reads `not_downloaded` while the
// file is still being written). Every return from background reloads the app,
// so the restart is held for the whole download, the same way a purchase or a
// streaming chat holds it. A blocked restart is deferred, never lost.
// (This hold did NOT fix MERA-APP-7M; that crash was RNFS's progress-event data
// race, removed by moving the download to expo-file-system in modelManager.ts.)
let releaseRestartHold: (() => void) | null = null;

function releaseDownloadHold(): void {
  releaseRestartHold?.();
  releaseRestartHold = null;
}

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
        title: i18next.t('download.completeTitle'),
        body: i18next.t('download.completeBody'),
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
        title: i18next.t('download.failedTitle'),
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

  const generation = ++downloadGeneration;
  const isCurrent = () => generation === downloadGeneration;
  releaseDownloadHold();
  releaseRestartHold = holdRestart('model-download');

  downloadPromise = (async () => {
    const canNotify = await hasNotificationPermission();

    try {
      await downloadBaseModel(config, (info: DownloadProgressInfo) => {
        const pct = Math.min(Math.round(info.progress), 99);
        const mbDown = (info.bytesWritten / (1024 * 1024)).toFixed(1);
        const mbTotal = (info.contentLength / (1024 * 1024)).toFixed(0);
        logger.info(`[DownloadService] ${mbDown} MB / ${mbTotal} MB (${pct}%)`);
        if (isCurrent()) useMeraProtocolStore.getState().setDownloadProgress(pct);
      });

      if (!isCurrent()) return;
      useMeraProtocolStore.getState().setModelState('downloaded');
      useMeraProtocolStore.getState().setDownloadProgress(100);
      if (canNotify) await showCompletionNotification();
    } catch (error) {
      // Cancelled (or superseded): the cancel already set the state. Not a failure.
      if (!isCurrent()) return;
      const message =
        error instanceof Error ? error.message : 'Download failed';
      logger.captureException(error, { tags: { source: 'DownloadService', method: 'startModelDownload' } });
      useMeraProtocolStore.getState().setModelError(message);
      if (canNotify) await showErrorNotification(message);
    } finally {
      if (isCurrent()) {
        downloadPromise = null;
        releaseDownloadHold();
      }
    }
  })();
}

/** Cancels the active download. */
export async function cancelModelDownload(): Promise<void> {
  downloadGeneration++;
  releaseDownloadHold();
  cancelActiveDownload();
  downloadPromise = null;
  useMeraProtocolStore.getState().setModelState('not_downloaded');
  useMeraProtocolStore.getState().setDownloadProgress(0);
}
