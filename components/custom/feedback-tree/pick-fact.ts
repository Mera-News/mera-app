// The reader's fact a story matched: the one with the most of the story's
// matched topics (ties: the first). A fact's own topic count says nothing.
// Pure: the fact shape is declared here so no store or DB is imported.
import { primaryStatement } from '@/lib/stores/fact-rows-selector';

export interface PickableFact {
  id: string;
  statement: string;
  metadata?: { topics?: string[] | null } | null;
}

export function pickMatchedFact(
  facts: readonly PickableFact[],
  matchedTopicIds: readonly string[],
): { id: string; statement: string; topicIds: string[] } | null {
  const matched = new Set(matchedTopicIds);
  let best: PickableFact | null = null;
  let bestCount = 0;
  for (const f of facts) {
    const n = (f.metadata?.topics ?? []).filter((id) => matched.has(id)).length;
    if (n > bestCount) {
      best = f;
      bestCount = n;
    }
  }
  if (!best) return null;
  return {
    id: best.id,
    statement: primaryStatement(best.statement),
    topicIds: [...(best.metadata?.topics ?? [])],
  };
}
