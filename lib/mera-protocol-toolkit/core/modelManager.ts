// Model Manager: on-device model files (download, manifest, delete) and the ONE
// resident llama.rn context.
//
// On this phone runs two models (model-catalog.ts) and holds at most one in
// memory. The resident one is swapped on demand inside the llama lock: infer /
// inferStream need the TEXT model, decide needs the RELEVANCE model, and each
// calls `_ensureLoaded` while holding the lock. A swap releases the old context
// before loading the new one and never writes the UI modelState; only the public
// `initBaseModel` does.

import { Directory, File, Paths } from 'expo-file-system';
import * as RNFS from '@dr.pogodin/react-native-fs';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import {
  addNativeLogListener,
  initLlama,
  loadLlamaModelInfo,
  toggleNativeLog,
  type LlamaContext,
} from 'llama.rn';

import logger from '../../logger';
import { ProcessingMode } from '../../generated/graphql-types';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { LOCAL_CONTEXT_TOKENS } from './context-size';
import { holdRestart } from '../../app-restart';
import { recordModelLoad } from './inference-stats';
import { withLlamaLock } from './llama-lock';
import { MODEL_CATALOG, RELEVANCE_MODEL, TEXT_MODEL } from './model-catalog';
import type {
  BaseModelDownloadConfig,
  BaseModelManifest,
  ModelState,
} from '../types';

// ---------------------------------------------------------------------------
// Progress callback type
// ---------------------------------------------------------------------------

export type DownloadProgressInfo = {
  bytesWritten: number;
  contentLength: number;
  progress: number; // 0-100
};

