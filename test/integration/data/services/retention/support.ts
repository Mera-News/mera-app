// Shared by the retention / saved-article / followed-story / fact-check / data-cleanup seam tests
// (data-U9). Not a test file.
//
// Everything is seeded through the app's own services. The two places a service cannot reach are
// written through the real RESTORE path (`importBackup` over `watermelonRowSink`), because a restore
// is the only code that writes a row verbatim: a pre-v38 saved row with a NULL origin, a saved row
// with a corrupt JSON column and a tracked story with status 'ended'.
import { Q } from '@nozbe/watermelondb';

import database from '@/lib/database';
import appSchema from '@/lib/database/schema';
import { MemoryFile } from '@/lib/backup/__tests__/memory-file';
import { watermelonRowSink } from '@/lib/backup/adapters/watermelon-row-sink';
import { exportBackup, type RowPageQuery, type RowSource } from '@/lib/backup/export';
import { importBackup } from '@/lib/backup/import';
import { persistAndLinkV2Suggestions, getSuggestionByArticleId } from '@/lib/database/services/article-suggestion-service';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useFactChecksStore } from '@/lib/stores/fact-checks-store';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import { restoreFaults as restoreSharedFaults } from '../../support/faults';

// ---------------------------------------------------------------------------
// Module memory
// ---------------------------------------------------------------------------

/** The one store these modules keep. The integration setup resets the DB, storage and clock. */
export function resetRetentionMemory(): void {
  useFactChecksStore.setState(useFactChecksStore.getInitialState(), true);
}

let seq = 0;
/** An id no earlier test in this file used (`lib/saved-state` keeps its overrides for the whole file). */
export const freshId = (prefix = 'art'): string => `${prefix}-${++seq}`;

// ---------------------------------------------------------------------------
// Articles and suggestions
// ---------------------------------------------------------------------------

/** A hydrated article, as `GetArticlesForTopicsByIds` returns it. */
export function article(id: string, over: Partial<ArticleWithClusters> = {}): ArticleWithClusters {
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
    ...over,
  } as ArticleWithClusters;
}

/** Lands `article_suggestions` rows the way feed-sync does and reads each back as a ForYouSuggestion. */
export async function landSuggestions(
  ids: string[],
  over: Partial<ArticleWithClusters> = {},
  topicId?: string,
): Promise<ForYouSuggestion[]> {
  // a real topic id links each row to the topic's fact (article_suggestion_facts); a made-up one links nothing
  await persistAndLinkV2Suggestions(
    ids.map((id) => article(id, over)),
    new Map(),
    { matchedTopics: new Map(ids.map((id) => [id, [{ topicId: topicId ?? `topic-${id}`, text: `topic ${id}` }]])) },
  );
  const out: ForYouSuggestion[] = [];
  for (const id of ids) out.push((await getSuggestionByArticleId(id))!);
  return out;
}

export async function landSuggestion(id: string, over: Partial<ArticleWithClusters> = {}): Promise<ForYouSuggestion> {
  return (await landSuggestions([id], over))[0];
}

// ---------------------------------------------------------------------------
// Reads (no service lists retention rows, by design)
// ---------------------------------------------------------------------------

export interface SavedRow {
  id: string;
  articleId: string;
  origin: string | null;
  savedAt: number;
}

export async function savedRows(): Promise<SavedRow[]> {
  const rows = await database.get('saved_article_suggestions').query(Q.sortBy('saved_at', Q.asc)).fetch();
  return rows.map((r: any) => ({
    id: r.id as string,
    articleId: r.articleId as string,
    origin: (r.origin ?? null) as string | null,
    savedAt: (r.savedAt as Date).getTime(),
  }));
}

export async function savedRow(id: string): Promise<SavedRow | undefined> {
  return (await savedRows()).find((r) => r.id === id);
}

/** `{ id: origin }` for every saved/retention row. */
export async function originsById(): Promise<Record<string, string | null>> {
  return Object.fromEntries((await savedRows()).map((r) => [r.id, r.origin]));
}

// ---------------------------------------------------------------------------
// The real restore path
// ---------------------------------------------------------------------------

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 7);

class FakeRowSource implements RowSource {
  constructor(private readonly data: Record<string, Record<string, unknown>[]>) {}
  snapshot<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
  page(query: RowPageQuery): Promise<readonly Record<string, unknown>[]> {
    const rows = [...(this.data[query.table] ?? [])];
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return Promise.resolve(rows.slice(query.offset, query.offset + query.limit));
  }
  count(table: string): Promise<number> {
    return Promise.resolve((this.data[table] ?? []).length);
  }
}

