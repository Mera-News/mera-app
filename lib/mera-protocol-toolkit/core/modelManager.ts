// Model Manager — Base model download, load, dispose, and state management
// Uses expo-file-system for storage metadata, RNFS for download, llama.rn for inference

import { Directory, File, Paths } from 'expo-file-system';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {
  addNativeLogListener,
  initLlama,
  loadLlamaModelInfo,
  toggleNativeLog,
  type LlamaContext,
} from 'llama.rn';
import * as Crypto from 'expo-crypto';

import logger from '../../logger';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import type {
  BaseModelDownloadConfig,
  BaseModelManifest,
  ModelState,
} from '../types';

// ---------------------------------------------------------------------------
// Progress callback type (matches pocketpal's pattern)
// ---------------------------------------------------------------------------

export type DownloadProgressInfo = {
  bytesWritten: number;
  contentLength: number;
  progress: number; // 0-100
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let llamaContext: LlamaContext | null = null;
let currentModelState: ModelState | null = null;
let activeAdapterId: string | null = null;
let activeDownloadJobId: number | null = null;

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
  return new File(
    Paths.cache,
    MODELS_DIR_NAME,
    modelId,
    MANIFEST_FILE_NAME,
  );
}

async function readManifest(
  modelId: string,
): Promise<BaseModelManifest | null> {
  const file = getManifestFile(modelId);
  if (!file.exists) return null;
  const text = await file.text();
  return JSON.parse(text) as BaseModelManifest;
}

