// Shared by the topics / facts / combination-pass seam tests (data-U8). Not a test file.
//
// Everything runs on the in-memory DB with the real services and real stores. Seeding goes through
// `addFact`, `createTopics`, `deleteTopicWithDecline`, `recordDecline`, `trackStory`,
// `enqueueComboPass` and `enqueueJob`. The few reads that no service offers (a table-wide row list,
// a job list, an adapter-level count) query the collection read-only and say so.
import { Q } from '@nozbe/watermelondb';
import type { Clause } from '@nozbe/watermelondb/QueryDescription';

import database from '@/lib/database';
import { restoreFaults } from '../../support/faults';
import type InferenceJobModel from '@/lib/database/models/InferenceJob';
import type { InferenceJobType } from '@/lib/database/models/InferenceJob';
import type TopicModel from '@/lib/database/models/Topic';
import { __resetComboPassForTests } from '@/lib/database/services/combo-pass-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { createTopics } from '@/lib/database/services/topic-service';
import { __resetPendingForTests } from '@/lib/database/services/topic-decline-service';
import { setSetting } from '@/lib/database/services/setting-service';
import { invalidateJwtCache } from '@/lib/auth-client';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { ProcessingMode, type ArticleWithClusters } from '@/lib/generated/graphql-types';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, server } from '@/test/helpers';

// ---------------------------------------------------------------------------
// Module memory (T-reset)
// ---------------------------------------------------------------------------

const resetStore = (store: unknown): void =>
  (store as { setState(s: unknown, replace: true): void; getInitialState(): unknown }).setState(
    (store as { getInitialState(): unknown }).getInitialState(),
    true,
  );

/** Everything the services keep in memory that a per-test DB reset does not touch. Call from `beforeEach`. */
export function resetTopicsMemory(): void {
  __resetPendingForTests();
  __resetComboPassForTests();
  resetStore(useForYouStore);
  resetStore(useMeraProtocolStore);
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  resetStore(useNetworkStore);
  useNetworkStore.setState({ isConnected: true });
}

/** The cloud call path: limiter spacing, fallback ladder, attestation and JWT caches. */
export function resetCloudMemory(): void {
  resetLimiter();
  resetModelFallback();
  __resetOnDeviceGateForTests();
  clearAttestationCache();
  invalidateJwtCache();
}

/** Call from `afterEach`. */
export function cleanupTopics(): void {
  restoreFaults();
  for (const stop of bodyWatchers.splice(0)) stop();
  __resetPendingForTests();
  __resetComboPassForTests();
}

/** The mode the way the settings screen leaves it: the store AND the persisted row. */
export async function setMode(mode: 'cloud' | 'on-device'): Promise<void> {
  const value = mode === 'cloud' ? ProcessingMode.Cloud : ProcessingMode.OnDevice;
  useMeraProtocolStore.setState({ processingMode: value });
  await setSetting('mera_processing_mode', value);
}

// ---------------------------------------------------------------------------
// Driving the clock
// ---------------------------------------------------------------------------

/**
 * A service call under a clock that only moves when driven (`useStrictClock`): WatermelonDB hands a
 * write that has to wait to the next queued writer through a timer, so the call needs fake time to
 * turn. 1 ms steps keep the fake time a call burns negligible next to the windows under test.
 */
export const drive = <T,>(promise: Promise<T>): Promise<T> => advanceUntilDone(promise, 120_000, 1);

// ---------------------------------------------------------------------------
// Seeding, through the app's services
// ---------------------------------------------------------------------------

export interface TopicSeed {
  text: string;
  weight?: number;
  provenance?: 'llm' | 'user' | 'feedback' | 'tracked' | 'combo' | 'migration' | 'exploration';
  status?: 'active' | 'suppressed' | 'retired';
}

/** A fact with topic rows. `createTopics` also appends each text to `fact.metadata.topics`. */
export async function seedFact(statement: string, topics: (string | TopicSeed)[] = []) {
  const fact = await addFact(statement);
  const rows = await seedTopics(fact.id, topics);
  return { fact, topics: rows };
}

export async function seedTopics(factId: string | null, topics: (string | TopicSeed)[]) {
  return createTopics(
    topics.map((t) => {
      const seed = typeof t === 'string' ? { text: t } : t;
      return {
        factId,
        text: seed.text,
        weight: seed.weight ?? 0.75,
        provenance: seed.provenance ?? ('llm' as const),
        status: seed.status ?? ('active' as const),
      };
    }),
  );
}

/** `fact.metadata.topics` as the facts screen and the legacy retrieval path read it. */
export async function metadataTopics(factId: string): Promise<string[]> {
  const fact = (await getFacts()).find((f) => f.id === factId);
  return fact?.metadata?.topics ?? [];
}

