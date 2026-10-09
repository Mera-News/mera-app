// Seeding for the core/sync seam tests: article_suggestions, facts and topics go in through the
// app's own services, never as hand-written rows.
// Load the harness helpers at file-load time: jest.setup.integration.js otherwise requires them inside
// the first beforeEach, and test/helpers/screen.ts registers @testing-library hooks on load, which
// Jest refuses once a test is running.
import '@/test/helpers';
import database from '@/lib/database';
import type { PersonaSuppressionKind } from '@/lib/database/models/PersonaSuppression';
import {
  loadSuggestions,
  persistAndLinkV2Suggestions,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import { addSuppression } from '@/lib/database/services/suppression-service';
import logger from '@/lib/logger';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { addFact } from '@/lib/database/services/fact-service';
import { createTopics } from '@/lib/database/services/topic-service';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';

export interface SeedArticle {
  id: string;
  title?: string;
  description?: string | null;
  publication?: string | null;
  countryCode?: string | null;
  category?: string | null;
  geoTags?: { city?: string; countryCode: string }[];
  entities?: string[];
  headlineScope?: 'CITY' | 'COUNTRY' | 'GLOBAL';
  matchedTopics?: { topicId: string | null; text: string }[];
  clusterId?: string;
  stableClusterId?: string;
}

/** One fact with one active topic; returns the ids a seeded article links through. */
export async function seedFactWithTopic(statement: string, topicText: string) {
  const fact = await addFact(statement);
  const [topic] = await createTopics([{ factId: fact.id, text: topicText, weight: 1 }]);
  return { factId: fact.id, topicId: topic.id, topicText };
}

/** Insert articles as `unscored` rows (what feed-sync hydration writes). */
export async function seedArticles(articles: SeedArticle[]): Promise<void> {
  const fetched = articles.map(
    (a) =>
      ({
        _id: a.id,
        title: a.title ?? `Title ${a.id}`,
        title_en: a.title ?? `Title ${a.id}`,
        description_en: a.description === undefined ? `Description ${a.id}` : a.description,
        publication_name: a.publication ?? null,
        country_code: a.countryCode ?? null,
        language_code: 'en',
        category: a.category ?? null,
        geo_tags: a.geoTags ?? null,
        entities: a.entities ?? null,
        pubDate: new Date(Date.now() - 2 * 3600_000).toISOString(),
        clusters: a.clusterId
          ? [{ clusterId: a.clusterId, confidence: 0.9, stableClusterId: a.stableClusterId }]
          : [],
      }) as unknown as ArticleWithClusters,
  );
  await persistAndLinkV2Suggestions(fetched, new Map(), {
    matchedTopics: new Map(articles.map((a) => [a.id, a.matchedTopics ?? []])),
    headlineScope: new Map(
      articles.flatMap((a) => (a.headlineScope ? [[a.id, a.headlineScope] as [string, string]] : [])),
    ),
  });
}

/** Every stored row as the Feed sees it, keyed by article id (`status`, `relevance`, ...). */
export async function suggestionRows(): Promise<Record<string, ForYouSuggestion>> {
  return Object.fromEntries((await loadSuggestions()).map((s) => [s._id, s]));
}

/** Give a row a final score the way the scorer does: terminal `complete`, no note owed. */
export async function scoreRow(id: string, relevance: number): Promise<void> {
  await saveScoringResult(id, { relevance, reason: '', reasonSkipped: true });
}

/** An active hard "not interested" filter (strength 1). Returns the suppression id. */
export async function addHardFilter(
  input: { keyword: string } | { kind: PersonaSuppressionKind; value: string },
): Promise<string> {
  const s =
    'keyword' in input
      ? await addSuppression({
          pattern: input.keyword,
          keywords: [input.keyword],
          strength: 1,
          source: 'chat',
        })
      : await addSuppression({
          pattern: input.value,
          strength: 1,
          source: 'chat',
          kind: input.kind,
          value: input.value,
        });
  return s.id;
}

/** Silence the real logger's console output and expose the two capture channels. */
export function quietLogger() {
  const spies = (['info', 'warn', 'error', 'debug'] as const).map((m) =>
    jest.spyOn(logger, m).mockImplementation(() => {}),
  );
  const captureException = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
  const captureMessage = jest.spyOn(logger, 'captureMessage').mockImplementation(() => '');
  return {
    captureException,
    captureMessage,
    restore: () => [...spies, captureException, captureMessage].forEach((s) => s.mockRestore()),
  };
}

/** Fault injection one level below the services: the next unfiltered read of a table throws.
 *  (`loadSuggestions` is the unfiltered reader of article_suggestions; scoring queries carry a `Q.where`.) */
export function failUnfilteredReads(table: string, error: Error): () => void {
  const collection = database.get(table);
  const original = collection.query.bind(collection);
  const spy = jest.spyOn(collection, 'query').mockImplementation(((...conditions: unknown[]) => {
    if (conditions.length === 0) throw error;
    return original(...(conditions as Parameters<typeof original>));
  }) as typeof collection.query);
  return () => spy.mockRestore();
}

/** Make every read of a table throw (e.g. the persona snapshot cannot be loaded). */
export function failAllReads(table: string, error: Error): () => void {
  const collection = database.get(table);
  const spy = jest.spyOn(collection, 'query').mockImplementation((() => {
    throw error;
  }) as typeof collection.query);
  return () => spy.mockRestore();
}

/** The For You store back to a blank slate (module state is not reset between tests). */
export function resetForYouStore(): void {
  useForYouStore.setState({
    suggestions: [],
    articleCount: 0,
    relevantArticleCount: 0,
    unscoredCount: 0,
    isDeviceProcessing: false,
    deviceProcessProgress: 0,
    deviceProcessedCount: 0,
    deviceTotalCount: 0,
    scoringError: null,
    lastProcessingRunFinishedAt: null,
  });
}

/** Wait for every queued DB write, including the fire-and-forget ones (`setCounts` persists feed
 *  metadata without being awaited). A test that ends with a write in flight strands the next
 *  test's DB reset. */
export async function settleWrites(): Promise<void> {
  await database.write(async () => {});
}
