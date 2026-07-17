// Fact-Stats Service — WatermelonDB adapter for the persona hygiene stat cores
// (Wave 8 plan A5). Loads plain projections from the local DB and delegates the
// aggregation to the pure cores in
// lib/news-harness/feed-select/fact-stats.ts. No aggregation logic lives here.

import * as articleSuggestionService from './article-suggestion-service';
import * as storyImpressionService from './story-impression-service';
import * as topicService from './topic-service';
import {
  getFactSectionStats as computeFactSectionStats,
  getTopicYieldStats as computeTopicYieldStats,
  findTopicOverlapAcrossFacts as computeTopicOverlap,
  type FactStatSuggestion,
  type FactStatTopicInfo,
  type FactStatImpression,
  type FactStatTopic,
  type FactSectionStats,
  type TopicYieldStats,
  type TopicOverlapGroup,
} from '../../news-harness/feed-select/fact-stats';

/** All cached suggestions → the pure stat-core projection. `matched_topics_json`
 *  is already parsed into `matchedTopics` by loadSuggestions; map defensively. */
async function loadSuggestionProjections(): Promise<FactStatSuggestion[]> {
  const rows = await articleSuggestionService.loadSuggestions();
  return rows.map((s) => {
    const pubMs = Date.parse(s.firstPubDate);
    return {
      id: s._id,
      articleId: s.articleId,
      rawScore: s.rawScore ?? null,
      pubDateMs: Number.isFinite(pubMs) ? pubMs : 0,
      matchedTopics: (s.matchedTopics ?? []).map((m) => ({
        topicId: m?.topicId ?? null,
      })),
    };
  });
}

/** Active topics → the join map + the per-fact-count list (one fetch, two views). */
async function loadTopicProjections(): Promise<{
  topicMap: Map<string, FactStatTopicInfo>;
  topicList: FactStatTopic[];
}> {
  const topics = await topicService.getActive();
  const topicMap = new Map<string, FactStatTopicInfo>();
  const topicList: FactStatTopic[] = [];
  for (const t of topics) {
    topicMap.set(t.id, {
      factId: t.factId ?? null,
      weight: t.weight,
      status: t.status,
      lastSignalAtMs: t.lastSignalAt ?? null,
    });
    topicList.push({
      id: t.id,
      factId: t.factId ?? null,
      weight: t.weight,
      status: t.status,
    });
  }
  return { topicMap, topicList };
}

/** articleId → impression (opened). */
async function loadImpressionProjections(): Promise<Map<string, FactStatImpression>> {
  const rows = await storyImpressionService.getAll();
  const out = new Map<string, FactStatImpression>();
  for (const r of rows) out.set(r.articleId, { opened: r.opened === true });
  return out;
}

/** Per-fact hygiene stats (starving-section digest input). */
export async function getFactSectionStats(): Promise<Map<string, FactSectionStats>> {
  const [suggestions, topicProjections, impressions] = await Promise.all([
    loadSuggestionProjections(),
    loadTopicProjections(),
    loadImpressionProjections(),
  ]);
  return computeFactSectionStats({
    suggestions,
    topics: topicProjections.topicMap,
    impressions,
    topicList: topicProjections.topicList,
  });
}

/** Per-topic yield (too-broad-topic digest input). */
export async function getTopicYieldStats(): Promise<Map<string, TopicYieldStats>> {
  const suggestions = await loadSuggestionProjections();
  return computeTopicYieldStats(suggestions);
}

/** Cross-fact normalized-text overlap (duplicate-topic digest input). */
export async function findTopicOverlapAcrossFacts(): Promise<TopicOverlapGroup[]> {
  const topics = await topicService.getActive();
  return computeTopicOverlap(
    topics.map((t) => ({
      id: t.id,
      factId: t.factId ?? null,
      normalizedText: t.normalizedText,
    })),
  );
}
