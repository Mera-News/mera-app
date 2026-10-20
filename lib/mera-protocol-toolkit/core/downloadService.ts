// Download Service: fetches on-device model files, one model at a time, in a
// serial queue. The screen shows one row per model ("Mera relevance model",
// "Mera text model"), each with its own download, progress, cancel and retry.
//
// The download state lives HERE, per model, apart from the store's runtime
// `modelState`: a phone can already run (relevance model plus a built-in text
// model) while the text model downloads, and a download writing `modelState`
// would stop the inference queue and make a load failure read as a download
// failure. The whole queue runs under ONE `model-download` restart hold.
//
// After EACH model lands the phone is promoted to OnDevice when On this phone
// can now run (isModelDownloaded()) and the reader asked for on-device
// processing, here in the download path, so it happens even when the settings
// screen is no longer open.

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
import { getTextEngine, isBuiltInEngine, type BuiltInEngine } from './text-engine';

/** The built-in text models by name. Proper nouns, never translated; the only model names the UI shows. */
export const BUILT_IN_MODEL_NAME: Readonly<Record<BuiltInEngine, string>> = {
  afm: 'Apple Intelligence',
  nano: 'Gemini Nano',
};

// ---------------------------------------------------------------------------
// Per-model download state
// ---------------------------------------------------------------------------

/** One model's download. A model with no entry is idle: on disk or not, nothing is happening to it. */
export type ModelDownload = {
  status: 'queued' | 'downloading' | 'failed';
  doneBytes: number;
  totalBytes: number;
  /** Set when failed. */
  failure: DownloadFailureKind | null;
};

let downloads: Readonly<Record<string, ModelDownload>> = {};
const listeners = new Set<() => void>();

/** Model ids waiting their turn, in order. The running one is not in here. */
let queue: string[] = [];
let activeId: string | null = null;
// The current queue runner. Bumped to DETACH a runner (cancelling the model it is
// on): the cancelled native task rejects a moment later, and a detached runner
// then changes nothing, so it can neither fail the cancel nor touch a queue that
// a new runner has taken over.
let run = 0;
let running = false;
// Bytes of models that landed in this run, so the queue's overall progress
// ("Downloading 1.2 of 5.7 GB" in the banner) does not jump back when one lands.
let landedBytes = 0;

// The download runs in a native background URLSession, which a JS reload does
// not stop: a reloaded app would forget it while the file is still being
// written. The restart is held for the whole queue, as a purchase or a streaming
// chat holds it. A blocked restart is deferred, never lost.
let releaseRestartHold: (() => void) | null = null;

// Whether to switch the phone to OnDevice when a landing makes it runnable. Set
// from the reader's on-device intent; the screen clears it when the reader picks
// Private cloud mid-download.
let promoteWhenDone = false;

function releaseDownloadHold(): void {
  releaseRestartHold?.();
  releaseRestartHold = null;
}

export type DownloadBytes = { doneBytes: number; totalBytes: number };

const IDLE_BYTES: DownloadBytes = { doneBytes: 0, totalBytes: 0 };
let bytes: DownloadBytes = IDLE_BYTES;

function totals(): DownloadBytes {
  let done = landedBytes;
  let total = landedBytes;
  for (const d of Object.values(downloads)) {
    if (d.status === 'failed') continue;
    done += d.doneBytes;
    total += d.totalBytes;
  }
  return total === 0 ? IDLE_BYTES : { doneBytes: done, totalBytes: total };
}

function emit(): void {
  bytes = totals();
  // Observability and the Sentry scope read the overall percent from the store.
  const pct = bytes.totalBytes > 0 ? Math.min(99, Math.round((bytes.doneBytes / bytes.totalBytes) * 100)) : 0;
  useMeraProtocolStore.getState().setDownloadProgress(pct);
  listeners.forEach((l) => l());
}

