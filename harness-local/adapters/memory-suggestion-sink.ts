// harness-local — in-memory SuggestionSinkPort implementation. Article-pipeline
// scoring/reason results accumulate here for the run-writer to persist to
// .local-test-data/runs/<label>/scores.json (owned by the parallel agent).

import type { SuggestionSinkPort } from '@/lib/news-harness/core/ports';

export function createMemorySink(): SuggestionSinkPort & {
  getScores(): { id: string; relevance: number; rawScore: number }[];
  getReasons(): { id: string; reason: string }[];
} {
  const scoresById = new Map<string, { id: string; relevance: number; rawScore: number }>();
  const reasonsById = new Map<string, { id: string; reason: string }>();

  return {
    async saveScores(entries) {
      for (const entry of entries) {
        scoresById.set(entry.id, entry);
      }
    },
    async saveReasons(entries) {
      for (const entry of entries) {
        reasonsById.set(entry.id, entry);
      }
    },
    getScores() {
      return Array.from(scoresById.values());
    },
    getReasons() {
      return Array.from(reasonsById.values());
    },
  };
}
