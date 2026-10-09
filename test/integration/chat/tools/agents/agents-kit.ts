// Shared kit for the chat-agent seam tests. Not a test file (Jest matches *.test.ts only).
//
// The agents read the app-language, mera-protocol and floating-chat stores at call time, so a test
// moves them with the stores' own state. Rows are read back through the app's own services; the
// queue table has no list read, so `queuedJobs` queries the collection read-only.
import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import type InferenceJob from '@/lib/database/models/InferenceJob';
import {
  loadSuggestions,
  persistAndLinkV2Suggestions,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { createTopics, getActive as getActiveTopics } from '@/lib/database/services/topic-service';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import type { StagedProposal } from '@/lib/llm/types';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import logger from '@/lib/logger';
import { FIXTURE_ACCOUNT, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, setProcessingMode, setWebSearchInChat } from '@/test/integration/chat/_helpers';

/** The per-test starting point: English, cloud, web search off, nothing pending, signed in as the fixture account. */
export async function resetAgentWorld(): Promise<void> {
  resetChatModules();
  useAppLanguageStore.setState({ appLanguage: 'en' });
  useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId, userPersona: null });
  await signInFixtureAccount();
  await setProcessingMode('cloud');
  await setWebSearchInChat(false);
}

export const setLanguage = (code: string): void => useAppLanguageStore.setState({ appLanguage: code });

export const setProposal = (proposal: StagedProposal | null): void => useFloatingChatStore.getState().setProposal(proposal);

export const toolNames = (agent: { getToolDefinitions(): { function: { name: string } }[] }): string[] =>
  agent.getToolDefinitions().map((t) => t.function.name);

/** A call-through spy on the real logger's `warn` (the agents report refusals there). */
export const spyWarn = () => jest.spyOn(logger, 'warn');

// ---- reading back what an agent (or the executor behind it) wrote ------------------------------

export const factStatements = async (): Promise<string[]> => (await getFacts()).map((f) => f.statement);

/** Rows of the persisted inference queue, oldest first. */
export async function queuedJobs(): Promise<{ type: string; status: string }[]> {
  const rows = await database.get<InferenceJob>('inference_jobs').query(Q.sortBy('created_at', Q.asc)).fetch();
  return rows.map((r) => ({ type: r.jobType, status: r.status }));
}

/** Texts of the active topics. A tracked story mints one, so this is "did anything get followed". */
export const activeTopicTexts = async (): Promise<string[]> => (await getActiveTopics()).map((t) => t.text);

/** Rows in the followed-stories table. */
export const trackedStoryCount = (): Promise<number> => database.get('tracked_stories').query().fetchCount();

// ---- seeding through the app's own persist paths ------------------------------------------------

export interface SeededSuggestion {
  /** The local `article_suggestions` row id (what the agent's `suggestionId` target is). */
  suggestionId: string;
  /** The server article id. */
  articleId: string;
}

/** One fact with active topics under it; returns the fact id and the topic ids a suggestion links through. */
export async function seedFactWithTopics(
  statement: string,
  topicTexts: string[],
  metadata?: Record<string, string[]>,
): Promise<{ factId: string; topics: { topicId: string; text: string }[] }> {
  const fact = await addFact(statement, metadata);
  const rows = await createTopics(topicTexts.map((text) => ({ factId: fact.id, text, weight: 1 })));
  return { factId: fact.id, topics: rows.map((t) => ({ topicId: t.id, text: t.text })) };
}

/** An `article_suggestions` row as feed-sync writes it, optionally matched to topics and scored. */
export async function seedSuggestion(opts: {
  articleId: string;
  title_en?: string;
  description_en?: string;
  publication_name?: string;
  /** The article's category and named entities, as the sync stores them (the feedback context reads both). */
  category?: string;
  entities?: string[];
  matchedTopics?: { topicId: string; text: string }[];
  /** Give the row a final score the way the scorer does (terminal `complete`, no note owed). Omit it for an unscored row. */
  relevance?: number;
  /** With `relevance`: the note the scorer wrote. Omitted, the row is scored with no note owed. */
  reason?: string;
}): Promise<SeededSuggestion> {
  const row = {
    _id: opts.articleId,
    title: opts.title_en ?? 'Headline',
    title_en: opts.title_en ?? 'Headline',
    description_en: opts.description_en ?? 'A description.',
    publication_name: opts.publication_name ?? 'Euronews',
    country_code: 'DEU',
    language_code: 'en',
    article_url: 'https://example.com/story',
    pubDate: new Date(Date.now() - 2 * 3600_000).toISOString(),
    category: opts.category,
    entities: opts.entities,
    clusters: [],
  } as unknown as ArticleWithClusters;
  await persistAndLinkV2Suggestions([row], new Map(), {
    matchedTopics: new Map([[opts.articleId, opts.matchedTopics ?? []]]),
  });
  const stored = (await loadSuggestions()).find((s) => s.articleId === opts.articleId);
  if (!stored) throw new Error(`seedSuggestion: ${opts.articleId} not stored`);
  if (opts.relevance !== undefined) {
    await saveScoringResult(stored._id, {
      relevance: opts.relevance,
      reason: opts.reason ?? '',
      reasonSkipped: opts.reason === undefined,
    });
  }
  return { suggestionId: stored._id, articleId: opts.articleId };
}

/** Adds facts one millisecond apart: `getFacts()` sorts by `created_at`, and rows written inside one
 *  millisecond tie, which would make "newest first" a coin flip. */
export async function addFactsInOrder(statements: string[], attribute?: string): Promise<void> {
  for (const statement of statements) {
    await addFact(statement, undefined, attribute ? { attribute } : undefined);
    await new Promise((r) => setTimeout(r, 2));
  }
}