function knownColumns(): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [table, def] of Object.entries(appSchema.tables)) {
    out[table] = Object.keys((def as { columns: Record<string, unknown> }).columns);
  }
  return out;
}

/**
 * Restores raw rows into the REAL database through `importBackup` and the production
 * `watermelonRowSink`. A restore REPLACES every backed-up table, so call it FIRST in a test and
 * seed through the services afterwards. Rows are raw column objects (snake_case, dates as epoch ms).
 */
export async function restoreRows(data: Record<string, Record<string, unknown>[]>): Promise<void> {
  const blob = new MemoryFile();
  await exportBackup({
    key: KEY,
    rows: new FakeRowSource(data),
    scratch: new MemoryFile(),
    blob,
    schemaVersion: appSchema.version,
    appVersion: '1.3.0',
    now: Date.now(),
  });
  await importBackup({
    key: KEY,
    blob,
    sink: watermelonRowSink,
    knownColumns: knownColumns(),
    schemaVersion: appSchema.version,
  });
}

/** A raw `saved_article_suggestions` row for `restoreRows`. */
export function rawSaved(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    article_id: id,
    cluster_memberships_json: '[{"clusterId":"c1","confidence":0.9}]',
    relevance: 0.7,
    reason: 'Because you follow Berlin',
    relevance_generation_completed: true,
    reason_generation_completed: true,
    country_code: 'DE',
    language_code: 'de',
    publication_name: 'Der Spiegel',
    title_en: `Headline ${id}`,
    title_original: `Titel ${id}`,
    description_en: 'A description',
    article_url: `https://example.com/${id}`,
    image_url: null,
    matched_topic_texts_json: '["berlin"]',
    origin: null,
    created_at: 1_700_000_000_000,
    first_pub_date: 1_699_999_000_000,
    saved_at: 1_700_000_000_000,
    ...over,
  };
}

/** A raw `tracked_stories` row for `restoreRows` (a restore is the only way to get an 'ended' story or a null watermark). */
export function rawTracked(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    stable_cluster_id: null,
    member_article_ids_json: '[]',
    llm_headline: null,
    fallback_title: `Story ${id}`,
    latest_article_id: null,
    origin_surface: 'detail',
    last_update_at: null,
    unseen_count: 0,
    last_checked_at: null,
    miss_count: 0,
    status: 'active',
    topic_id: null,
    topic_text: null,
    member_snapshots_json: '[]',
    seen_pub_watermark_ms: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Faults and gates on a real collection (R23 / R26), restored by `restoreFaults`
// ---------------------------------------------------------------------------

const spies: jest.SpyInstance[] = [];
const gates: (() => void)[] = [];
const subscriptions: (() => void)[] = [];

/** Every value an observable emits from now on; the subscription ends in `restoreFaults()`. */
export function collect<T>(observable: { subscribe(next: (value: T) => void): { unsubscribe(): void } }): T[] {
  const values: T[] = [];
  const sub = observable.subscribe((value) => values.push(value));
  subscriptions.push(() => sub.unsubscribe());
  return values;
}

/** `jest.spyOn` on one method of a real object (R23), put back by `restoreFaults()`. */
export function spyOn<T extends object, K extends keyof T & string>(target: T, method: K): jest.SpyInstance {
  const spy = jest.spyOn(target, method as never);
  spies.push(spy);
  return spy;
}

export { failTableQuery } from '../../support/faults';

/**
 * The FIRST `find()` on `table` reads the row, then waits for `release()` before handing it back.
 * Later finds pass straight through. The read happens before the wait, so the caller holds exactly
 * the record that existed when it asked.
 */
export function holdFirstFind(table: string): { release(): void; reached: Promise<void> } {
  const collection = database.get(table) as any;
  const real = collection.find.bind(collection);
  let held = false;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  gates.push(release);
  spies.push(
    jest.spyOn(collection, 'find').mockImplementation((async (id: string) => {
      if (held) return real(id);
      held = true;
      let record: unknown;
      let error: unknown;
      try {
        record = await real(id);
      } catch (err) {
        error = err;
      }
      entered();
      await gate;
      if (error) throw error;
      return record;
    }) as never),
  );
  return { release, reached };
}

/** Opens every gate and puts every spied method back. Call from `afterEach`. */
export function restoreFaults(): void {
  restoreSharedFaults();
  for (const stop of subscriptions.splice(0)) stop();
  for (const open of gates.splice(0)) open();
  for (const spy of spies.splice(0)) spy.mockRestore();
}

/** Real-timer poll; resolves false when `condition` never held within `timeoutMs`. */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 400): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}