async function writeManifest(manifest: BaseModelManifest): Promise<void> {
  const file = getManifestFile(manifest.modelId);
  await file.write(JSON.stringify(manifest));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Downloads and stores the shared base model for on-device inference.
 * Uses @dr.pogodin/react-native-fs (same approach as pocketpal-ai).
 * RNFS.downloadFile gives us real native progress callbacks and
 * background-capable downloads on iOS.
 */
export async function downloadBaseModel(
  config: BaseModelDownloadConfig,
  onProgress?: (info: DownloadProgressInfo) => void,
): Promise<BaseModelManifest> {
  const modelDir = getModelDir(config.modelId);
  if (!modelDir.exists) {
    await modelDir.create({ intermediates: true });
  }

  // RNFS needs a plain filesystem path, not a file:// URI.
  // Paths.cache resolves to the iOS Caches directory.
  const destinationPath = `${RNFS.CachesDirectoryPath}/${MODELS_DIR_NAME}/${config.modelId}/model.gguf`;

  // Ensure directory exists via RNFS (belt-and-suspenders with expo mkdir above)
  const dirPath = destinationPath.substring(0, destinationPath.lastIndexOf('/'));
  await RNFS.mkdir(dirPath);

  logger.info('[ModelManager] Starting RNFS download', { modelUrl: config.modelUrl });
  logger.info('[ModelManager] Destination', { destinationPath });

  const downloadResult = RNFS.downloadFile({
    fromUrl: config.modelUrl,
    toFile: destinationPath,
    background: true,       // iOS background URLSession — survives app backgrounding
    discretionary: false,   // Don't let iOS defer the download
    progressInterval: 800,  // Native progress callback every 800ms (pocketpal default)
    begin: (res) => {
      logger.info('[ModelManager] Download started', {
        statusCode: res.statusCode,
        contentLength: res.contentLength,
        jobId: downloadResult.jobId,
      });
      activeDownloadJobId = downloadResult.jobId;
    },
    progress: (res) => {
      const pct = res.contentLength > 0
        ? (res.bytesWritten / res.contentLength) * 100
        : 0;
      onProgress?.({
        bytesWritten: res.bytesWritten,
        contentLength: res.contentLength,
        progress: pct,
      });
    },
  });

  activeDownloadJobId = downloadResult.jobId;

  try {
    const result = await downloadResult.promise;
    logger.info('[ModelManager] Download finished', { statusCode: result.statusCode, bytesWritten: result.bytesWritten });

    if (result.statusCode !== 200) {
      throw new Error(`Download failed with HTTP status ${result.statusCode}`);
    }
  } finally {
    activeDownloadJobId = null;
  }

  // Verify SHA-256 checksum (skip if no checksum provided)
  const modelFile = getModelFile(config.modelId);
  if (config.expectedChecksum) {
    const fileBytes = await modelFile.bytes();
    const digest = await Crypto.digest(
      Crypto.CryptoDigestAlgorithm.SHA256,
      fileBytes,
    );
    const hexDigest = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (hexDigest !== config.expectedChecksum) {
      await RNFS.unlink(destinationPath).catch(() => {});
      throw new Error(
        `Checksum mismatch: expected ${config.expectedChecksum}, got ${hexDigest}`,
      );
    }
  }

  // Get file info for manifest
  const info = await modelFile.info();

  const manifest: BaseModelManifest = {
    modelId: config.modelId,
    version: '1.0.0',
    sizeBytes: info.size ?? 0,
    quantization: 'Q4_K_M',
    downloadedAt: new Date().toISOString(),
    ready: true,
  };

  await writeManifest(manifest);
  return manifest;
}

/** Loads the shared base model into memory, ready for inference. */
export async function initBaseModel(
  modelId?: string,
  onProgress?: (progress: number) => void,
): Promise<ModelState> {
  const resolvedModelId = modelId ?? useMeraProtocolStore.getState().selectedModelId;
  const modelFile = getModelFile(resolvedModelId);

  if (!modelFile.exists) {
    throw new Error(
      `Model ${resolvedModelId} not found on disk. Download it first.`,
    );
  }

  // Dispose existing context if loaded
  if (llamaContext) {
    await llamaContext.release();
    llamaContext = null;
    currentModelState = null;
  }

  // --- Native log capture ---
  // llama.rn surfaces only a generic "Failed to load model" string from JS, but
  // llama.cpp prints the real reason to stderr. Hook the native log stream and
  // buffer the most recent lines so we can dump them alongside any failure.
  const nativeLogBuffer: string[] = [];
  const nativeLogSub = addNativeLogListener((level, text) => {
    const line = `[${level}] ${text}`;
    nativeLogBuffer.push(line);
    if (nativeLogBuffer.length > 200) nativeLogBuffer.shift();
    logger.info('[ModelManager][native]', { line });
  });
  try {
    await toggleNativeLog(true);
  } catch (logErr) {
    logger.warn('[ModelManager] toggleNativeLog(true) failed', { error: String(logErr) });
  }

  // --- Pre-load diagnostics ---
  // Capture file path, size, and the first 16 bytes so we can tell whether
  // initLlama is rejecting a junk file (HTML/LFS pointer) vs. a valid GGUF
  // that fails for runtime reasons (params, memory, llama.rn version).
  const diskPath = `${RNFS.CachesDirectoryPath}/${MODELS_DIR_NAME}/${resolvedModelId}/model.gguf`;
  let fileSizeBytes = -1;
  let headHex = 'unread';
  let headAscii = 'unread';
  try {
    const info = await modelFile.info();
    fileSizeBytes = info.size ?? -1;
  } catch (infoErr) {
    logger.warn('[ModelManager] modelFile.info() failed', { error: String(infoErr) });
  }
  try {
    // RNFS.read(path, length, position, encoding) — base64 of first 16 bytes
    const headB64 = await RNFS.read(diskPath, 16, 0, 'base64');
    const headBytes = Uint8Array.from(atob(headB64), (c) => c.charCodeAt(0));
    headHex = Array.from(headBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    headAscii = Array.from(headBytes)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
      .join('');
  } catch (readErr) {
    logger.warn('[ModelManager] failed to read first bytes of model file', { error: String(readErr) });
  }

  const isValidGguf = headAscii.startsWith('GGUF');
  logger.info('[ModelManager] Pre-initLlama diagnostics', {
    resolvedModelId,
    modelUri: modelFile.uri,
    diskPath,
    fileSizeBytes,
    fileSizeMB: fileSizeBytes > 0 ? (fileSizeBytes / (1024 * 1024)).toFixed(2) : 'n/a',
    headHex,
    headAscii,
    isValidGguf,
  });

  if (!isValidGguf) {
    logger.error('[ModelManager] Model file is NOT a valid GGUF (magic bytes mismatch)', {
      headHex,
      headAscii,
      fileSizeBytes,
    });
  }

  // Sanity check: parse just the model header without creating a context.
  // If this succeeds we know the file is parseable by llama.cpp's GGUF reader,
  // which narrows the failure to context creation (params / memory / KV cache).
  try {
    const modelInfo = await loadLlamaModelInfo(modelFile.uri);
    logger.info('[ModelManager] loadLlamaModelInfo succeeded', { modelInfo });
  } catch (infoErr) {
    logger.error('[ModelManager] loadLlamaModelInfo failed — file is not a parseable GGUF', {
      error: String(infoErr),
      stack: (infoErr as Error)?.stack,
    });
  }

  // Load via llama.rn
  const initParams = {
    model: modelFile.uri,
    n_ctx: 4096,
    n_gpu_layers: 999,  // Offload ALL layers to Metal GPU
    n_threads: 4,       // A18 Pro: 2P + 4E cores — 4 threads avoids stalling on slow E-cores
    use_mlock: true,
    use_mmap: true,     // Memory-map file — lets iOS page model weights without killing the app
    n_batch: 512,       // Batch size sweet spot for Metal on A-series chips
    flash_attn: true,
    cache_type_k: 'q8_0' as const,  // 2x smaller than f16, keys need precision for attention scores
    cache_type_v: 'q4_0' as const,  // 4x smaller than f16, values tolerate more quantization
  };
  logger.info('[ModelManager] Calling initLlama with params', initParams);

  let context;
  try {
    context = await initLlama(
      initParams,
      onProgress ? (p) => onProgress(p) : undefined,
    );
  } catch (initErr) {
    const e = initErr as Error & { code?: string | number };
    logger.error('[ModelManager] initLlama threw', {
      name: e?.name,
      message: e?.message,
      code: e?.code,
      stack: e?.stack,
      stringified: String(initErr),
      fileSizeBytes,
      headHex,
      headAscii,
      isValidGguf,
      initParams,
      nativeLogTail: nativeLogBuffer.slice(-50),
    });
    throw initErr;
  } finally {
    nativeLogSub.remove();
    toggleNativeLog(false).catch(() => {});
  }

  llamaContext = context;
  activeAdapterId = null;

  currentModelState = {
    modelId: resolvedModelId,
    loaded: true,
    activeAdapterId: null,
    contextWindow: 4096,
    memoryUsageMB: Math.round((context.model?.size ?? 0) / (1024 * 1024)),
    backend: context.gpu ? 'metal' : 'cpu',
    inferenceSpeed: 0, // Will be populated after first inference
  };

  logger.info(`[ModelManager] Model loaded: ${resolvedModelId} | backend: ${currentModelState.backend} | memory: ${currentModelState.memoryUsageMB}MB | ctx: ${currentModelState.contextWindow}`);

  return currentModelState;
}

/**
 * Reset the llama context after a native crash.
 * Releases the (potentially corrupted) context and reloads the model.
 */
export async function resetContext(): Promise<void> {
  const modelId = currentModelState?.modelId;
  if (llamaContext) {
    await llamaContext.release().catch(() => {});
    llamaContext = null;
    currentModelState = null;
    activeAdapterId = null;
  }
  if (modelId) {
    await initBaseModel(modelId);
  }
}

/** Unloads the base model and any active adapter from memory. */
export async function disposeModel(): Promise<void> {
  if (llamaContext) {
    await llamaContext.release();
    llamaContext = null;
    currentModelState = null;
    activeAdapterId = null;
  }
}

/** Returns the current model state, or null if no model is loaded. */
export function getModelState(): ModelState | null {
  return currentModelState;
}

/** Deletes the shared base model from storage. */
export async function deleteBaseModel(modelId: string): Promise<void> {
  if (currentModelState?.modelId === modelId && llamaContext) {
    throw new Error('Cannot delete a model that is currently loaded. Dispose it first.');
  }

  const modelDir = getModelDir(modelId);
  if (modelDir.exists) {
    await modelDir.delete();
  }
}

/**
 * Wipe the entire `mera-models/` cache directory — every modelId, not just
 * the currently-selected one. Used by boot-time purge when the user has
 * Mera Protocol disabled so we don't hold ~3 GB of GGUF on disk for a
 * feature the user has opted out of.
 *
 * Refuses to run if a model is currently loaded into llama.rn; caller must
 * `disposeModel()` first. Otherwise safe to call when nothing is downloaded
 * (directory absent → no-op).
 */
export async function purgeAllBaseModels(): Promise<void> {
  if (llamaContext) {
    throw new Error('Cannot purge models while one is loaded. Dispose it first.');
  }
  const root = new Directory(Paths.cache, MODELS_DIR_NAME);
  if (root.exists) {
    await root.delete();
  }
}

/** Cancels the active download if one is in progress (uses RNFS.stopDownload). */
export function cancelActiveDownload(): void {
  if (activeDownloadJobId !== null) {
    RNFS.stopDownload(activeDownloadJobId);
    activeDownloadJobId = null;
  }
}

/** Checks if a model is downloaded and ready. */
export async function isModelDownloaded(
  modelId?: string,
): Promise<boolean> {
  const resolved = modelId ?? useMeraProtocolStore.getState().selectedModelId;
  const manifest = await readManifest(resolved);
  return manifest?.ready === true;
}

// ---------------------------------------------------------------------------
// Internal accessors (used by inference.ts and adapterManager.ts)
// ---------------------------------------------------------------------------

export function _getContext(): LlamaContext | null {
  return llamaContext;
}

export function _getActiveAdapterId(): string | null {
  return activeAdapterId;
}

export function _setActiveAdapterId(id: string | null): void {
  activeAdapterId = id;
  if (currentModelState) {
    currentModelState = { ...currentModelState, activeAdapterId: id };
  }
}

export function _updateInferenceSpeed(tokPerSec: number): void {
  if (currentModelState) {
    currentModelState = { ...currentModelState, inferenceSpeed: tokPerSec };
  }
}
