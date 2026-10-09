// Shared by the article_suggestions seam tests (data-U10a). Not a test file.
//
// Rows land the way a real sync lands them: `persistAndLinkV2Suggestions`, then the scoring
// writers move them along the status machine. `bareRow` exists only for shapes no service
// writes (corrupt JSON columns, a duplicate join row, a stale country on a GLOBAL headline);
// every call site says which shape and why.
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import type ArticleSuggestionFactModel from '@/lib/database/models/ArticleSuggestionFact';
import {
  batchMarkExcluded,
  batchMarkGateSkipped,
  batchPropagateScores,
  persistAndLinkV2Suggestions,
  saveScoringResult,
  type MatchedTopicMeta,
  type PersonaPersistMeta,
} from '@/lib/database/services/article-suggestion-service';
import { addFact } from '@/lib/database/services/fact-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { batchMarkAlreadyRead } from '@/lib/feed-grouping/read-story-filter';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import { useStrictClock as strictClockAt } from '@/test/helpers'; // aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The fixed "now" every test starts on (strict clock: time moves only when a test says so). */
export const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

export const freezeClock = (now: number = T0): void => strictClockAt(now);

/** The note a row is allowed to carry: shares "harbour" with `article()`'s default text. */
export const GROUNDED = 'The harbour report matters to you.';
/** Shares no content token with `article()`'s default text, so the grounding check drops it. */
export const FOREIGN =
  "New AI Act rules on deepfakes directly impact your AI news app's compliance requirements.";

/** A hydrated article. Default text carries "harbour"; `pubDate` is one hour before the current clock. */
export function article(id: string, over: Partial<ArticleWithClusters> = {}): ArticleWithClusters {
  return {
    __typename: 'ArticleWithClusters',
    _id: id,
    clusters: [],
    title: `Original ${id} harbour`,
    title_en: `Quarterly harbour report ${id}`,
    description_en: `Harbour details ${id}`,
    article_url: `https://example.com/${id}`,
    image_url: null,
    country_code: 'NLD',
    publication_name: 'Test Pub',
    language_code: 'en',
    pubDate: new Date(Date.now() - HOUR).toISOString(),
    geo_tags: [],
    entities: [],
    event_type: null,
    category: null,
    maxClusterSize: 1,
    ...over,
  } as ArticleWithClusters;
}

export interface PersonaInput {
  /** article id -> the topics it matched */
  topics?: Record<string, MatchedTopicMeta[]>;
  headline?: Record<string, string>;
  headlineCountry?: Record<string, string>;
  stable?: Record<string, string>;
}

export function personaMeta(input: PersonaInput = {}): PersonaPersistMeta {
  return {
    matchedTopics: new Map(Object.entries(input.topics ?? {})),
    headlineScope: new Map(Object.entries(input.headline ?? {})),
    headlineCountryCode: new Map(Object.entries(input.headlineCountry ?? {})),
    stableClusterId: new Map(Object.entries(input.stable ?? {})),
  };
}

/** Persist through the persona path (what a real sync does). */
export function seed(articles: ArticleWithClusters[], input: PersonaInput = {}) {
  return persistAndLinkV2Suggestions(articles, new Map(), personaMeta(input));
}

/** Persist through the legacy path: topic texts per article, facts linked via `fact.metadata.topics`. */
export function seedLegacy(articles: ArticleWithClusters[], texts: Record<string, string[]>) {
  return persistAndLinkV2Suggestions(articles, new Map(Object.entries(texts)));
}

// ---------------------------------------------------------------------------
// Moving a row along the status machine, through the real writers
// ---------------------------------------------------------------------------

export const toReasonPending = (id: string, relevance = 0.8) =>
  saveScoringResult(id, { relevance, reason: '', reasonSkipped: false });
export const toComplete = (id: string, relevance = 0.8, reason = GROUNDED) =>
  saveScoringResult(id, { relevance, reason, reasonSkipped: false });