function setEntry(modelId: string, entry: ModelDownload | null): void {
  const next = { ...downloads };
  if (entry) next[modelId] = entry;
  else delete next[modelId];
  downloads = next;
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Every model with a download queued, running or failed, by model id. */
export function getModelDownloads(): Readonly<Record<string, ModelDownload>> {
  return downloads;
}

export function useModelDownloads(): Readonly<Record<string, ModelDownload>> {
  return useSyncExternalStore(subscribe, getModelDownloads, getModelDownloads);
}

/** The queue's overall progress, landed models included; zero when nothing downloads. */
export function getDownloadBytes(): DownloadBytes {
  return bytes;
}

export function useDownloadBytes(): DownloadBytes {
  return useSyncExternalStore(subscribe, getDownloadBytes, getDownloadBytes);
}

/**
 * What the screen shows: for each catalogue model, whether it is on disk and its
 * size, and whether On this phone can run now with the chosen text option.
 */
export async function onDeviceModelsStatus(): Promise<{
  models: Record<string, { onDisk: boolean; sizeBytes: number }>;
  runnable: boolean;
}> {
  const models: Record<string, { onDisk: boolean; sizeBytes: number }> = {};
  for (const m of MODEL_CATALOG) {
    models[m.modelId] = { onDisk: await isModelDownloaded(m.modelId).catch(() => false), sizeBytes: m.sizeBytes };
  }
  return { models, runnable: await isModelDownloaded().catch(() => false) };
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

/**
 * One notification per model (`<kind>:<modelId>`), so the second model's never
 * replaces the first's. The title says Beta in words: a notification cannot
 * draw the badge.
 */
async function notify(
  kind: string,
  modelId: string,
  titleKey: 'download.failedTitle' | 'download.completeTitle',
  body: string,
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: `${kind}:${modelId}`,
      content: {
        title: i18next.t('download.betaTitle', { title: i18next.t(titleKey) }),
        body,
        data: { type: kind },
      },
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
 * Writes the on-device intent to the server persona and the cached copy, and
 * leaves the local mode alone (D6 split state). The boot purge reads the cached
 * copy, so files a promoting download fetched survive a restart even while On
 * this phone cannot run yet, and restoreOnDeviceIfRunnable finishes the switch
 * once it can. Lazy requires: this module is in the toolkit barrel, and
 * AccountService must not enter the graph of every completeLocal importer.
 * Returns false and changes nothing locally when the server write fails, or
 * when `stillWanted` says the reader withdrew the intent while it was in flight
 * (their Private cloud pick wrote Cloud and the cache must keep it).
 */
async function writeOnDeviceIntent(stillWanted: () => boolean = () => true): Promise<boolean> {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { resolveCurrentUserId } =
      require('../../security/current-user') as typeof import('../../security/current-user');
    const { AccountService } = require('../../account-service') as typeof import('../../account-service');
    const { useUserStore } = require('../../stores/user-store') as typeof import('../../stores/user-store');
    /* eslint-enable @typescript-eslint/no-require-imports */
    await AccountService.updateProcessingMode(await resolveCurrentUserId(), ProcessingMode.OnDevice);
    if (!stillWanted()) return false;
    const persona = useUserStore.getState().userPersona;
    if (persona) useUserStore.getState().setUserPersona({ ...persona, processingMode: ProcessingMode.OnDevice });
    return true;
  } catch (err) {
    logger.warn('[DownloadService] saving the on-device intent failed', { error: String(err) });
    return false;
  }
}

/** A download that will promote saves the intent up front, so a kill partway keeps the files (D5). */
function saveIntentForDownload(): void {
  void writeOnDeviceIntent(() => promoteWhenDone);
}

/**
 * Switches processing to OnDevice: the server persona and its cached copy first,
 * then the store. Returns false and changes nothing locally when the server
 * write fails.
 */
export async function promoteToOnDevice(): Promise<boolean> {
  if (!(await writeOnDeviceIntent())) return false;
  useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);
  return true;
}

/**
 * Undoes a local Private cloud fallback once On this phone can run again (Apple
 * Intelligence finished getting ready, say), without the settings screen. For the
 * app's foreground handler. Acts only when the phone is on Cloud locally, the
 * phone is runnable and the cached persona says OnDevice; the server persona then
 * confirms the intent, since a Private cloud pick does not rewrite the cached
 * copy. Sends no mutation: the server already says OnDevice. Returns whether the
 * phone moved to OnDevice.
 */
export async function restoreOnDeviceIfRunnable(): Promise<boolean> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { useUserStore } = require('../../stores/user-store') as typeof import('../../stores/user-store');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const cached = useUserStore.getState().userPersona;
  if (cached?.processingMode !== ProcessingMode.OnDevice) return false;
  if (useMeraProtocolStore.getState().processingMode !== ProcessingMode.Cloud) return false;
  // Not gated on a running download: with the text model a separate download, a
  // phone can already run on the built-in model while the text model downloads.
  if (!(await isModelDownloaded().catch(() => false))) return false;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { resolveCurrentUserId } =
      require('../../security/current-user') as typeof import('../../security/current-user');
    const { AccountService } = require('../../account-service') as typeof import('../../account-service');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const persona = await AccountService.getUserPersona(await resolveCurrentUserId());
    if (!persona) return false;
    useUserStore.getState().setUserPersona(persona);
    // Re-checked after the awaits: the reader may have switched meanwhile.
    const store = useMeraProtocolStore.getState();
    if (persona.processingMode !== ProcessingMode.OnDevice || store.processingMode !== ProcessingMode.Cloud) {
      return false;
    }
    store.setProcessingMode(ProcessingMode.OnDevice);
    return true;
  } catch {
    // Offline or signed out: stay on Cloud; the next foreground tries again.
    return false;
  }
}

