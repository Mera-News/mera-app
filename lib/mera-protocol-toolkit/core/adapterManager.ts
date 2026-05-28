// Adapter Manager — LoRA adapter download, load, swap, and management
// Uses expo-file-system for storage, llama.rn for hot-swapping

import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

import type { AdapterDownloadConfig, AdapterManifest } from '../types';
import {
  _getContext,
  _getActiveAdapterId,
  _setActiveAdapterId,
} from './modelManager';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ADAPTERS_DIR_NAME = 'mera-adapters';

function getAdaptersDir(): Directory {
  return new Directory(Paths.cache, ADAPTERS_DIR_NAME);
}

function getAdapterDir(adapterId: string): Directory {
  return new Directory(Paths.cache, ADAPTERS_DIR_NAME, adapterId);
}

function getAdapterFile(adapterId: string): File {
  return new File(Paths.cache, ADAPTERS_DIR_NAME, adapterId, 'adapter.gguf');
}

function getAdapterManifestFile(adapterId: string): File {
  return new File(Paths.cache, ADAPTERS_DIR_NAME, adapterId, 'manifest.json');
}

async function readAdapterManifest(
  adapterId: string,
): Promise<AdapterManifest | null> {
  const file = getAdapterManifestFile(adapterId);
  if (!file.exists) return null;
  const text = await file.text();
  return JSON.parse(text) as AdapterManifest;
}

async function writeAdapterManifest(
  manifest: AdapterManifest,
): Promise<void> {
  const file = getAdapterManifestFile(manifest.adapterId);
  await file.write(JSON.stringify(manifest));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Downloads a LoRA adapter for use with the shared base model. */
export async function downloadAdapter(
  config: AdapterDownloadConfig,
): Promise<AdapterManifest> {
  const adapterDir = getAdapterDir(config.adapterId);
  if (!adapterDir.exists) {
    await adapterDir.create({ intermediates: true });
  }

  const adapterFile = getAdapterFile(config.adapterId);

  // Download the adapter file
  await File.downloadFileAsync(config.adapterUrl, adapterFile, {
    idempotent: true,
  });

  // Verify SHA-256 checksum
  const fileBytes = await adapterFile.bytes();
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Array.from(fileBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  );

  if (digest !== config.expectedChecksum) {
    await adapterFile.delete();
    throw new Error(
      `Adapter checksum mismatch: expected ${config.expectedChecksum}, got ${digest}`,
    );
  }

  const info = await adapterFile.info();

  const manifest: AdapterManifest = {
    adapterId: config.adapterId,
    targetBaseModelId: config.targetBaseModelId,
    version: '1.0.0',
    sizeBytes: info.size ?? 0,
    downloadedAt: new Date().toISOString(),
    ready: true,
  };

  await writeAdapterManifest(manifest);
  return manifest;
}

/** Hot-swaps the active LoRA adapter on the loaded base model. */
export async function loadAdapter(adapterId: string): Promise<void> {
  const context = _getContext();
  if (!context) {
    throw new Error('No model loaded. Call initBaseModel() first.');
  }

  const adapterFile = getAdapterFile(adapterId);
  if (!adapterFile.exists) {
    throw new Error(
      `Adapter ${adapterId} not found on disk. Download it first.`,
    );
  }

  // If same adapter is already loaded, skip
  if (_getActiveAdapterId() === adapterId) return;

  // Apply the LoRA adapter
  await context.applyLoraAdapters([{ path: adapterFile.uri, scaled: 1.0 }]);
  _setActiveAdapterId(adapterId);
}

/** Removes the active adapter, reverting to the bare base model. */
export async function unloadAdapter(): Promise<void> {
  const context = _getContext();
  if (!context) return;

  if (_getActiveAdapterId()) {
    await context.removeLoraAdapters();
    _setActiveAdapterId(null);
  }
}

/** Returns all downloaded adapters available on-device. */
export function listAdapters(): AdapterManifest[] {
  const adaptersDir = getAdaptersDir();
  if (!adaptersDir.exists) return [];

  const items = adaptersDir.list();
  const manifests: AdapterManifest[] = [];

  for (const item of items) {
    if (item instanceof Directory) {
      const manifestFile = new File(item, 'manifest.json');
      if (manifestFile.exists) {
        const text = manifestFile.textSync();
        manifests.push(JSON.parse(text) as AdapterManifest);
      }
    }
  }

  return manifests;
}

/** Deletes a downloaded adapter from local storage. */
export async function deleteAdapter(adapterId: string): Promise<void> {
  if (_getActiveAdapterId() === adapterId) {
    await unloadAdapter();
  }

  const adapterDir = getAdapterDir(adapterId);
  if (adapterDir.exists) {
    await adapterDir.delete();
  }
}
