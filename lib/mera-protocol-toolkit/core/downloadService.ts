// Download Service: fetches the model files the chosen text engine needs that
// are not on disk yet (the relevance model always; the text model unless the
// native engine writes text). User-facing, this is ONE download, "Mera AI
// models": nothing here exposes a model name or a per-model size for display.
//
// SEQUENTIAL (text model, then Kev), under ONE download generation and ONE
// `model-download` restart hold for the whole set. Progress is byte-weighted
// over what is missing. A retry fetches only what is still missing. When the set
// lands, On this phone can run (isModelDownloaded()), and the reader asked for
// on-device processing, the phone is promoted to OnDevice here, from the
// download path, so it happens even when the settings screen is no longer open.

import { useSyncExternalStore } from 'react';
import * as Notifications from 'expo-notifications';
import i18next from 'i18next';
import { holdRestart } from '../../app-restart';
import logger from '../../logger';
import { ProcessingMode } from '../../generated/graphql-types';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { MODEL_CATALOG, type ModelCatalogEntry } from './model-catalog';
import {
  cancelActiveDownload,
  downloadBaseModel,
  isModelDownloaded,
  requiredModels,
  type DownloadProgressInfo,
} from './modelManager';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let downloadPromise: Promise<void> | null = null;

// Bumped by every start AND every cancel. A download settles only while it is
// still the current generation: cancelling makes the native task reject a moment
// later, and without this that rejection overwrote the cancel's clean
// `not_downloaded` with an error state plus a "Download Failed" notification,
// and its `finally` could clear the handle of a download started right after.
let downloadGeneration = 0;

// The download runs in a native background URLSession, which a JS reload does
// not stop: a reloaded app would forget it while the file is still being
// written. The restart is held for the whole pair, as a purchase or a streaming
// chat holds it. A blocked restart is deferred, never lost.
let releaseRestartHold: (() => void) | null = null;

// Whether to switch the phone to OnDevice when the pair lands. Set by the
// screen from the reader's on-device intent; the screen clears it when the
// reader picks Private cloud mid-download.
let promoteWhenDone = false;

function releaseDownloadHold(): void {
  releaseRestartHold?.();
  releaseRestartHold = null;
}

// ---------------------------------------------------------------------------
// Byte progress, for "Downloading 1.2 of 5.8 GB"
// ---------------------------------------------------------------------------

export type DownloadBytes = { doneBytes: number; totalBytes: number };

const IDLE_BYTES: DownloadBytes = { doneBytes: 0, totalBytes: 0 };
let bytes: DownloadBytes = IDLE_BYTES;
const bytesListeners = new Set<() => void>();

function setBytes(next: DownloadBytes): void {
  bytes = next;
  bytesListeners.forEach((l) => l());
}

export function getDownloadBytes(): DownloadBytes {
  return bytes;
}

export function useDownloadBytes(): DownloadBytes {
  return useSyncExternalStore(
    (l) => {
      bytesListeners.add(l);
      return () => {
        bytesListeners.delete(l);
      };
    },
    getDownloadBytes,
    getDownloadBytes,
  );
}

/**
 * What the screen shows, name-free: the bytes still to download for the chosen
 * text engine, the bytes of model files on disk (any, for the delete confirm),
 * and whether On this phone can run now.
 */
export async function onDeviceModelsStatus(): Promise<{
  missingBytes: number;
  onDiskBytes: number;
  runnable: boolean;
}> {
  const missing = await missingModels();
  let onDiskBytes = 0;
  for (const m of MODEL_CATALOG) {
    if (await isModelDownloaded(m.modelId).catch(() => false)) onDiskBytes += m.sizeBytes;
  }
  return {
    missingBytes: missing.reduce((sum, m) => sum + m.sizeBytes, 0),
    onDiskBytes,
    runnable: await isModelDownloaded().catch(() => false),
  };
}