/** The screen keeps this in step with the reader's on-device intent. */
export function setPromoteWhenDone(value: boolean): void {
  const turnedOn = value && !promoteWhenDone;
  promoteWhenDone = value;
  // A mid-download pick of On this phone sends no write of its own while it cannot run yet.
  if (turnedOn && running) saveIntentForDownload();
}

/** Whether a running download will switch the phone to OnDevice when it lands. */
export function willPromoteWhenDone(): boolean {
  return running && promoteWhenDone;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns true while any model downloads or waits to. */
export function isDownloadInProgress(): boolean {
  return running;
}

const catalogEntry = (modelId: string): ModelCatalogEntry | undefined =>
  MODEL_CATALOG.find((m) => m.modelId === modelId);

/**
 * Queues model downloads; they run one after the other. `modelIds`: which models
 * (default: what the chosen text engine still needs). A model already queued or
 * downloading is not queued twice; a failed one is queued again (Try again).
 * `promote`: switch the phone to OnDevice once a landing makes it runnable (the
 * reader's on-device intent); while a queue runs, the latest start sets it.
 */
export function startModelDownloads(opts: { modelIds?: string[]; promote?: boolean } = {}): void {
  const wasPromoting = running && promoteWhenDone;
  promoteWhenDone = opts.promote ?? (running ? promoteWhenDone : false);
  if (opts.modelIds) {
    if (addToQueue(opts.modelIds)) startRunner(false);
  } else if (!running) {
    startRunner(true);
  } else {
    void missingModels()
      .catch(() => [] as ModelCatalogEntry[])
      .then((missing) => {
        if (addToQueue(missing.map((m) => m.modelId))) startRunner(false);
      });
  }
  if (promoteWhenDone && !wasPromoting && running) saveIntentForDownload();
}

/** Queues what is not queued or running yet. Returns whether anything was added. */
function addToQueue(modelIds: string[]): boolean {
  let added = false;
  for (const id of modelIds) {
    const model = catalogEntry(id);
    if (!model || id === activeId || queue.includes(id)) continue;
    queue.push(id);
    setEntry(id, { status: 'queued', doneBytes: 0, totalBytes: model.sizeBytes, failure: null });
    added = true;
  }
  return added;
}

/** Starts a runner unless one runs. `resolveMissing`: first queue what the chosen engine still needs. */
function startRunner(resolveMissing: boolean): void {
  if (running) return;
  running = true;
  const myRun = ++run;
  releaseDownloadHold();
  releaseRestartHold = holdRestart('model-download');
  void runQueue(myRun, resolveMissing);
}

async function runQueue(myRun: number, resolveMissing: boolean): Promise<void> {
  const isCurrent = () => myRun === run;
  try {
    const canNotify = await hasNotificationPermission();
    if (resolveMissing) {
      const missing = await missingModels().catch(() => [] as ModelCatalogEntry[]);
      if (!isCurrent()) return;
      addToQueue(missing.map((m) => m.modelId));
    }
    while (isCurrent() && queue.length > 0) {
      const id = queue.shift() as string;
      const model = catalogEntry(id) as ModelCatalogEntry;
      activeId = id;
      const entry = (doneBytes: number): ModelDownload => ({
        status: 'downloading',
        doneBytes,
        totalBytes: model.sizeBytes,
        failure: null,
      });
      setEntry(id, entry(0));
      try {
        await downloadBaseModel(
          { modelId: model.modelId, modelUrl: model.modelUrl, sizeBytes: model.sizeBytes },
          (info: DownloadProgressInfo) => {
            if (isCurrent() && activeId === id) setEntry(id, entry(Math.min(info.bytesWritten, model.sizeBytes)));
          },
        );
      } catch (error) {
        // Cancelled (or superseded): the cancel already cleared the state. Not a failure.
        if (!isCurrent()) return;
        activeId = null;
        const message = error instanceof Error ? error.message : 'Download failed';
        logger.captureException(error, {
          tags: { source: 'DownloadService', method: 'startModelDownloads' },
          extra: { modelId: id },
        });
        setEntry(id, { status: 'failed', doneBytes: 0, totalBytes: model.sizeBytes, failure: downloadFailureKind(message) });
        if (canNotify) await notify('model-download-error', id, 'download.failedTitle', downloadFailureBody(message));
        continue;
      }
      if (!isCurrent()) return;
      activeId = null;
      landedBytes += model.sizeBytes;
      setEntry(id, null);
      await afterModelLanded(model, canNotify, isCurrent);
    }
  } finally {
    if (isCurrent()) {
      running = false;
      activeId = null;
      landedBytes = 0;
      emit();
      releaseDownloadHold();
    }
  }
}

/**
 * After each model lands: promote when the phone can now run and the reader wants
 * On this phone, so the relevance model landing with a ready built-in model
 * promotes on its own. Then one notification for this model.
 */
async function afterModelLanded(
  model: ModelCatalogEntry,
  canNotify: boolean,
  isCurrent: () => boolean,
): Promise<void> {
  const runnable = await isModelDownloaded().catch(() => false);
  const shouldPromote =
    promoteWhenDone && runnable && useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice;
  const promoted = shouldPromote ? await promoteToOnDevice() : false;
  const last = queue.length === 0;
  // The last landing and it cannot run yet: the intent stays saved (again, in case
  // the write at the start failed) so the boot purge keeps the files and the next
  // foreground promotes once it can run.
  if (promoteWhenDone && !runnable && last) await writeOnDeviceIntent(() => promoteWhenDone);
  if (!canNotify || !isCurrent()) return;
  let body = i18next.t(model.role === 'relevance' ? 'download.relevanceDone' : 'download.textDone');
  if (promoted) {
    body = i18next.t('download.onDeviceReady');
  } else if (promoteWhenDone && !runnable && last) {
    // Everything is on disk and it still cannot run: the built-in model is not ready. Never say "ready".
    const engine = await getTextEngine();
    if (isBuiltInEngine(engine) && (await missingModels()).length === 0) {
      body = i18next.t('meraProtocol.modelsWaitingNative', { name: BUILT_IN_MODEL_NAME[engine] });
    }
  }
  await notify('model-download-complete', model.modelId, 'download.completeTitle', body);
}

/**
 * Cancels one model's download (or its place in the queue, or dismisses its
 * failure); with no id, every download. Files already finished stay on disk.
 */
export async function cancelModelDownload(modelId?: string): Promise<void> {
  if (modelId === undefined) {
    run++;
    cancelActiveDownload();
    queue = [];
    activeId = null;
    running = false;
    landedBytes = 0;
    downloads = {};
    emit();
    releaseDownloadHold();
    return;
  }
  if (modelId === activeId) {
    // Detach this runner; a new one takes over whatever is still queued.
    run++;
    cancelActiveDownload();
    activeId = null;
    running = false;
    setEntry(modelId, null);
    if (queue.length > 0) {
      startRunner(false);
    } else {
      landedBytes = 0;
      emit();
      releaseDownloadHold();
    }
    return;
  }
  queue = queue.filter((id) => id !== modelId);
  if (downloads[modelId]) setEntry(modelId, null);
}
