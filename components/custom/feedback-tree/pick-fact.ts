// The reader's fact a story matched, among the CANDIDATES the caller found
// (the story's linked facts, else the facts holding its topic texts): the one
// holding the most of the story's matched topic texts, ties to the first.
// Compare TEXTS: a fact's metadata.topics holds texts, never topic ids.
// Pure: the fact shape is declared here so no store or DB is imported.
import { primaryStatement } from '@/lib/stores/fact-rows-selector';

export interface PickableFact {
  id: string;
  statement: string;
  metadata?: { topics?: string[] | null } | null;
}

export function pickMatchedFact(
  facts: readonly PickableFact[],
  matchedTopicTexts: readonly string[],
): { id: string; statement: string; topicTexts: string[] } | null {
  const matched = new Set(matchedTopicTexts);
  let best: PickableFact | null = null;
  let bestCount = -1;
  for (const f of facts) {
    const n = (f.metadata?.topics ?? []).filter((text) => matched.has(text)).length;
    if (n > bestCount) {
      best = f;
      bestCount = n;
    }
  }
  if (!best) return null;
  return {
    id: best.id,
    statement: primaryStatement(best.statement),
    topicTexts: [...(best.metadata?.topics ?? [])],
  };
}
