// local-data-size: what Mera keeps on this phone, for the Your data meter. Read
// on focus only. Local: no log, no breadcrumb, no Sentry extra.

import { Q } from '@nozbe/watermelondb';
import { Directory, File, Paths } from 'expo-file-system';
import { getFreeDiskStorageAsync } from 'expo-file-system/legacy';

import { BACKUP_DOCUMENT_DIRECTORY } from '../backup/types';
import { RELEVANCE_MODEL } from '../mera-protocol-toolkit/core/model-catalog';
import database from './index';

export interface LocalDataSizes {
  readonly databaseBytes: number;
  /** Null when there is no model on this phone, or its size could not be read. */
  readonly modelBytes: number | null;
  /** A staged backup, 0 when there is none. */
  readonly backupBytes: number;
  /** Null when the free space could not be read. */
  readonly freeBytes: number | null;
}

async function pragma(name: 'page_count' | 'freelist_count' | 'page_size'): Promise<number> {
  const rows = (await database
    .get('settings')
    .query(Q.unsafeSqlQuery(`pragma ${name}`))
    .unsafeFetchRaw()) as Record<string, unknown>[];
  const value = rows[0]?.[name];
  if (typeof value !== 'number') throw new Error(`pragma ${name} gave no number`);
  return value;
}

/**
 * Net of free pages: nothing runs VACUUM, so the file itself never shrinks
 * after a clear, and the figure should. Pragmas rather than the file's size
 * because expo-file-system cannot reach the Android database path.
 *
 * shortcut: the -wal file is not counted, about 4 MB at the default checkpoint. Count it if a device shows a visible gap.
 */
async function databaseBytes(): Promise<number> {
  const [pages, free, pageSize] = await Promise.all([
    pragma('page_count'),
    pragma('freelist_count'),
    pragma('page_size'),
  ]);
  return (pages - free) * pageSize;
}

async function modelBytes(): Promise<number | null> {
  // Lazy: modelManager brings llama.rn with it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const manager = require('../mera-protocol-toolkit/core/modelManager') as typeof import('../mera-protocol-toolkit/core/modelManager');
  return manager.modelFileBytes(RELEVANCE_MODEL.modelId);
}

function backupBytes(): number {
  const dir = new Directory(Paths.document, BACKUP_DOCUMENT_DIRECTORY);
  if (!dir.exists) return 0;
  return dir
    .list()
    .reduce((sum, entry) => sum + (entry instanceof File ? (entry.size ?? 0) : 0), 0);
}

/** Null only when the database read fails; the other reads degrade alone. */
export async function readLocalDataSizes(): Promise<LocalDataSizes | null> {
  const dbBytes = await databaseBytes().catch(() => null);
  if (dbBytes === null) return null;
  const [model, free] = await Promise.all([
    modelBytes().catch(() => null),
    getFreeDiskStorageAsync().catch(() => null),
  ]);
  let backup = 0;
  try {
    backup = backupBytes();
  } catch {
    // Counted as none: a staged backup is rare and short lived.
  }
  return { databaseBytes: dbBytes, modelBytes: model, backupBytes: backup, freeBytes: free };
}
