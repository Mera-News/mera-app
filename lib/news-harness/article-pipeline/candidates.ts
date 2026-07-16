// news-harness — pure candidate-derivation logic.
//
// Mirrors the app's feed-sync + article-suggestion join semantics without any
// WatermelonDB / RN coupling:
//   - deriveTopicTexts        ↔ feed-sync-steps.ts::getLocalTopicTextsForPersona
//   - buildArticleToTopicTexts↔ feed-sync-steps.ts::stepFetchTopicIds (~l.81-89)
//   - buildCandidatesFromArticles ↔ article-suggestion-service.ts::
//        persistAndLinkV2Suggestions + resolveFactsByTopicTexts, producing the
//        exact ScoringCandidate shape getUnscoredSuggestionsWithFacts returns.

import type { Fact, HarnessArticle, ScoringCandidate } from '../core/types';

/**
 * Union of every `fact.metadata.topics` entry across all facts, deduped and with
 * empty strings filtered out. Order is first-seen insertion order (Set), exactly
 * like `getLocalTopicTextsForPersona` in feed-sync-steps.ts.
 */
export function deriveTopicTexts(facts: Fact[]): string[] {
  const texts = new Set<string>();
  for (const fact of facts) {
    for (const topic of fact.metadata?.topics ?? []) {
      if (topic.length > 0) texts.add(topic);
    }
  }
  return Array.from(texts);
}

/**
 * Invert the `articleIdsForTopics` response into an article-id → matched-topic-
 * texts map. Mirror of feed-sync-steps.ts::stepFetchTopicIds (~l.81-89): a topic
 * text is appended to an article's bucket in the order the results arrive, so an
 * article matched by several topics carries them in result order.
 */
export function buildArticleToTopicTexts(
  results: { topicText: string; articleIds: string[] }[],
): Map<string, string[]> {
  const articleToTopicTexts = new Map<string, string[]>();
  for (const result of results) {
    for (const id of result.articleIds) {
      const existing = articleToTopicTexts.get(id) ?? [];
      existing.push(result.topicText);
      articleToTopicTexts.set(id, existing);
    }
  }
  return articleToTopicTexts;
}

/**
 * Build the ScoringCandidate rows for a batch of hydrated articles.
 *
 * The fact join reproduces persistAndLinkV2Suggestions + resolveFactsByTopicTexts:
 *   1. Resolve, over the union of every article's matched topic texts, a
 *      topicText → factId[] map (facts iterated in input order, so factId order
 *      within a topic follows the fact bank order).
 *   2. Per article, union the fact ids of every matched topic text into a Set
 *      (insertion order = topic order, then fact-bank order), deduped globally —
 *      the same order the DB link rows (and hence relatedFacts) end up in.
 *
 * `userTopicIds` carries the article's matched topic texts, matching what
 * getUnscoredSuggestionsWithFacts reads back from `matchedTopicTextsJson`.
 */
export function buildCandidatesFromArticles(
  articles: HarnessArticle[],
  articleToTopicTexts: Map<string, string[]>,
  facts: Fact[],
): ScoringCandidate[] {
  // (1) topicText → factId[] over the union of all matched topic texts.
  const allTopicTexts = new Set<string>();
  for (const a of articles) {
    for (const t of articleToTopicTexts.get(a._id) ?? []) allTopicTexts.add(t);
  }
  const factsByTopicText = new Map<string, string[]>();
  for (const fact of facts) {
    for (const topic of fact.metadata?.topics ?? []) {
      if (allTopicTexts.has(topic)) {
        const bucket = factsByTopicText.get(topic) ?? [];
        bucket.push(fact.id);
        factsByTopicText.set(topic, bucket);
      }
    }
  }

  const factById = new Map(facts.map((f) => [f.id, f]));

  return articles.map((a) => {
    const topicTexts = articleToTopicTexts.get(a._id) ?? [];
    const linkedFactIds = new Set<string>();
    for (const topicText of topicTexts) {
      for (const factId of factsByTopicText.get(topicText) ?? []) {
        linkedFactIds.add(factId);
      }
    }
    const relatedFacts: { id: string; statement: string }[] = [];
    for (const factId of linkedFactIds) {
      const fact = factById.get(factId);
      if (fact) relatedFacts.push({ id: fact.id, statement: fact.statement });
    }
    return {
      id: a._id,
      titleEn: a.title_en ?? null,
      descriptionEn: a.description_en ?? null,
      countryCode: a.country_code ?? null,
      userTopicIds: topicTexts,
      relatedFacts,
    };
  });
}