export async function metadataOf(factId: string): Promise<Record<string, string[]>> {
  const fact = (await getFacts()).find((f) => f.id === factId);
  return (fact?.metadata ?? {}) as Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Reads no service offers (collection reads, read only)
// ---------------------------------------------------------------------------

/** `facts.topics_status` as the adapter holds it (see persistedMetadataTopics). */
export async function persistedTopicsStatus(factId: string): Promise<string | null> {
  const rows = (await database.get('facts').query(Q.where('id', factId)).unsafeFetchRaw()) as {
    topics_status?: string | null;
  }[];
  return rows[0]?.topics_status ?? null;
}

/**
 * `metadata.topics` as the ADAPTER holds it, not as a cached record says. After an injected batch
 * failure the cached model is left dirty (prepared, never committed), so only the raw row can
 * answer "did the write land".
 */
export async function persistedMetadataTopics(factId: string): Promise<string[]> {
  const rows = (await database.get('facts').query(Q.where('id', factId)).unsafeFetchRaw()) as {
    metadata_json?: string | null;
  }[];
  const json = rows[0]?.metadata_json;
  return json ? ((JSON.parse(json) as { topics?: string[] }).topics ?? []) : [];
}

const topicsTable = () => database.get<TopicModel>('topics');
const jobsTable = () => database.get<InferenceJobModel>('inference_jobs');

/** Every topic row on the device, any fact, status or staging. */
export async function allTopics(): Promise<TopicModel[]> {
  return topicsTable().query().fetch();
}

/** Adapter-level row count of a table (a fetchCount, so a record left dirty in the cache cannot answer for the DB). */
export async function countRows(table: string, ...conditions: Clause[]): Promise<number> {
  return database.get(table).query(...conditions).fetchCount();
}

export interface JobRow {
  id: string;
  type: InferenceJobType;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | undefined;
}

/** Rows of the persisted queue, oldest first. The job service has no list read. */
export async function jobRows(type?: InferenceJobType): Promise<JobRow[]> {
  const rows = await jobsTable()
    .query(...(type ? [Q.where('job_type', type)] : []), Q.sortBy('created_at', Q.asc))
    .fetch();
  return rows.map((r) => ({
    id: r.id,
    type: r.jobType,
    status: r.status,
    priority: r.priority,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    errorMessage: r.errorMessage ?? null,
    payload: r.payload,
    result: r.result,
  }));
}

export async function jobById(id: string): Promise<JobRow | undefined> {
  return (await jobRows()).find((j) => j.id === id);
}

/**
 * A fact row destroyed on its own, leaving its topics behind. NOT a service path: `deleteFact` and
 * `Fact.destroyCascade` take the topics with the fact, so no service writes this shape any more. It
 * is the state `destroyOrphanedTopics` repairs on devices that deleted facts before the cascade was
 * fixed, so the repair can only be exercised by building the state.
 */
export async function destroyFactRowOnly(factId: string): Promise<void> {
  const row = await database.get('facts').find(factId);
  await database.write(async () => {
    await row.destroyPermanently();
  });
}

// ---------------------------------------------------------------------------
// Suggestions (the purge consequence of a topic id set)
// ---------------------------------------------------------------------------

/** A hydrated article, minimal. */
function article(id: string): ArticleWithClusters {
  return {
    __typename: 'ArticleWithClusters',
    _id: id,
    clusters: [],
    title: `Story ${id}`,
    title_en: `Story ${id}`,
    description_en: `Details of story ${id}`,
    article_url: `https://example.com/${id}`,
    image_url: null,
    country_code: null,
    publication_name: `Pub ${id}`,
    language_code: 'en',
    pubDate: new Date(Date.now() - 3_600_000).toISOString(),
    geo_tags: [],
    entities: [],
    event_type: null,
    category: null,
    maxClusterSize: 1,
  } as unknown as ArticleWithClusters;
}

/** A stored suggestion retrieved by the given topic (id + text), as feed-sync persists it. */
export async function seedSuggestion(articleId: string, topic: { id: string; text: string }): Promise<void> {
  await persistAndLinkV2Suggestions([article(articleId)], new Map(), {
    matchedTopics: new Map([[articleId, [{ topicId: topic.id, text: topic.text }]]]),
  });
}

export async function suggestionIds(): Promise<string[]> {
  return (await loadSuggestions()).map((s) => s._id).sort();
}

// ---------------------------------------------------------------------------
// Fault injection on the real database (R23 / R26)
// ---------------------------------------------------------------------------

export { failBatchWhere, failTableQuery, until } from '../../support/faults';

// ---------------------------------------------------------------------------
// Waiting on an observable
// ---------------------------------------------------------------------------

/** Collects emissions of an rxjs observable until the returned `stop()`. */
export function collect<T>(observable: { subscribe(next: (v: T) => void): { unsubscribe(): void } }) {
  const seen: T[] = [];
  const sub = observable.subscribe((v) => seen.push(v));
  return { seen, stop: () => sub.unsubscribe() };
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

const bodyWatchers: (() => void)[] = [];

/** Raw JSON bodies of every request to `pathname` from now on (what the client sent, before the mock decrypts). */
export function watchBodies(pathname: string) {
  const seen: Promise<any>[] = [];
  const listener = ({ request }: { request: Request }) => {
    if (new URL(request.url).pathname === pathname) seen.push(request.clone().json());
  };
  server.events.on('request:start', listener);
  bodyWatchers.push(() => server.events.removeListener('request:start', listener));
  return { count: () => seen.length, bodies: () => Promise.all(seen) };
}