/** The models the chosen text engine needs that are not on disk yet, in download order. */
export async function missingModels(): Promise<ModelCatalogEntry[]> {
  const missing: ModelCatalogEntry[] = [];
  for (const m of await requiredModels()) {
    if (!(await isModelDownloaded(m.modelId).catch(() => false))) missing.push(m);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Failure wording and notifications
// ---------------------------------------------------------------------------

export type DownloadFailureKind = 'space' | 'damaged' | 'server' | 'connection';

/**
 * What went wrong, from modelManager's English developer message. The raw
 * message stays in the logs and the store; the reader only ever sees words for
 * the kind.
 */
export function downloadFailureKind(message: string): DownloadFailureKind {
  if (/no space|enospc|disk full|not enough space/i.test(message)) return 'space';
  if (/damaged|checksum/i.test(message)) return 'damaged';
  if (/HTTP status/i.test(message)) return 'server';
  return 'connection';
}

const FAILURE_BODY_KEY = {
  space: 'download.failedSpace',
  damaged: 'download.failedDamaged',
  server: 'download.failedServer',
  connection: 'download.failedConnection',
} as const satisfies Record<DownloadFailureKind, string>;

/** The failure in words the reader can act on, never the raw message. */
export function downloadFailureBody(message: string): string {
  return i18next.t(FAILURE_BODY_KEY[downloadFailureKind(message)]);
}

async function hasNotificationPermission(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

async function notify(identifier: string, title: string, body: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: { title, body, data: { type: identifier } },
      trigger: null,
    });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Promotion to OnDevice
// ---------------------------------------------------------------------------

/**
 * Switches processing to OnDevice: the server persona first, then the store.
 * Returns false and changes nothing when the server write fails. Lazy requires:
 * this module is in the toolkit barrel, and AccountService must not enter the
 * graph of every completeLocal importer.
 */
export async function promoteToOnDevice(): Promise<boolean> {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { resolveCurrentUserId } =
      require('../../security/current-user') as typeof import('../../security/current-user');
    const { AccountService } = require('../../account-service') as typeof import('../../account-service');
    const { useUserStore } = require('../../stores/user-store') as typeof import('../../stores/user-store');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const userId = await resolveCurrentUserId();
    await AccountService.updateProcessingMode(userId, ProcessingMode.OnDevice);
    useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);
    // The cached persona carries the intent the boot purge reads: keep it in step
    // so a later local Cloud fallback never loses the files.
    const persona = useUserStore.getState().userPersona;
    if (persona) useUserStore.getState().setUserPersona({ ...persona, processingMode: ProcessingMode.OnDevice });
    return true;
  } catch (err) {
    logger.warn('[DownloadService] promotion to on-device failed', { error: String(err) });
    return false;
  }
}

/** The screen keeps this in step with the reader's on-device intent. */
export function setPromoteWhenDone(value: boolean): void {
  promoteWhenDone = value;
}

/** Whether a running download will switch the phone to OnDevice when it lands. */
export function willPromoteWhenDone(): boolean {
  return downloadPromise !== null && promoteWhenDone;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns true if a download is currently in progress. */
export function isDownloadInProgress(): boolean {
  return downloadPromise !== null;
}

/**
 * Downloads every on-device model not on disk yet, one after the other. Does
 * nothing while a download runs. `promote`: switch the phone to OnDevice once
 * both files are on disk (the reader's on-device intent).
 */
export function startModelDownloads(opts: { promote?: boolean } = {}): void {
  if (downloadPromise) return;
  promoteWhenDone = opts.promote ?? false;

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
      const missing = await missingModels();
      const totalBytes = missing.reduce((sum, m) => sum + m.sizeBytes, 0);
      let doneBefore = 0;
      if (isCurrent()) setBytes({ doneBytes: 0, totalBytes });

      for (const model of missing) {
        if (!isCurrent()) return;
        await downloadBaseModel(
          { modelId: model.modelId, modelUrl: model.modelUrl, sizeBytes: model.sizeBytes },
          (info: DownloadProgressInfo) => {
            if (!isCurrent()) return;
            const done = doneBefore + Math.min(info.bytesWritten, model.sizeBytes);
            setBytes({ doneBytes: done, totalBytes });
            const pct = totalBytes > 0 ? (done / totalBytes) * 100 : 0;
            useMeraProtocolStore.getState().setDownloadProgress(Math.min(Math.round(pct), 99));
          },
        );
        doneBefore += model.sizeBytes;
        if (isCurrent()) setBytes({ doneBytes: doneBefore, totalBytes });
      }

      if (!isCurrent()) return;
      useMeraProtocolStore.getState().setModelState('downloaded');
      useMeraProtocolStore.getState().setDownloadProgress(100);

      const shouldPromote =
        promoteWhenDone &&
        useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice &&
        (await isModelDownloaded().catch(() => false));
      const promoted = shouldPromote ? await promoteToOnDevice() : false;
      if (canNotify && isCurrent()) {
        await notify(
          'model-download-complete',
          i18next.t('download.completeTitle'),
          i18next.t(promoted ? 'download.onDeviceReady' : 'download.completeBody'),
        );
      }
    } catch (error) {
      // Cancelled (or superseded): the cancel already set the state. Not a failure.
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : 'Download failed';
      logger.captureException(error, { tags: { source: 'DownloadService', method: 'startModelDownloads' } });
      useMeraProtocolStore.getState().setModelError(message);
      if (canNotify) {
        await notify('model-download-error', i18next.t('download.failedTitle'), downloadFailureBody(message));
      }
    } finally {
      if (isCurrent()) {
        downloadPromise = null;
        setBytes(IDLE_BYTES);
        releaseDownloadHold();
      }
    }
  })();
}

/** Cancels the running download. Files already finished stay on disk. */
export async function cancelModelDownload(): Promise<void> {
  downloadGeneration++;
  releaseDownloadHold();
  cancelActiveDownload();
  downloadPromise = null;
  setBytes(IDLE_BYTES);
  useMeraProtocolStore.getState().setModelState('not_downloaded');
  useMeraProtocolStore.getState().setDownloadProgress(0);
}
