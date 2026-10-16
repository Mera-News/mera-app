// Run with: npx tsx --tsconfig harness-local/tsconfig.json --test harness-local/scripts/agreement-ragged.test.ts
//
// Leg counts are ragged across repeats, so a leg index some repeat never reached is not missing
// data. A TURN that ran in fewer than 3 repeats is still thin.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeAgreement, formatAgreementReport } from '../lib/agreement';
import type { RunRow } from '../lib/jsonl-writer';

function row(over: Partial<RunRow>): RunRow {
  return {
    rowId: `r-${Math.random()}`, dupOf: null, runId: 'run', repeat: 0, cohort: 'script', turnIndex: 0, legIndex: 0,
    arm: 'm@baseline', callType: 'agent-tool', interleaveGroup: 'script:0', lane: 'near', surface: 'AGENT',
    variant: 'baseline', promptHash: 'sha256:a', promptDeterministic: false, fenceNonce: null,
    modelRequested: 'm', modelSent: 'm', fallbackFrom: null, hedged: false,
    input: { systemPrompt: '', messages: [], toolSchemaNames: [] },
    personaStateIn: { factCount: 0, topicCount: 0, factsInPrompt: 0, turnsInPrompt: 0 },
    rawOutput: '', toolCalls: [], parsedSchema: null, items: null, requestedCount: null, returnedCount: null,
    personaStateDelta: null, finishReason: 'stop', truncated: false, reasoningLeak: false, usage: null, cost: null,
    latencyMs: 1, ttVisibleMs: null, error: null,
    ...over,
  } as RunRow;
}

test('a leg reached in 2 of 3 repeats is ragged, not thin', () => {
  const rows = [0, 1, 2].map((repeat) => row({ repeat, legIndex: 0 }));
  rows.push(row({ repeat: 0, legIndex: 2 }), row({ repeat: 1, legIndex: 2 }));
  const r = computeAgreement(rows);
  assert.equal(r.integrityFailures.filter((f) => f.startsWith('THIN CELL')).length, 0);
  assert.equal(r.raggedLegs.length, 1);
  assert.match(r.raggedLegs[0], /2 of 3 repeats/);
  assert.match(formatAgreementReport(r), /RAGGED LEGS/);
});

test('POSITIVE CONTROL: a turn that ran in only 2 repeats is still a THIN CELL', () => {
  const r = computeAgreement([0, 1].map((repeat) => row({ repeat, legIndex: 0 })));
  assert.equal(r.integrityFailures.filter((f) => f.startsWith('THIN CELL')).length, 1);
  assert.equal(r.raggedLegs.length, 0);
});

test('a single-call runner (no legIndex) keeps its old thin-cell behaviour', () => {
  const r = computeAgreement([0, 1].map((repeat) => row({ repeat, legIndex: null, callType: 'score' as RunRow['callType'] })));
  assert.equal(r.integrityFailures.filter((f) => f.startsWith('THIN CELL')).length, 1);
});
