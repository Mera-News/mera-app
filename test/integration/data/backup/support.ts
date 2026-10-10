// Shared by the backup seam tests (data-U12). Not a test file.
//
// A device is seeded through the app's own services, exported through the real row source, and
// restored through the real row sink, all on the in-memory DB. Only the file (a `MemoryFile`, or
// the RNFS fake in `fakes.ts`) and the cloud are stand-ins.
import pako from 'pako';

import database from '@/lib/database';
import { MemoryFile } from '@/test/unit/data/backup/memory-file';
import { watermelonRowSink } from '@/lib/backup/adapters/watermelon-row-sink';
import { watermelonRowSource } from '@/lib/backup/adapters/watermelon-row-source';
import { knownColumns } from '@/lib/backup/backup-service';
import { BlobWriter, openBlob } from '@/lib/backup/blob';
import {
  SECTION_ROWS_KEY,
  SECTION_TABLE_KEY,
  exportBackup,
  type ExportResult,
} from '@/lib/backup/export';
import { importBackup, type ImportResult } from '@/lib/backup/import';
import { BACKUP_FORMAT_VERSION, type BackupHeader } from '@/lib/backup/types';
import appSchema from '@/lib/database/schema';
import { addFact } from '@/lib/database/services/fact-service';
import { upsertLocation } from '@/lib/database/services/location-service';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { getSuggestionByArticleId } from '@/lib/database/services/article-suggestion-reads';
import { upsertPreference } from '@/lib/database/services/publication-preference-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { keepArticleForFactCheck, saveSuggestion } from '@/lib/database/services/saved-article-suggestion-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

export const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 99);

// ---------------------------------------------------------------------------
// Export, import, and reading the DB back
// ---------------------------------------------------------------------------

/** A real export: the production row source, an in-memory scratch file and blob. */
export async function exportDevice(
  over: { key?: Uint8Array; now?: number } = {},
): Promise<{ blob: MemoryFile; result: ExportResult }> {
  const blob = new MemoryFile();
  const result = await exportBackup({
    key: over.key ?? KEY,
    rows: watermelonRowSource,
    scratch: new MemoryFile(),
    blob,
    schemaVersion: appSchema.version,
    appVersion: '1.3.0',
    now: over.now ?? Date.now(),
  });
  return { blob, result };
}

/** A real import: the production row sink and the live schema's columns. */
export function importInto(
  blob: MemoryFile,
  over: { key?: Uint8Array; schemaVersion?: number } = {},
): Promise<ImportResult> {
  return importBackup({
    key: over.key ?? KEY,
    blob,
    sink: watermelonRowSink,
    knownColumns: knownColumns(),
    schemaVersion: over.schemaVersion ?? appSchema.version,
  });
}

/** Every raw row of a table, `id` order. `_status` and `_changed` included. */
export async function rawRows(table: string): Promise<Record<string, any>[]> {
  const raws = await database.get(table as never).query().unsafeFetchRaw();
  return (raws as Record<string, any>[]).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** The whole settings table as { key: value }. */
export async function settingsMap(): Promise<Record<string, string>> {
  return Object.fromEntries((await rawRows('settings')).map((r) => [r.key as string, r.value as string]));
}

/** `{ table: rowCount }` for every table in the live schema. */
export async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of Object.keys(appSchema.tables)) {
    out[table] = await database.get(table as never).query().fetchCount();
  }
  return out;
}

/** Writes raw rows verbatim through the real sink, in batches, for volume. */
export async function bulkCreate(table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await watermelonRowSink.createRows(table, rows.slice(i, i + 500));
  }
}

// ---------------------------------------------------------------------------
// Decoding a blob (what is inside it, independent of the importer)
// ---------------------------------------------------------------------------

export interface Decoded {
  header: BackupHeader;
  frameCount: number;
  sections: { table: string; declared: number; rows: Record<string, any>[] }[];
}

export async function decode(blob: MemoryFile, key: Uint8Array = KEY): Promise<Decoded> {
  const opened = await openBlob(key, blob);
  const frames: Uint8Array[] = [];
  for await (const f of opened.frames()) frames.push(f);

  const inflate = new pako.Inflate();
  const chunks: Uint8Array[] = [];
  inflate.onData = (c: Uint8Array) => chunks.push(c);
  frames.forEach((f, i) => inflate.push(f, i === frames.length - 1));
  if (inflate.err) throw new Error(`inflate failed: ${inflate.msg}`);

  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }

  const sections: Decoded['sections'] = [];
  for (const line of new TextDecoder().decode(joined).split('\n')) {
    if (line === '') continue;
    const parsed = JSON.parse(line) as Record<string, any>;
    if (typeof parsed[SECTION_TABLE_KEY] === 'string') {
      sections.push({ table: parsed[SECTION_TABLE_KEY], declared: parsed[SECTION_ROWS_KEY], rows: [] });
    } else {
      sections[sections.length - 1].rows.push(parsed);
    }
  }
  return { header: opened.header, frameCount: frames.length, sections };
}

export function sectionRows(decoded: Decoded, table: string): Record<string, any>[] {
  return decoded.sections.find((s) => s.table === table)?.rows ?? [];
}

// ---------------------------------------------------------------------------
// Hand-made blobs (a build that is not this one, or a damaged file)
// ---------------------------------------------------------------------------

export const BASE_HEADER: BackupHeader = {
  formatVersion: BACKUP_FORMAT_VERSION,
  algo: 'recovery-code-v1',
  schemaVersion: appSchema.version,
  appVersion: '1.3.0',
  createdAt: 1_755_000_000_000,
  tables: [],
  plaintextBytes: 0,
};

