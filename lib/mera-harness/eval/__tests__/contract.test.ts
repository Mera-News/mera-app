// Keeps the eval's mirror of the core's private mappings honest by DRIVING the
// core, not by reading it. A mirror checked against a copy of the thing it
// mirrors proves nothing.

import { createAgentState, runAgentTurn } from '../../core/core';
import { PERSONA_SKILL_IDS } from '../../skills/index.generated';
import { NO_ROUTE_KIND, routeKindForSkill, routeKindsFor } from '../contract';
import type { AgentDeps, AgentModelResult } from '../contract';

function modelThatLoads(skillId: string) {
  let call = 0;
  return async (): Promise<AgentModelResult> => {
    call += 1;
    return {
      content: call === 1 ? '' : 'Done.',
      toolCalls: call === 1 ? [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: skillId }) }] : [],
      finishReason: 'stop', truncated: false, usage: null, modelSent: 'm',
      latencyMs: 1, ttVisibleMs: null, error: null,
    };
  };
}

function deps(skillId: string): AgentDeps {
  return {
    callModel: modelThatLoads(skillId),
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'unavailable' as const }),
      saveExtractedFacts: async () => ({}),
      deleteUserFacts: async () => ({}),
    },
    loadSkill: (id) => (PERSONA_SKILL_IDS.includes(id as never) ? `body of ${id}` : null),
    skillIds: () => PERSONA_SKILL_IDS,
  };
}

describe('routeKindForSkill mirrors the core', () => {
  it.each(PERSONA_SKILL_IDS)('agrees with the real loop for %s', async (skillId) => {
    const state = createAgentState({ facts: [], surface: 'CONFIG' });
    const result = await runAgentTurn({ state, userMessage: 'hello', deps: deps(skillId), model: 'm' });
    // The core returns null for "no kind"; a fixture spells that `none`.
    const actual = result.routeKind ?? NO_ROUTE_KIND;
    expect(actual).toBe(routeKindForSkill(skillId));
  });

  it('POSITIVE CONTROL: the mirror is not a constant', () => {
    // If routeKindForSkill ever collapsed to one value the per-id checks above
    // would still pass wherever the core collapsed too. This pins that it
    // genuinely discriminates.
    const kinds = routeKindsFor(PERSONA_SKILL_IDS);
    expect(kinds.length).toBeGreaterThan(3);
    expect(kinds).toContain(NO_ROUTE_KIND);
    expect(kinds).toContain('residence');
  });

  it('maps a slash-less id and a generic leaf to the SAME no-kind value', () => {
    // Both are "no kind" in the core, and a fixture must be able to say so.
    expect(routeKindForSkill('router')).toBe(NO_ROUTE_KIND);
    expect(routeKindForSkill('facts/generic')).toBe(NO_ROUTE_KIND);
    expect(routeKindForSkill('facts/residence')).toBe('residence');
  });
});