export const toExcluded = (id: string) => batchMarkExcluded([id], T0);
export const toAlreadyRead = (id: string) => batchMarkAlreadyRead([id], T0);
export const toReasonSkipped = (id: string) => batchMarkGateSkipped([id]);
/** The only producer of `scored_with_v3 = true`: a donor's vintage travels with an inherited score. */
export const withVintage = (id: string, relevance: number, scoredWithV3: boolean | null, reason = GROUNDED) =>
  batchPropagateScores([{ id, relevance, reason, scoredWithV3 }]);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const suggestions = () => database.get<ArticleSuggestionModel>('article_suggestions');
const links = () => database.get<ArticleSuggestionFactModel>('article_suggestion_facts');

export const row = (id: string) => suggestions().find(id);
export const allRows = () => suggestions().query().fetch();
export const allLinks = () => links().query().fetch();
export const rowCount = async () => (await allRows()).length;
export const statusOf = async (id: string) => (await row(id)).status;
export const idsInDb = async () => (await allRows()).map((r) => r.id).sort();

/** Fact ids linked to a suggestion. */
export async function factsOf(id: string): Promise<string[]> {
  return (await allLinks()).filter((l) => l.articleSuggestionId === id).map((l) => l.factId).sort();
}

// ---------------------------------------------------------------------------
// Bare rows: ONLY for shapes no service writes
// ---------------------------------------------------------------------------

type RowFields = Partial<
  Pick<
    ArticleSuggestionModel,
    | 'articleId'
    | 'status'
    | 'relevance'
    | 'reason'
    | 'publicationName'
    | 'titleEn'
    | 'titleOriginal'
    | 'descriptionEn'
    | 'clusterMembershipsJson'
    | 'matchedTopicTextsJson'
    | 'matchedTopicsJson'
    | 'geoTagsJson'
    | 'entitiesJson'
    | 'headlineScope'
    | 'headlineCountryCode'
    | 'stableClusterId'
    | 'scoredAt'
  >
> & { createdAt?: Date; firstPubDate?: Date };

export async function bareRow(id: string, over: RowFields = {}): Promise<ArticleSuggestionModel> {
  return database.write(() =>
    suggestions().create((r) => {
      r._raw.id = id;
      r.articleId = id;
      r.relevance = 0;
      r.reason = '';
      r.status = 'unscored';
      r.createdAt = new Date();
      r.firstPubDate = new Date();
      Object.assign(r, over);
    }),
  );
}

/** A join row. Every service dedupes, so a duplicate link can only be made by hand. */
export async function bareLink(articleSuggestionId: string, factId: string): Promise<void> {
  await database.write(() =>
    links().create((l) => {
      l.articleSuggestionId = articleSuggestionId;
      l.factId = factId;
      l.createdAt = new Date();
    }),
  );
}

/** One call to a real collection's `query` throws (R23). Restore with `spy.mockRestore()` in afterEach. */
export function failNextQuery(table: string, error = new Error(`${table} query failed (injected)`)): jest.SpyInstance {
  const collection = database.get(table) as unknown as { query: (...a: unknown[]) => unknown };
  return jest.spyOn(collection, 'query').mockImplementationOnce(() => {
    throw error;
  });
}

// ---------------------------------------------------------------------------
// Interests: a fact with topics, through the services (createTopics also appends each
// text to `fact.metadata.topics`)
// ---------------------------------------------------------------------------

export async function interest(statement: string, texts: string[]) {
  const fact = await addFact(statement);
  const topics = await createTopics(
    texts.map((text) => ({ factId: fact.id, text, weight: 1, highPriority: false, provenance: 'llm' as const })),
  );
  return { fact, topics };
}

/** The matched-topic entry a hydrate stores for a topic row. */
export const matched = (topic: { id: string; text: string }, vectorScore?: number | null): MatchedTopicMeta => ({
  topicId: topic.id,
  text: topic.text,
  ...(vectorScore !== undefined ? { vectorScore } : {}),
});