/** Seals arbitrary NDJSON, so a blob the exporter would never write can be built on purpose. */
export async function sealedByHand(
  ndjson: string,
  header: Partial<BackupHeader> = {},
  options: { truncateDeflate?: boolean; key?: Uint8Array; rawPayload?: Uint8Array } = {},
): Promise<MemoryFile> {
  const blob = new MemoryFile();
  const bytes = new TextEncoder().encode(ndjson);
  const full: BackupHeader = { ...BASE_HEADER, plaintextBytes: bytes.length, ...header };
  const writer = new BlobWriter(options.key ?? KEY, blob, full);
  let payload = pako.deflate(bytes);
  if (options.truncateDeflate) payload = payload.slice(0, payload.length - 24);
  if (options.rawPayload) payload = new Uint8Array(options.rawPayload);
  await writer.writeFrame(payload, true);
  return blob;
}

export function section(table: string, rows: Record<string, unknown>[]): string {
  return [
    JSON.stringify({ [SECTION_TABLE_KEY]: table, [SECTION_ROWS_KEY]: rows.length }),
    ...rows.map((r) => JSON.stringify(r)),
  ]
    .map((l) => `${l}\n`)
    .join('');
}

export function stat(table: string, rows: number): { table: string; rows: number; rowsAvailable: number } {
  return { table, rows, rowsAvailable: rows };
}

/** Deterministic text deflate cannot squash, so N bytes in is roughly N bytes out. */
export function highEntropyText(bytes: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  let lcg = 0x2545f491;
  let out = '';
  for (let i = 0; i < bytes; i++) {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    out += alphabet[(lcg >>> 26) & 63];
  }
  return out;
}

export async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const reason = (err as { reason?: string }).reason;
    if (reason) return reason;
    throw err;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

// ---------------------------------------------------------------------------
// A realistic device, seeded through the services
// ---------------------------------------------------------------------------

function article(id: string): ArticleWithClusters {
  return {
    __typename: 'ArticleWithClusters',
    _id: id,
    clusters: [{ __typename: 'ClusterMembership', clusterId: `c-${id}`, confidence: 0.9, stableClusterId: `member-${id}` }],
    title: `Story ${id} saga${id}`,
    title_en: `Story ${id} saga${id}`,
    description_en: `Details of story ${id}`,
    article_url: `https://example.com/${id}`,
    image_url: `https://example.com/${id}.jpg`,
    country_code: 'DEU',
    publication_name: `Pub ${id}`,
    language_code: 'de',
    pubDate: new Date(Date.now() - 3_600_000).toISOString(),
    geo_tags: [],
    entities: [],
    event_type: null,
    category: null,
    maxClusterSize: 1,
  } as ArticleWithClusters;
}

/** Lands an `article_suggestions` row the way feed-sync does and reads it back. */
export async function landSuggestion(id: string): Promise<ForYouSuggestion> {
  await persistAndLinkV2Suggestions([article(id)], new Map(), {
    matchedTopics: new Map([[id, [{ topicId: `topic-${id}`, text: `topic ${id}` }]]]),
  });
  return (await getSuggestionByArticleId(id))!;
}

/** Settings a backup carries, and settings it must never carry or touch. */
export const CARRIED_SETTINGS: Record<string, string> = {
  app_language: 'de',
  startup_tab: 'world',
  'headline_depth:DE': '3',
  nav_order_world: '["country:DE","country:FR"]',
  feed_view: 'stories',
};
export const DEVICE_SETTINGS: Record<string, string> = {
  cached_user_id: 'user-on-this-device',
  needs_reauth: '1',
  onboarding_done: '1',
  mera_button_corner: 'bottom-left',
  backup_cadence: 'daily',
  backup_provider: 'icloud',
  last_known_subscription_tier: 'starter',
};

export interface SeededDevice {
  factIds: string[];
  topicIds: string[];
  locationId: string;
  savedId: string;
  retainedArticleId: string;
  followedStoryId: string;
}

/**
 * Two facts, three topics, a home place, a publication preference, one saved article, one
 * retention row, one followed story, a publication visit, and the settings above.
 */
export async function seedDevice(): Promise<SeededDevice> {
  const f1 = await addFact('I follow Formula 1 racing', { topics: ['formula 1'] });
  const f2 = await addFact('I live in Berlin');
  const [t1, t2, t3] = await createTopics([
    { factId: f1.id, text: 'Formula 1', weight: 0.8 },
    { factId: f1.id, text: 'Grand Prix', weight: 0.6 },
    { factId: f2.id, text: 'Berlin', weight: 0.7 },
  ]);
  const place = await upsertLocation({ city: 'Berlin', countryCode: 'DE', role: 'home', weight: 0.9 });
  await upsertPreference({ publicationName: 'Der Spiegel', sourceCountryCode: 'DE', weight: 0.8 });

  const saved = await landSuggestion('art-saved');
  await saveSuggestion(saved);
  await keepArticleForFactCheck({
    articleId: 'art-retained',
    title: 'Retained headline',
    articleUrl: 'https://example.com/art-retained',
    publicationName: 'Pub retained',
  });
  const story = await trackStory({
    articleId: 'art-follow',
    title: 'A followed story',
    originSurface: 'detail',
    topicId: t3.id,
    topicText: 'Berlin',
  });
  await recordPublicationVisit({ publicationName: 'Der Spiegel', countryCode: 'DEU', articleId: 'art-saved' });

  for (const [k, v] of Object.entries({ ...CARRIED_SETTINGS, ...DEVICE_SETTINGS })) await setSetting(k, v);

  return {
    factIds: [f1.id, f2.id],
    topicIds: [t1.id, t2.id, t3.id],
    locationId: place.id,
    savedId: saved._id,
    retainedArticleId: 'art-retained',
    followedStoryId: story.id,
  };
}

export { getSetting, setSetting };
