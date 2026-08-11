// useTopicPlanResolutions (r14) — resolves a set of topic-plan cards against
// BOTH halves of the resolution state (session store + durable fact markers).
//
// Facts are not observable through a WatermelonDB query at this seam, so this
// reuses the app's existing fact-refresh signal the way TopicPlanCard already
// does: `factMutationVersion` bumps on every persona mutation (including this
// wave's Save/Discard), re-running the read.

import { getFacts } from '@/lib/database/services/fact-service';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import {
  useFloatingChatDiscardedTopicPlans,
  useFloatingChatFactMutationVersion,
  useFloatingChatSettledTopicPlans,
} from '@/lib/stores/floating-chat-store';
import { useEffect, useMemo, useState } from 'react';
import {
  resolveTopicPlan,
  unresolvedFactIds,
  type TopicPlanResolution,
} from './topic-plan-resolution';

export interface TopicPlanResolutions {
  resolutionOf: (factId: string) => TopicPlanResolution;
  /** Cards that must be acted on before the user may continue. */
  unresolved: string[];
}

export function useTopicPlanResolutions(factIds: string[]): TopicPlanResolutions {
  const settled = useFloatingChatSettledTopicPlans();
  const discarded = useFloatingChatDiscardedTopicPlans();
  const factMutationVersion = useFloatingChatFactMutationVersion();

  // `null` = not readable yet (in flight, or the read failed). Distinct from an
  // empty map, which legitimately means "every fact was deleted" — the former
  // must never block, the latter resolves every card as discarded.
  const [factsById, setFactsById] = useState<Map<string, Fact> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFacts()
      .then((facts) => {
        if (cancelled) return;
        setFactsById(new Map(facts.map((f) => [f.id, f])));
      })
      .catch(() => {
        // Keep the last known map. On a first-read failure it stays null, which
        // resolves to 'unknown' — deliberately fail-open (see
        // topic-plan-resolution.ts).
      });
    return () => {
      cancelled = true;
    };
  }, [factMutationVersion]);

  // `factIds` is rebuilt on every render by the caller, so depend on its CONTENT.
  const key = factIds.join('|');

  return useMemo(() => {
    const map = factsById;
    const resolutionOf = (factId: string): TopicPlanResolution =>
      resolveTopicPlan({
        factId,
        settled,
        discarded,
        factsLoaded: map !== null,
        fact: map?.get(factId),
      });
    return {
      resolutionOf,
      unresolved: unresolvedFactIds(key ? key.split('|') : [], {
        settled,
        discarded,
        factsLoaded: map !== null,
        factsById: map ?? new Map(),
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, settled, discarded, factsById]);
}
