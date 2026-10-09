// Seeding for the story-grouping seam tests: article_suggestions rows go in through the app's own
// persist and scoring paths (persistAndLinkV2Suggestions, saveScoringResult), then are read back
// through the model the way the gate's callers see them.
import '@/test/helpers';
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import {
  persistAndLinkV2Suggestions,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';

export interface GroupRowSpec {
  id: string;
  title?: string | null;
  clusters?: { clusterId: string; confidence: number; stableClusterId?: string }[];
  hasDescription?: boolean;
  firstPubDateMs?: number;
  countryCode?: string | null;
  languageCode?: string | null;
}

// Every description shares the content words "reason" and "old" with the reasons these tests
// propagate, so the grounding check in batchPropagateScores (one shared content token) keeps them.
const DESCRIPTION = 'reason old';

/** A row that groups with every other default row: one shared cluster at confidence 0.9. */
export const SHARED_CLUSTER = [{ clusterId: 'c1', confidence: 0.9 }];

/** A row that groups only with itself: a unique cluster id and no title tokens. */
export const loneClusters = (id: string) => [{ clusterId: `lone-${id}`, confidence: 0.9 }];

function toArticle(spec: GroupRowSpec): ArticleWithClusters {
  return {
    _id: spec.id,
    title_en: spec.title ?? '',
    title: spec.title ?? '',
    description_en: (spec.hasDescription ?? true) ? DESCRIPTION : null,
    pubDate: new Date(spec.firstPubDateMs ?? 1_000).toISOString(),
    country_code: spec.countryCode ?? null,
    language_code: spec.languageCode ?? null,
    clusters: spec.clusters ?? SHARED_CLUSTER,
  } as unknown as ArticleWithClusters;
}

/** Insert rows as `unscored`, which is what feed-sync hydration writes. */
export async function seedUnscored(...specs: GroupRowSpec[]): Promise<void> {
  await persistAndLinkV2Suggestions(specs.map(toArticle), new Map());
}

export interface DonorScore {
  relevance: number;
  reason: string;
  /** Scored above the render gate with the reason still owed (`reason_pending`). */
  pending?: boolean;
  computedScore?: number;
  rawScore?: number;
}

/** Insert a row, then score it through `saveScoringResult`, so it is a donor the way a scored row is. */
export async function seedScored(spec: GroupRowSpec, score: DonorScore): Promise<void> {
  await seedUnscored(spec);
  await saveScoringResult(spec.id, {
    relevance: score.relevance,
    reason: score.reason,
    reasonSkipped: score.reason === '' && !score.pending,
    ...(score.computedScore !== undefined ? { computedScore: score.computedScore } : {}),
    ...(score.rawScore !== undefined ? { rawScore: score.rawScore } : {}),
  });
}

export function suggestionRow(id: string): Promise<ArticleSuggestionModel> {
  return database.get<ArticleSuggestionModel>('article_suggestions').find(id);
}

/** What a caller of the gate can observe on a row: the score it carries and where it sits. */
export async function scoreOf(id: string) {
  const r = await suggestionRow(id);
  return { relevance: r.relevance, reason: r.reason, status: r.status };
}

/**
 * A view-only impression (`opened = false`). recordOpen is the only writer today; a row like this
 * is what an older build left on the device, and it ages out within 30 days.
 */
export async function seedViewOnlyImpression(articleId: string): Promise<void> {
  await database.write(async () => {
    await database.get('story_impressions').create((r: any) => {
      r.articleId = articleId;
      r.stableClusterId = null;
      r.suggestionId = null;
      r.titleNorm = null;
      r.surface = 'feed';
      r.opened = false;
      r.firstSeenAt = new Date();
      r.lastSeenAt = new Date();
      r.seenCount = 1;
    });
  });
}
