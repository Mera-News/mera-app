// Wave 14 — structural "no divergence" parity test for the judge seam.
//
// The E2EE pipeline builds its judge calls via buildJudgeCalls (judge-calls.ts)
// at SUBMIT time; the sync orchestrator builds them inline inside computeAndJudge
// (run-stage.ts). Both claim to share the EXACT framing. This test proves it:
// for the same candidates/persona/config, the BatchCalls captured from
// computeAndJudge's LlmPort must be deep-equal (id, system, prompt, temperature,
// maxTokens, chunking) to what buildJudgeCalls produces.

import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import type { LlmPort } from '../../core/ports';
import type { BatchCall } from '../../core/types';
import { computeAndJudge, type StageCandidate } from '../run-stage';
import { buildJudgeCalls } from '../judge-calls';
import type { PersonaScoringContext } from '../persona-context';
import type { ScoredCandidateInput } from '../relevance';

const NOW_MS = 1_752_700_000_000; // fixed for freshness determinism

const persona: PersonaScoringContext = {
  locations: [
    { id: 'loc-1', city: 'bhopal', countryCode: 'IN', role: 'family', weight: 1 },
  ],
  pubPrefs: new Map(),
  softSuppressions: [],
};

/** Math-mode candidate (has eventType ⇒ never backstop). */
function candidate(i: number): ScoredCandidateInput {
  return {
    id: `art-${i}`,
    titleEn: `Title ${i}`,
    descriptionEn: `Description ${i}`,
    countryCode: 'IN',
    pubDateMs: NOW_MS - i * 3_600_000,
    maxClusterSize: 4,
    eventType: 'weather',
    geoTags: [],
    entities: [],
    matchedTopics: [
      { topicId: `t-${i}`, text: `topic ${i}`, effectiveWeight: 0.5 + (i % 3) * 0.2 },
    ],
  };
}

function capturingLlm(captured: BatchCall[]): LlmPort {
  return {
    batchComplete: async (calls) => {
      captured.push(...calls);
      // Empty output → parseJudgeResponse fail-opens; scores are irrelevant here.
      return calls.map((c) => ({ id: c.id, output: '' }));
    },
    complete: async () => '',
  };
}

describe('judge call parity — buildJudgeCalls vs computeAndJudge inline framing', () => {
  it('produces identical BatchCalls (single chunk)', async () => {
    const stage: StageCandidate[] = [0, 1, 2].map((i) => ({ input: candidate(i) }));
    const captured: BatchCall[] = [];
    const res = await computeAndJudge(stage, persona, capturingLlm(captured), DEFAULT_HARNESS_CONFIG, {
      nowMs: NOW_MS,
    });

    const bundle = buildJudgeCalls(
      stage,
      res.computedScoreMap,
      res.componentsMap,
      persona,
      DEFAULT_HARNESS_CONFIG,
    );

    expect(captured).toHaveLength(1);
    expect(bundle.calls).toEqual(captured);
    expect(bundle.chunkIds.get('judge:0')).toEqual(['art-0', 'art-1', 'art-2']);
  });

  it('produces identical BatchCalls + chunk boundaries above judgeChunkSize', async () => {
    const n = DEFAULT_HARNESS_CONFIG.articlePipeline.judgeChunkSize + 1; // force 2 chunks
    const stage: StageCandidate[] = Array.from({ length: n }, (_, i) => ({ input: candidate(i) }));
    const captured: BatchCall[] = [];
    const res = await computeAndJudge(stage, persona, capturingLlm(captured), DEFAULT_HARNESS_CONFIG, {
      nowMs: NOW_MS,
    });

    const bundle = buildJudgeCalls(
      stage,
      res.computedScoreMap,
      res.componentsMap,
      persona,
      DEFAULT_HARNESS_CONFIG,
    );

    expect(captured).toHaveLength(2);
    expect(bundle.calls).toEqual(captured);
    expect(bundle.calls.map((c) => c.id)).toEqual(['judge:0', 'judge:1']);
    expect(bundle.chunkIds.get('judge:1')).toEqual([`art-${n - 1}`]);
    // Framing fields come from the same config surface on both paths.
    for (const call of bundle.calls) {
      expect(call.system).toBe(DEFAULT_HARNESS_CONFIG.articlePipeline.judgeSystemPrompt);
      expect(call.temperature).toBe(DEFAULT_HARNESS_CONFIG.articlePipeline.scoreTemperature);
      expect(call.maxTokens).toBe(DEFAULT_HARNESS_CONFIG.articlePipeline.judgeMaxTokens);
    }
  });
});
