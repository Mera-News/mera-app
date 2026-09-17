// harness-local — score a STEP A topic run against the gates. No calls.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/score-topic-run.ts <runDir> [--control oneshot-prod]
//
// WHY THIS IS A SCRIPT AND NOT A SCRATCH FILE. Round 1 was scored by an
// ad-hoc program in a temp directory. Round 2 has to be scored the SAME way
// or the delta between them measures the scorer as much as the run, and a
// scoring pass that produced gate verdicts should be reproducible from the
// repo by anyone. Re-reads a finished run; spends nothing.
//
// Gates print in the order they must be read. Each one invalidates the next
// if it fails: an arm that returns no usable set has no duplicates, no
// over-long topics and a perfect near-duplicate rate.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readJsonl } from '../lib/agreement';
import { parseExpectations, scoreCase, selectCase } from '../../lib/mera-harness/eval/expectations';
import {
  EMPTY_CONTENT_GATE,
  NO_USABLE_SET_GATE,
  S7_GATE,
  countMatchedLadder,
  filterCorrectness,
  integrityReport,
  s7Report,
  sharedRules,
  type ArmSetEntry,
  type TopicSetInput,
} from '../../lib/mera-harness/eval/topic-metrics';

const ROOT = resolve(__dirname, '..', '..');
const EXPECTATIONS = join(ROOT, 'lib/mera-harness/skills/persona/expectations/topics.json');
const FACTS = join(ROOT, 'lib/mera-harness/eval/fixtures/topic-facts.json');

interface FactFixture {
  caseId: string;
  id: string;
  statement: string;
  kind: string;
  placeChain?: TopicSetInput['placeChain'];
}

function pct(n: number, d: number): string {
  return d === 0 ? '   n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const runDir = argv.find((a) => !a.startsWith('--'));
  if (!runDir) throw new Error('harness-local: pass a run directory.');
  const ctrlIdx = argv.indexOf('--control');
  const control = ctrlIdx === -1 ? 'oneshot-prod' : argv[ctrlIdx + 1];

  const rows = readJsonl(join(resolve(runDir), 'rows.jsonl')).filter((r) => r.dupOf === null);
  const exp = parseExpectations(JSON.parse(readFileSync(EXPECTATIONS, 'utf8')));
  const facts = (JSON.parse(readFileSync(FACTS, 'utf8')) as { facts: FactFixture[] }).facts;
  const byId = new Map(facts.map((f) => [f.id, f]));

  const arms = [...new Set(rows.map((r) => r.variant))];
  const entries: ArmSetEntry[] = [];
  let failures = 0;

  for (const arm of arms) {
    const mine = rows.filter((r) => r.variant === arm);
    const sets: TopicSetInput[] = mine.map((r) => {
      const fid = r.items?.[0]?.id ?? '';
      const f = byId.get(fid);
      const set: TopicSetInput = {
        factId: fid,
        factStatement: f?.statement ?? '',
        factKind: f?.kind ?? 'generic',
        placeChain: f?.placeChain ?? null,
        topics: Array.isArray(r.parsedSchema) ? (r.parsedSchema as string[]) : [],
        existingTopics: [],
        declinedTopics: [],
        rawOutput: r.rawOutput,
        finishReason: r.finishReason,
      };
      entries.push({ arm, key: `${fid}|${r.repeat}`, set });
      return set;
    });

    const ig = integrityReport(sets);
    const scored = sets.filter((s) => s.topics.length > 0);
    const s7 = scored.map(s7Report);
    const s7post = s7.length ? s7.reduce((a, b) => a + b.postFilterRate, 0) / s7.length : 0;
    const s7raw = s7.length ? s7.reduce((a, b) => a + b.rawRate, 0) / s7.length : 0;
    const fc = sets.map((s) => filterCorrectness(s.topics, s.placeChain));
    const wrong = fc.reduce(
      (a, b) => a + b.droppedOnPlaceNameAlone.length + b.droppedDifferingOnlyByPlace.length,
      0,
    );
    const sr = sets.map(sharedRules);

    // eslint-disable-next-line no-console
    console.log(
      `\n=== ${arm} ===\n` +
        `G1  empty content   ${ig.emptyContent}/${ig.calls} ${pct(ig.emptyContent, ig.calls)} ` +
        `gate<=${EMPTY_CONTENT_GATE * 100}%  ${ig.passed ? 'PASS' : 'FAIL'}   (as originally agreed)\n` +
        `G1b NO USABLE SET   ${ig.emptyContent + ig.unparsedOutput}/${ig.calls} ` +
        `${pct(ig.emptyContent + ig.unparsedOutput, ig.calls)} gate<=${NO_USABLE_SET_GATE * 100}%  ` +
        `${ig.passedOnUsableSets ? 'PASS' : 'FAIL'}   (prose instead of JSON: ${ig.unparsedOutput})\n` +
        `G2  filter          wrongly dropped ${wrong}  ${wrong === 0 ? 'PASS' : 'FAIL'}\n` +
        `G3  S7 post-filter  ${(s7post * 100).toFixed(1)}% gate<=${S7_GATE * 100}%  ` +
        `${s7post <= S7_GATE ? 'PASS' : 'FAIL'}   (raw ${(s7raw * 100).toFixed(1)}%, the diagnostic)\n` +
        `    word-count violations ${sr.reduce((a, b) => a + b.wordCountViolations.length, 0)}, ` +
        `banned dash ${sr.reduce((a, b) => a + b.bannedDash.length, 0)}`,
    );
    if (!ig.passedOnUsableSets || wrong > 0 || s7post > S7_GATE) failures += 1;
  }

  // ---- the symptom floors, COUNT-MATCHED --------------------------------
  const matched = countMatchedLadder(entries, (set) => {
    const sel = selectCase(set.factStatement, exp.cases);
    if (sel.kind !== 'one') return null;
    const sc = scoreCase(set.topics, sel.case);
    return {
      rungsCovered: sc.rungsCovered,
      rungsTotal: sc.rungsTotal,
      fieldGenericPresent: sc.fieldGenericPresent,
    };
  });

  const lines = [
    '\nSYMPTOM FLOORS, COUNT-MATCHED (only cells where EVERY arm returned a set).',
    'Scoring each arm over whatever it produced gives them different denominators, and an arm',
    'that returns nothing half the time is then judged on the half it managed.',
    `  matched cells ${matched.matchedCells}, EXCLUDED ${matched.unmatchedCells}`,
  ];
  for (const [arm, n] of Object.entries(matched.droppedByArm)) {
    lines.push(`    dropped by ${arm}: ${n}   <- this is the gate 1b failure, not a scoring detail`);
  }
  const ctrl = matched.perArm[control];
  for (const [arm, a] of Object.entries(matched.perArm)) {
    const ladder = pct(a.rungsCovered, a.rungsTotal);
    const fg = pct(a.fieldGenericPresent, a.fieldGenericCases);
    const vs =
      ctrl && arm !== control
        ? `  vs control ladder ${pct(ctrl.rungsCovered, ctrl.rungsTotal)} / fieldGeneric ${pct(ctrl.fieldGenericPresent, ctrl.fieldGenericCases)}`
        : '';
    lines.push(
      `  ${arm.padEnd(16)} ladder ${a.rungsCovered}/${a.rungsTotal} ${ladder}   ` +
        `fieldGeneric ${a.fieldGenericPresent}/${a.fieldGenericCases} ${fg}${vs}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  return failures > 0 ? 1 : 0;
}

try {
  process.exit(main());
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
