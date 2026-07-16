// news-harness — dependency ports.
//
// The harness contains only pure AI-flow logic. Everything RN-coupled (logging
// through Sentry, cloud LLM calls, GraphQL, WatermelonDB persistence, the
// persona store) is injected through the interfaces below so the harness never
// imports lib/logger, lib/config/endpoints, lib/database/*, lib/stores/*, or any
// expo/react-native/watermelondb/zustand module.

import type {
  BatchCall,
  BatchCompletionResult,
  Fact,
  HarnessArticle,
} from './types';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface HarnessLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/** Default no-op logger — harness functions log nothing unless a real logger is
 *  injected by the app layer. */
export const NOOP_LOGGER: HarnessLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LlmPort {
  batchComplete(
    calls: BatchCall[],
    opts?: { model?: string },
  ): Promise<BatchCompletionResult[]>;
  complete(req: {
    systemPrompt: string;
    prompt: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// News API
// ---------------------------------------------------------------------------

export interface NewsApiPort {
  getArticleIdsForTopics(
    topics: { topicText: string; cursor?: string }[],
    opts?: { limitPerTopic?: number },
  ): Promise<{
    results: {
      topicText: string;
      articleIds: string[];
      hasNextPage: boolean;
      nextCursor?: string | null;
    }[];
  }>;
  getArticlesForTopicsByIds(articleIds: string[]): Promise<{
    articles: HarnessArticle[];
    dailyLimitReached: boolean;
    resetAt?: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Persona store
// ---------------------------------------------------------------------------

export interface PersonaStorePort {
  getFacts(): Promise<Fact[]>;
  updateFactMetadata(
    id: string,
    metadata: Record<string, string[]>,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Suggestion sink
// ---------------------------------------------------------------------------

export interface SuggestionSinkPort {
  saveScores(
    entries: { id: string; relevance: number; rawScore: number }[],
  ): Promise<void>;
  saveReasons(entries: { id: string; reason: string }[]): Promise<void>;
}
