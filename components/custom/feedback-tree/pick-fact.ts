// The reader's fact a story matched: the one with the most matched topics.
// Pure: the fact shape is declared here so no store or DB is imported.
import { primaryStatement } from '@/lib/stores/fact-rows-selector';

export interface PickableFact {
  id: string;
  statement: string;
  metadata?: { topics?: string[] | null } | null;
}

export function pickMatchedFact(
  facts: readonly PickableFact[],
): { id: string; statement: string; topicIds: string[] } | null {
  let best: PickableFact | null = null;
  let bestCount = 0;
  for (const f of facts) {
    const n = f.metadata?.topics?.length ?? 0;
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