/** Thrown when a load is asked for while processing is not set to on-device. */
export class LocalModelsOffError extends Error {
  constructor(message = 'On-device models are off while processing is set to cloud') {
    super(message);
    this.name = 'LocalModelsOffError';
  }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let llamaContext: LlamaContext | null = null;
let currentModelState: ModelState | null = null;
let activeDownload: LegacyFileSystem.DownloadResumable | null = null;

const MODELS_DIR_NAME = 'mera-models';
const MANIFEST_FILE_NAME = 'manifest.json';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getModelDir(modelId: string): Directory {
  return new Directory(Paths.cache, MODELS_DIR_NAME, modelId);
}

function getModelFile(modelId: string): File {
  return new File(Paths.cache, MODELS_DIR_NAME, modelId, 'model.gguf');
}

function getManifestFile(modelId: string): File {
  return new File(Paths.cache, MODELS_DIR_NAME, modelId, MANIFEST_FILE_NAME);
}

async function readManifest(modelId: string): Promise<BaseModelManifest | null> {
  const file = getManifestFile(modelId);
  if (!file.exists) return null;
  const text = await file.text();
  return JSON.parse(text) as BaseModelManifest;
}

async function writeManifest(manifest: BaseModelManifest): Promise<void> {
  const file = getManifestFile(manifest.modelId);
  await file.write(JSON.stringify(manifest));
}

/** The first four bytes of a GGUF file are the ASCII magic `GGUF`. */
function hasGgufMagic(file: File): boolean {
  const handle = file.open();
  try {
    const head = handle.readBytes(4);
    return String.fromCharCode(...Array.from(head)) === 'GGUF';
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Downloads one model file in an iOS background URLSession (expo-file-system),
 * so it survives backgrounding, then checks it before writing the manifest: the
 * size must equal `config.sizeBytes` and the file must start with `GGUF`.
 * A file that fails either check is deleted and the error says "damaged".
 */
export async function downloadBaseModel(
  config: BaseModelDownloadConfig,
  onProgress?: (info: DownloadProgressInfo) => void,
): Promise<BaseModelManifest> {
  const modelDir = getModelDir(config.modelId);
  if (!modelDir.exists) {
    await modelDir.create({ intermediates: true });
  }

  const modelFile = getModelFile(config.modelId);
  logger.info('[ModelManager] Starting download', { modelUrl: config.modelUrl });

  // Native sends an event per write; only whole-percent changes reach JS state.
  let lastWholePercent = -1;
  const resumable = LegacyFileSystem.createDownloadResumable(
    config.modelUrl,
    modelFile.uri,
    { sessionType: LegacyFileSystem.FileSystemSessionType.BACKGROUND },
    (p) => {
      if (p.totalBytesExpectedToWrite <= 0) return;
      const pct = (p.totalBytesWritten / p.totalBytesExpectedToWrite) * 100;
      const whole = Math.floor(pct);
      if (whole === lastWholePercent) return;
      lastWholePercent = whole;
      onProgress?.({
        bytesWritten: p.totalBytesWritten,
        contentLength: p.totalBytesExpectedToWrite,
        progress: pct,
      });
    },
  );
  activeDownload = resumable;

  try {
    const result = await resumable.downloadAsync();
    if (!result) {
      // downloadAsync resolves undefined when the task was cancelled.
      throw new Error('Download has been aborted');
    }
    logger.info('[ModelManager] Download finished', { status: result.status });
    if (result.status !== 200) {
      if (modelFile.exists) modelFile.delete();
      throw new Error(`Download failed with HTTP status ${result.status}`);
    }
  } finally {
    if (activeDownload === resumable) activeDownload = null;
  }

  const info = await modelFile.info();
  const sizeBytes = info.size ?? 0;
  if (sizeBytes !== config.sizeBytes) {
    if (modelFile.exists) modelFile.delete();
    throw new Error(`Damaged download: size ${sizeBytes}, expected ${config.sizeBytes}`);
  }
  if (!hasGgufMagic(modelFile)) {
    if (modelFile.exists) modelFile.delete();
    throw new Error('Damaged download: the file is not a GGUF');
  }

  const manifest: BaseModelManifest = {
    modelId: config.modelId,
    version: '1.0.0',
    sizeBytes,
    quantization: 'Q4_K_M',
    downloadedAt: new Date().toISOString(),
    ready: true,
  };

  await writeManifest(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Load / release: UNLOCKED internals. Call only while holding the llama lock.
// ---------------------------------------------------------------------------

/** Releases the resident context, if any. Unlocked: the caller holds the lock. */
export async function _releaseModel(): Promise<void> {
  const context = llamaContext;
  llamaContext = null;
  currentModelState = null;
  if (context) await context.release();
}

function initParamsFor(modelId: string, uri: string) {
  const isRelevance = modelId === RELEVANCE_MODEL.modelId;
  return {
    model: uri,
    n_ctx: LOCAL_CONTEXT_TOKENS,
    n_gpu_layers: 999, // Offload all layers to Metal
    n_threads: 4, // A-series: 2P + 4E cores; 4 threads avoids stalling on slow E-cores
    // Off for both models: two ~3 GB models are swapped in and out, and wired
    // (mlocked) pages count in full against iOS's per-app memory limit. mmap
    // lets iOS page weights in and out instead of killing the app.
    use_mlock: false,
    use_mmap: true,
    // `decide()` evaluates the read part of its prompt in one batch, and Kev
    // reads every option's hidden state; give it the whole context as one batch.
    n_batch: isRelevance ? LOCAL_CONTEXT_TOKENS : 512,
    flash_attn_type: 'on' as const,
    // f16 KV. Both models are Qwen3.5 hybrids with only a few full-attention
    // layers, so the KV cache is small at this n_ctx even in f16. For the text
    // model, llama.rn's prompt-state cache for hybrid models is on by default
    // (160 MiB, 8 checkpoints), so a run of note calls sharing system prompt +
    // facts re-prefills only each article's block. `decide()` gets no such
    // reuse: a hybrid's recurrent state cannot be rolled back, so every Kev call
    // evaluates its whole prompt.
    cache_type_k: 'f16' as const,
    cache_type_v: 'f16' as const,
    // No `embedding` / `pooling_type`: llama.rn puts Kev in embedding mode
    // itself, from the decision type the model declares.
  };
}

/** Loads `modelId`, releasing whatever is resident first. Unlocked. */
async function loadModel(
  modelId: string,
  onProgress?: (progress: number) => void,
): Promise<ModelState> {
  const modelFile = getModelFile(modelId);
  if (!modelFile.exists) {
    throw new Error(`Model ${modelId} not found on disk. Download it first.`);
  }

  // Never two contexts at once: the old one is gone before the new one loads.
  await _releaseModel();

  // llama.rn surfaces only a generic "Failed to load model" string from JS, but
  // llama.cpp prints the real reason to stderr. Buffer the most recent native
  // lines so a failure can dump them.
  const nativeLogBuffer: string[] = [];
  const nativeLogSub = addNativeLogListener((level, text) => {
    nativeLogBuffer.push(`[${level}] ${text}`);
    if (nativeLogBuffer.length > 200) nativeLogBuffer.shift();
  });
  try {
    await toggleNativeLog(true);
  } catch (logErr) {
    logger.warn('[ModelManager] toggleNativeLog(true) failed', { error: String(logErr) });
  }

  // Pre-load diagnostics: path, size and the first bytes tell a junk file
  // (HTML, LFS pointer) from a valid GGUF that fails for runtime reasons.
  const diskPath = `${RNFS.CachesDirectoryPath}/${MODELS_DIR_NAME}/${modelId}/model.gguf`;
  let fileSizeBytes = -1;
  let headAscii = 'unread';
  try {
    const info = await modelFile.info();
    fileSizeBytes = info.size ?? -1;
  } catch (infoErr) {
    logger.warn('[ModelManager] modelFile.info() failed', { error: String(infoErr) });
  }
  try {
    const headB64 = await RNFS.read(diskPath, 16, 0, 'base64');
    const headBytes = Uint8Array.from(atob(headB64), (c) => c.charCodeAt(0));
    headAscii = Array.from(headBytes)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
      .join('');
  } catch (readErr) {
    logger.warn('[ModelManager] failed to read first bytes of model file', { error: String(readErr) });
  }
  logger.info('[ModelManager] Pre-initLlama diagnostics', { modelId, diskPath, fileSizeBytes, headAscii });

  try {
    await loadLlamaModelInfo(modelFile.uri);
  } catch (infoErr) {
    logger.error('[ModelManager] loadLlamaModelInfo failed: file is not a parseable GGUF', {
      error: String(infoErr),
    });
  }

  const initParams = initParamsFor(modelId, modelFile.uri);
  logger.info('[ModelManager] Calling initLlama with params', initParams);

  let context: LlamaContext;
  const loadStartedAt = Date.now();
  // Loading runs for seconds in native code; a JS reload under it hands native
  // callbacks a torn-down runtime.
  const releaseRestartHold = holdRestart('model-load');
  try {
    context = await initLlama(initParams, onProgress ? (p) => onProgress(p) : undefined);
  } catch (initErr) {
    const e = initErr as Error & { code?: string | number };
    logger.error('[ModelManager] initLlama threw', {
      message: e?.message,
      code: e?.code,
      fileSizeBytes,
      headAscii,
      initParams,
      nativeLogTail: nativeLogBuffer.slice(-50),
    });
    throw initErr;
  } finally {
    releaseRestartHold();
    nativeLogSub.remove();
    toggleNativeLog(false).catch(() => {});
  }

  if (modelId === RELEVANCE_MODEL.modelId && context.model?.decision?.type !== 'kev') {
    const decision = context.model?.decision;
    await context.release().catch(() => {});
    throw new Error(
      `Model ${modelId} is not a Kev decision model (decision type: ${decision?.type ?? 'none'}${decision?.error ? `, ${decision.error}` : ''})`,
    );
  }

  llamaContext = context;
  recordModelLoad(modelId === RELEVANCE_MODEL.modelId ? 'relevance' : 'text', Date.now() - loadStartedAt);

  currentModelState = {
    modelId,
    loaded: true,
    contextWindow: LOCAL_CONTEXT_TOKENS,
    memoryUsageMB: Math.round((context.model?.size ?? 0) / (1024 * 1024)),
    backend: context.gpu ? 'metal' : 'cpu',
    inferenceSpeed: 0,
  };
  logger.info(
    `[ModelManager] Model loaded: ${modelId} | backend: ${currentModelState.backend} | memory: ${currentModelState.memoryUsageMB}MB`,
  );
  return currentModelState;
}

/**
 * Makes `modelId` the resident model, swapping if another one is loaded.
 * Unlocked: call only while holding the llama lock. Refuses outside on-device
 * mode, so nothing can pull ~3 GB into memory for a Cloud user.
 */
export async function _ensureLoaded(
  modelId: string,
  onProgress?: (progress: number) => void,
): Promise<ModelState> {
  if (useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice) {
    throw new LocalModelsOffError();
  }
  if (currentModelState?.modelId === modelId && llamaContext) return currentModelState;
  return loadModel(modelId, onProgress);
}

// ---------------------------------------------------------------------------
// Public lifecycle: each takes the llama lock exactly once.
// ---------------------------------------------------------------------------

/**
 * Makes the TEXT model resident (a no-op when it already is) and reports it in
 * the UI modelState: `loading`, then `ready`, or the error. Callers never need
 * it for correctness (infer / inferStream load the text model themselves); it
 * is a preload. The relevance model loads only inside `decide`.
 */
export async function initBaseModel(
  modelId: string = TEXT_MODEL.modelId,
  onProgress?: (progress: number) => void,
): Promise<ModelState> {
  return withLlamaLock(async () => {
    if (useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice) {
      throw new LocalModelsOffError();
    }
    const resident = currentModelState?.modelId === modelId && llamaContext;
    if (!resident) useMeraProtocolStore.getState().setModelState('loading');
    try {
      const state = await _ensureLoaded(modelId, onProgress);
      useMeraProtocolStore.getState().setModelState('ready');
      return state;
    } catch (err) {
      if (!(err instanceof LocalModelsOffError)) {
        useMeraProtocolStore.getState().setModelError(String(err));
      }
      throw err;
    }
  });
}

/**
 * Releases the resident context after a native crash. The next call reloads
 * whichever model it needs.
 */
export function resetContext(): Promise<void> {
  return withLlamaLock(() => _releaseModel());
}

/** Unloads whichever model is resident. */
export function disposeModel(): Promise<void> {
  return withLlamaLock(() => _releaseModel());
}

/** Returns the resident model's state, or null if none is loaded. */
export function getModelState(): ModelState | null {
  return currentModelState;
}

/** True while the TEXT model is the resident one. Sync, for UI wait lines. */
export function isTextModelResident(): boolean {
  return llamaContext !== null && currentModelState?.modelId === TEXT_MODEL.modelId;
}

/** Deletes one model's files. Refuses while that model is loaded. */
export function deleteBaseModel(modelId: string): Promise<void> {
  return withLlamaLock(async () => {
    if (currentModelState?.modelId === modelId && llamaContext) {
      throw new Error('Cannot delete a model that is currently loaded. Dispose it first.');
    }
    const modelDir = getModelDir(modelId);
    if (modelDir.exists) await modelDir.delete();
  });
}

/**
 * Releases the resident model and deletes every on-device model's files, in ONE
 * lock hold, so nothing can load a model between the release and the delete.
 */
export function deleteOnDeviceModels(): Promise<void> {
  return withLlamaLock(async () => {
    await _releaseModel();
    for (const m of MODEL_CATALOG) {
      const dir = getModelDir(m.modelId);
      if (dir.exists) await dir.delete();
    }
  });
}

/**
 * Wipes the whole `mera-models/` cache directory, every model id. Used by the
 * boot-time purge for Cloud users. Refuses while a model is loaded.
 */
export function purgeAllBaseModels(): Promise<void> {
  return withLlamaLock(async () => {
    if (llamaContext) {
      throw new Error('Cannot purge models while one is loaded. Dispose it first.');
    }
    const root = new Directory(Paths.cache, MODELS_DIR_NAME);
    if (root.exists) await root.delete();
  });
}

/** Cancels the active download if one is in progress. */
export function cancelActiveDownload(): void {
  const download = activeDownload;
  activeDownload = null;
  download?.cancelAsync().catch(() => {});
}

/**
 * Whether a model is downloaded and ready. With no argument: whether EVERY
 * on-device model is, which is the rule On this phone needs (both files).
 */
export async function isModelDownloaded(modelId?: string): Promise<boolean> {
  if (modelId === undefined) {
    for (const m of MODEL_CATALOG) {
      if (!(await isModelDownloaded(m.modelId))) return false;
    }
    return true;
  }
  const manifest = await readManifest(modelId);
  return manifest?.ready === true;
}

// ---------------------------------------------------------------------------
// Internal accessors (used by inference.ts)
// ---------------------------------------------------------------------------

export function _getContext(): LlamaContext | null {
  return llamaContext;
}

export function _updateInferenceSpeed(tokPerSec: number): void {
  if (currentModelState) {
    currentModelState = { ...currentModelState, inferenceSpeed: tokPerSec };
  }
}
