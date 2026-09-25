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
import { namesFact } from '../../lib/mera-harness/core/topic-similarity';
import { ladderOrder, parseExpectations, scoreCase, selectCase } from '../../lib/mera-harness/eval/expectations';
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
  const order: Record<string, { ordered: number; cases: number; prefix: number; rungs: number }> = {};
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
      if (set.topics.length > 0) {
        const sel = selectCase(set.factStatement, exp.cases);
        if (sel.kind === 'one') {
          const lo = ladderOrder(set.topics, sel.case);
          if (lo.rungs > 0) {
            const o = (order[arm] ??= { ordered: 0, cases: 0, prefix: 0, rungs: 0 });
            o.cases += 1;
            o.prefix += lo.matchedPrefix;
            o.rungs += lo.rungs;
            if (lo.ordered) o.ordered += 1;
          }
        }
      }
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
    'topics/set answers the "too few" half of the original complaint, which the ladder and',
    'field-generic checks say nothing about: an arm can cover every rung with one topic each',
    'and still leave a thin feed. Median as well as mean, because one long set moves a mean.',
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
    const sorted = [...a.perCellCounts].sort((x, y) => x - y);
    const mean = a.cells === 0 ? 0 : a.topicsTotal / a.cells;
    const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
    lines.push(
      `  ${arm.padEnd(16)} ladder ${a.rungsCovered}/${a.rungsTotal} ${ladder}   ` +
        `fieldGeneric ${a.fieldGenericPresent}/${a.fieldGenericCases} ${fg}   ` +
        `topics/set mean ${mean.toFixed(1)} median ${median}${vs}`,
    );
  }
  lines.push(
    '\nRUNG ORDER (REPORTED, NOT GATED): do the first K topics match the K ordering rungs in',
    'declaration order? `diaspora` is excluded, being a shape category in the origin guideline',
    'rather than a rung of a place ladder. A fixed position is a strong demand on a generative',
    'output, so this is watched before it is enforced.',
  );
  for (const [arm, o] of Object.entries(order)) {
    lines.push(
      `  ${arm.padEnd(16)} fully ordered ${o.ordered}/${o.cases} ${pct(o.ordered, o.cases)}   ` +
        `rungs in position ${o.prefix}/${o.rungs} ${pct(o.prefix, o.rungs)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  return failures > 0 ? 1 : 0;
}


// ===========================================================================
// --flow: the ux2 F6 topic-flow measurement (isolated+combo vs current)
// ===========================================================================
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/score-topic-run.ts --flow <runDir> [<runDir> ...] \
//       [--arm baseline] [--control topics-current] [--null null-control]
//
// Reads cohort-mode runs of run-topicgen-corpus.ts, which write `f6-plan.json`
// and tag the isolated flow's rows with `stage`. The verdict is POOLED over
// every run dir passed; per-cohort figures are diagnostics.
//
// THE RULE, fixed before the run by the owner (plan Part F item 6):
//   PASS needs  (1) the isolated topics' share with NO content word from any
//                   other fact >= 95%, and
//               (2) that share > the control's first-pass (fact-only) share.
//   Guards:     every combo topic names its fact's subject; S7 near-duplicates
//               <= 10%; ladder coverage no worse at matched count; integrity
//               (no error rows, no empty first-pass sets, every planned row).
//
// OPERATIONAL DEFINITIONS, fixed in code before the live run. The brief left
// these open; each choice is named so it can be argued with.
//   - A CONTENT WORD is a token of the shipped topic tokenizer (lowercase,
//     split on non-letters/digits, function words dropped), minus the
//     statement-frame words in F6_STATEMENT_FILLER, minus 1-letter tokens,
//     with a trailing plural "s" stripped (not "ss") on both sides.
//   - "FROM ANY OTHER FACT" (PRIMARY) counts only another fact's words that
//     are ABSENT from the topic's own fact: Netherlands, Portugal, Madeira and
//     EU each sit in two owner facts, so the literal reading fails an isolated
//     topic for naming its own fact. The literal reading is reported beside it.
//   - "NAMES ITS FACT'S SUBJECT" is a lexical PROXY: the topic shares a content
//     word with its own fact, equal or on a shared 5-letter prefix (India and
//     Indian, Portugal and Portuguese). Every miss is listed verbatim; a miss
//     fails the guard on the proxy and is for a rater to adjudicate.
//   - S7 is the mean post-filter near-duplicate rate over each fact's final
//     set (first pass then combo), per repeat.
//   - LADDER "at matched count": per (cohort, fact, repeat) cell every arm
//     returned a set for, each arm's final set is TRUNCATED to the smallest
//     arm's size before rungs are counted, because the isolated flow returns
//     up to 12+4 against the batch path's 6+4 and at-least-one-rung coverage
//     rises with count alone. The cell-matched, untruncated figure is reported
//     too. "No worse" means arm >= control minus the null-control floor on
//     the same figure.
//   - "Higher than" in the rule is strict; whether the gap clears the null
//     floor is reported, not gated.
//   - Empty sets are checked on the FIRST PASS only: both combo prompts say an
//     empty array is correct.

/** Statement-frame words: they say how a fact is phrased, not what it is about. */
export const F6_STATEMENT_FILLER: ReadonlySet<string> = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'lives', 'live', 'living', 'works',
  'work', 'holds', 'owns', 'uses', 'visits', 'visit', 'since', 'especially', 'originally', 'about',
  'when', 'it', 'its', 'one', 'two', 'three', 'twice', 'times', 'week', 'year', 'round', 'very',
  'also', 'their', 'his', 'her', 'my', 'our', 'your', 'who', 'which', 'that', 'this', 'there', 'not',
  'but', 'into', 'per',
]);
/** The shipped topic tokenizer's function words (core/topic-similarity.ts). */
const F6_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
]);

export function f6Words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || F6_STOPWORDS.has(raw) || F6_STATEMENT_FILLER.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Other facts' words a topic carries. `primary` leaves out words its own fact
 *  also has; `literal` does not. Empty lists mean clean. */
export function f6Leak(
  topic: string,
  ownStatement: string,
  otherStatements: readonly string[],
): { primary: string[]; literal: string[] } {
  const t = f6Words(topic);
  const own = f6Words(ownStatement);
  const others = new Set<string>();
  for (const s of otherStatements) for (const w of f6Words(s)) others.add(w);
  const literal = [...t].filter((w) => others.has(w));
  return { primary: literal.filter((w) => !own.has(w)), literal };
}

/**
 * THE KIND OF A LEAK, a heuristic fixed before the ux2 F6 re-run. A leaked
 * word written as a PROPER NOUN in another fact (capitalised, and not that
 * statement's first word: Rotterdam, Poland, Dutch, EU, Feyenoord) is that
 * fact's own subject arriving in this one, i.e. a genuine other-fact leak.
 * A lowercase word (port, rate, public, automation) is a common word two
 * facts share, the candidate for legitimate domain overlap. Both lists are
 * printed in full so the heuristic can be checked line by line.
 */
export function f6LeakKind(word: string, otherStatements: readonly string[]): 'entity' | 'common' {
  for (const s of otherStatements) {
    const tokens = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
      const w = tokens[i];
      const norm = w.toLowerCase();
      const stem = norm.length > 3 && norm.endsWith('s') && !norm.endsWith('ss') ? norm.slice(0, -1) : norm;
      if (stem === word && /^\p{Lu}/u.test(w)) return 'entity';
    }
  }
  return 'common';
}

export function f6NamesSubject(topic: string, ownStatement: string): boolean {
  const own = [...f6Words(ownStatement)];
  for (const w of f6Words(topic)) {
    for (const o of own) {
      if (w === o) return true;
      if (w.length >= 5 && o.length >= 5 && w.slice(0, 5) === o.slice(0, 5)) return true;
    }
  }
  return false;
}

/**
 * Ladders for the F6 cohort facts, fixed before the run. Only the official
 * `family-relative-village` case (Porto Santo) matches a cohort fact, so these
 * add the two residences and the two origins. Same shape and rules as
 * skills/persona/expectations/topics.json, merged into it and validated by the
 * same parser (3-character floor, mutual exclusivity).
 */
export const F6_LADDER_CASES = [
  {
    id: 'f6-residence-rotterdam',
    factMatches: ['lives in', 'rotterdam'],
    ladder: {
      city: ['rotterdam'],
      province: ['south holland', 'zuid-holland'],
      country: ['netherlands', 'dutch'],
      bloc: ['eu ', ' eu', 'european union'],
    },
  },
  {
    id: 'f6-residence-nieuw-west',
    factMatches: ['lives in', 'nieuw-west'],
    ladder: {
      neighbourhood: ['nieuw-west', 'nieuw west'],
      city: ['amsterdam'],
      province: ['north holland', 'noord-holland'],
      country: ['netherlands', 'dutch'],
      bloc: ['eu ', ' eu', 'european union'],
    },
  },
  {
    id: 'f6-origin-gdansk',
    factMatches: ['originally from', 'gdansk'],
    ladder: {
      city: ['gdansk', 'gdańsk'],
      country: ['poland', 'polish'],
      diaspora: ['diaspora', 'consular', 'passport', 'citizenship', 'remittance', 'visa'],
    },
  },
  {
    id: 'f6-origin-india',
    factMatches: ['from india'],
    ladder: {
      country: ['india'],
      diaspora: ['diaspora', 'consular', 'passport', 'citizenship', 'remittance', 'visa', 'oci '],
    },
  },
];

interface F6PlanFact { id: string; statement: string; questionnaireAttribute: string; skillId: string }
interface F6Plan {
  cohort: string;
  facts: F6PlanFact[];
  variants: { variant: string; flow: string; expectedRows: Record<string, number> }[];
}
type FlowRow = ReturnType<typeof readJsonl>[number] & {
  stage?: 'isolated' | 'combo';
  attempts?: number;
  preFilterTopics?: string[];
};

function stageOf(r: FlowRow): 'first' | 'combo' {
  if (r.stage) return r.stage === 'isolated' ? 'first' : 'combo';
  return r.callType === 'topicgen-combo' ? 'combo' : 'first';
}

function topicsOf(r: FlowRow): string[] {
  return Array.isArray(r.parsedSchema) ? (r.parsedSchema as string[]) : [];
}

/** mulberry32: a seeded sample is reproducible from the run alone. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const r = rng(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export const F6_LEAK_GATE = 0.95;
export const F6_SAMPLE_SEED = 20260925;

export function scoreFlow(argv: string[]): number {
  const opt = (name: string, dflt: string): string => {
    const i = argv.indexOf(name);
    return i === -1 ? dflt : argv[i + 1];
  };
  const ARM = opt('--arm', 'baseline');
  const CONTROL = opt('--control', 'topics-current');
  const NULL = opt('--null', 'null-control');
  const valueFlags = new Set(['--arm', '--control', '--null']);
  const dirs = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''));
  if (dirs.length === 0) throw new Error('harness-local: --flow needs at least one run directory.');

  const exp = parseExpectations({
    ...(JSON.parse(readFileSync(EXPECTATIONS, 'utf8')) as Record<string, unknown>),
    cases: [
      ...((JSON.parse(readFileSync(EXPECTATIONS, 'utf8')) as { cases: unknown[] }).cases),
      ...F6_LADDER_CASES,
    ],
  });

  const out: string[] = [];
  const say = (l = ''): void => { out.push(l); };
  const arms = [ARM, CONTROL, NULL];

  interface Acc {
    firstTopics: number; firstClean: number; firstCleanLiteral: number;
    comboTopics: number; comboClean: number; comboNamed: number;
    comboMisses: string[]; leaks: string[];
    leakEntity: string[]; leakCommon: string[];
    preTopics: number; preNamedApp: number; preNamedProxy: number; retried: number; isolatedRows: number;
    s7Sum: number; s7Sets: number; s7FirstSum: number; s7FirstSets: number;
    errorRows: number; emptyFirst: number; rows: number; usd: number;
    firstSample: string[]; comboSample: string[];
  }
  const blank = (): Acc => ({
    firstTopics: 0, firstClean: 0, firstCleanLiteral: 0, comboTopics: 0, comboClean: 0, comboNamed: 0,
    comboMisses: [], leaks: [], leakEntity: [], leakCommon: [],
    preTopics: 0, preNamedApp: 0, preNamedProxy: 0, retried: 0, isolatedRows: 0, s7Sum: 0, s7Sets: 0, s7FirstSum: 0, s7FirstSets: 0,
    errorRows: 0, emptyFirst: 0, rows: 0, usd: 0, firstSample: [], comboSample: [],
  });
  const pooled: Record<string, Acc> = Object.fromEntries(arms.map((a) => [a, blank()]));
  const perCohort: Record<string, Record<string, Acc>> = {};
  const completeness: string[] = [];
  /** cell `${cohort}|${factId}|${rep}` -> arm -> final set, for the ladder. */
  const cells = new Map<string, Map<string, { statement: string; topics: string[] }>>();
  let totalUsd = 0;

  for (const dir of dirs) {
    const plan = JSON.parse(readFileSync(join(resolve(dir), 'f6-plan.json'), 'utf8')) as F6Plan;
    const rows = (readJsonl(join(resolve(dir), 'rows.jsonl')) as FlowRow[]).filter((r) => r.dupOf === null);
    const byFact = new Map(plan.facts.map((f) => [f.id, f]));
    const cohortAcc = (perCohort[plan.cohort] ??= Object.fromEntries(arms.map((a) => [a, blank()])));

    for (const v of plan.variants) {
      for (const [stage, expected] of Object.entries(v.expectedRows)) {
        const got = rows.filter(
          (r) => r.variant === v.variant && (r.stage ? r.stage === stage : (stage === 'combo') === (r.callType === 'topicgen-combo')),
        ).length;
        if (got !== expected) completeness.push(`${plan.cohort} ${v.variant} ${stage}: ${got} of ${expected} planned rows`);
      }
    }

    // Per (arm, fact, rep): first pass then combo, the fact's final set.
    const sets = new Map<string, { first: string[]; combo: string[] }>();
    for (const r of rows) {
      const usd = r.cost?.usd ?? 0;
      totalUsd += usd;
      if (!arms.includes(r.variant)) continue;
      const fid = r.items?.[0]?.id ?? '';
      const fact = byFact.get(fid);
      if (!fact) throw new Error(`harness-local: row fact '${fid}' is not in ${dir}/f6-plan.json.`);
      const others = plan.facts.filter((f) => f.id !== fid).map((f) => f.statement);
      const accs = [pooled[r.variant], cohortAcc[r.variant]];
      const stage = stageOf(r);
      const topics = topicsOf(r);
      for (const a of accs) {
        a.rows += 1;
        a.usd += usd;
        if (r.error !== null) a.errorRows += 1;
        if (stage === 'first' && r.error === null && topics.length === 0) a.emptyFirst += 1;
        if (r.stage === 'isolated') {
          a.isolatedRows += 1;
          if ((r.attempts ?? 1) > 1) a.retried += 1;
        }
        for (const t of r.preFilterTopics ?? []) {
          a.preTopics += 1;
          if (namesFact(t, fact.statement)) a.preNamedApp += 1;
          if (f6NamesSubject(t, fact.statement)) a.preNamedProxy += 1;
        }
      }
      for (const t of topics) {
        const leak = f6Leak(t, fact.statement, others);
        const line = `[${plan.cohort}] "${fact.statement}" -> ${t}`;
        for (const a of accs) {
          if (stage === 'first') {
            a.firstTopics += 1;
            if (leak.primary.length === 0) a.firstClean += 1;
            if (leak.literal.length === 0) a.firstCleanLiteral += 1;
          } else {
            a.comboTopics += 1;
            if (leak.primary.length === 0) a.comboClean += 1;
            if (f6NamesSubject(t, fact.statement)) a.comboNamed += 1;
          }
        }
        const a = pooled[r.variant];
        if (stage === 'first') {
          a.firstSample.push(line);
          if (leak.primary.length > 0) {
            const tagged = `${line}   [${leak.primary.join(', ')}]`;
            a.leaks.push(tagged);
            const entity = leak.primary.some((w) => f6LeakKind(w, others) === 'entity');
            (entity ? a.leakEntity : a.leakCommon).push(tagged);
          }
        } else {
          a.comboSample.push(line);
          if (!f6NamesSubject(t, fact.statement)) a.comboMisses.push(line);
        }
      }
      const key = `${r.variant}|${plan.cohort}|${fid}|${r.repeat}`;
      const set = sets.get(key) ?? { first: [], combo: [] };
      if (stage === 'first') set.first.push(...topics);
      else set.combo.push(...topics);
      sets.set(key, set);
    }

    for (const [key, set] of sets) {
      const [arm, cohort, fid, rep] = key.split('|');
      const fact = byFact.get(fid) as F6PlanFact;
      const seen = new Set<string>();
      const final = [...set.first, ...set.combo].filter((t) => {
        const n = t.trim().toLowerCase();
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      const input = (topics: string[]): TopicSetInput => ({
        factId: fid, factStatement: fact.statement, factKind: fact.skillId, placeChain: null,
        topics, existingTopics: [], declinedTopics: [], rawOutput: '', finishReason: 'stop',
      });
      for (const a of [pooled[arm], perCohort[cohort][arm]]) {
        if (final.length > 0) {
          a.s7Sum += s7Report(input(final)).postFilterRate;
          a.s7Sets += 1;
        }
        if (set.first.length > 0) {
          a.s7FirstSum += s7Report(input(set.first)).postFilterRate;
          a.s7FirstSets += 1;
        }
      }
      const cellKey = `${cohort}|${fid}|${rep}`;
      const cell = cells.get(cellKey) ?? new Map<string, { statement: string; topics: string[] }>();
      cell.set(arm, { statement: fact.statement, topics: final });
      cells.set(cellKey, cell);
    }
  }

  // ---- ladder, at matched count --------------------------------------------
  const ladder: Record<string, { covered: number; total: number; coveredFull: number; totalFull: number }> =
    Object.fromEntries(arms.map((a) => [a, { covered: 0, total: 0, coveredFull: 0, totalFull: 0 }]));
  let ladderCells = 0;
  let ladderUnmatched = 0;
  for (const [, cell] of cells) {
    const present = arms.filter((a) => (cell.get(a)?.topics.length ?? 0) > 0);
    const statement = [...cell.values()][0]?.statement ?? '';
    const sel = selectCase(statement, exp.cases);
    if (sel.kind !== 'one') continue;
    if (present.length < arms.length) { ladderUnmatched += 1; continue; }
    ladderCells += 1;
    const n = Math.min(...arms.map((a) => cell.get(a)!.topics.length));
    for (const a of arms) {
      const full = cell.get(a)!.topics;
      const truncated = scoreCase(full.slice(0, n), sel.case);
      const whole = scoreCase(full, sel.case);
      ladder[a].covered += truncated.rungsCovered;
      ladder[a].total += truncated.rungsTotal;
      ladder[a].coveredFull += whole.rungsCovered;
      ladder[a].totalFull += whole.rungsTotal;
    }
  }

  // ---- report ---------------------------------------------------------------
  const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);
  const P = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const firstShare = (a: Acc): number => rate(a.firstClean, a.firstTopics);
  const s7 = (a: Acc): number => rate(a.s7Sum, a.s7Sets);
  const lad = (a: string): number => rate(ladder[a].covered, ladder[a].total);

  say(`F6 TOPIC FLOW  runs: ${dirs.map((d) => d.split('/').pop()).join(', ')}`);
  say(`arm ${ARM} (isolated+combo)  control ${CONTROL} (current)  null ${NULL}`);
  say('');
  say('arm              first-pass leak-free (primary / literal)   combo leak-free   combo names subject   S7 final / first-pass   ladder@matched (full)   rows  err  empty1st   USD');
  const line = (label: string, a: Acc, armId: string): string =>
    `${label.padEnd(16)} ${`${a.firstClean}/${a.firstTopics} ${P(firstShare(a))} / ${P(rate(a.firstCleanLiteral, a.firstTopics))}`.padEnd(42)}` +
    `${`${P(rate(a.comboClean, a.comboTopics))} (${a.comboTopics})`.padEnd(18)}` +
    `${`${a.comboNamed}/${a.comboTopics} ${P(rate(a.comboNamed, a.comboTopics))}`.padEnd(22)}` +
    `${`${P(s7(a))} / ${P(rate(a.s7FirstSum, a.s7FirstSets))}`.padEnd(24)}` +
    `${armId ? `${ladder[armId].covered}/${ladder[armId].total} ${P(lad(armId))} (${P(rate(ladder[armId].coveredFull, ladder[armId].totalFull))})` : ''}`.padEnd(24) +
    `${String(a.rows).padStart(4)} ${String(a.errorRows).padStart(4)} ${String(a.emptyFirst).padStart(8)}  ${a.usd.toFixed(4)}`;
  for (const a of arms) say(line(a, pooled[a], a));
  say('');
  say('per cohort (diagnostic; the verdict is pooled):');
  for (const [cohort, accs] of Object.entries(perCohort)) {
    for (const a of arms) say(line(`${cohort}:${a}`.slice(0, 16), accs[a], ''));
  }

  const floorLeak = Math.abs(firstShare(pooled[ARM]) - firstShare(pooled[NULL]));
  const floorS7 = Math.abs(s7(pooled[ARM]) - s7(pooled[NULL]));
  const floorLadder = Math.abs(lad(ARM) - lad(NULL));
  say('');
  say(`NULL-CONTROL FLOOR (|${ARM} - ${NULL}|): first-pass leak-free ${P(floorLeak)}, S7 ${P(floorS7)}, ladder@matched ${P(floorLadder)}`);
  say(`ladder cells matched ${ladderCells}, excluded (an arm returned nothing) ${ladderUnmatched}`);
  say('');
  say('DIAGNOSTICS (not gated)');
  for (const a of arms) {
    const acc = pooled[a];
    say(
      `  ${a.padEnd(16)} first-pass leaks by kind: other-fact proper noun ${acc.leakEntity.length}, ` +
        `shared common word ${acc.leakCommon.length}` +
        (acc.preTopics > 0
          ? `   combo PROMPT-ONLY (before the names-its-fact filter): app namesFact ` +
            `${acc.preNamedApp}/${acc.preTopics} ${P(rate(acc.preNamedApp, acc.preTopics))}, ` +
            `scorer proxy ${acc.preNamedProxy}/${acc.preTopics} ${P(rate(acc.preNamedProxy, acc.preTopics))}`
          : '') +
        (acc.isolatedRows > 0 ? `   isolated sets retried after an empty answer ${acc.retried}/${acc.isolatedRows}` : ''),
    );
  }

  const errors = arms.reduce((n, a) => n + pooled[a].errorRows, 0);
  const empties = arms.reduce((n, a) => n + pooled[a].emptyFirst, 0);
  const gap = firstShare(pooled[ARM]) - firstShare(pooled[CONTROL]);
  const checks: [string, boolean, string][] = [
    ['RULE 1  isolated leak-free share >= 95%', firstShare(pooled[ARM]) >= F6_LEAK_GATE, P(firstShare(pooled[ARM]))],
    [
      `RULE 2  isolated share > ${CONTROL} first-pass share`,
      gap > 0,
      `${P(firstShare(pooled[ARM]))} vs ${P(firstShare(pooled[CONTROL]))}, gap ${P(gap)} (${gap > floorLeak ? 'clears' : 'within'} the ${P(floorLeak)} null floor)`,
    ],
    [
      'GUARD   every combo topic names its fact (lexical proxy)',
      pooled[ARM].comboMisses.length === 0,
      `${pooled[ARM].comboNamed}/${pooled[ARM].comboTopics}, ${pooled[ARM].comboMisses.length} miss(es) listed below`,
    ],
    ['GUARD   S7 near-duplicates <= 10%', s7(pooled[ARM]) <= S7_GATE, P(s7(pooled[ARM]))],
    [
      'GUARD   ladder@matched no worse (>= control - null floor)',
      lad(ARM) >= lad(CONTROL) - floorLadder,
      `${P(lad(ARM))} vs ${P(lad(CONTROL))}, floor ${P(floorLadder)}`,
    ],
    [
      'GUARD   integrity: no error rows, no empty first-pass set, every planned row',
      errors === 0 && empties === 0 && completeness.length === 0,
      `errors ${errors}, empty first-pass ${empties}, incomplete cells ${completeness.length}`,
    ],
  ];
  say('');
  for (const [name, ok, detail] of checks) say(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(74)} ${detail}`);
  const verdict = checks.every(([, ok]) => ok);
  say('');
  say(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}`);
  if (completeness.length > 0) {
    say('');
    say('INCOMPLETE (a spend limit or crash cut the run short):');
    for (const c of completeness) say(`  ${c}`);
  }

  say('');
  say(`${ARM} leaks, OTHER-FACT PROPER NOUN (genuine other-fact subject), all ${pooled[ARM].leakEntity.length}:`);
  for (const l of pooled[ARM].leakEntity) say(`  ${l}`);
  say('');
  say(`${ARM} leaks, SHARED COMMON WORD (domain-overlap candidates), all ${pooled[ARM].leakCommon.length}:`);
  for (const l of pooled[ARM].leakCommon) say(`  ${l}`);
  say('');
  say(`${CONTROL} first-pass topics carrying another fact's word (primary), all ${pooled[CONTROL].leaks.length}:`);
  for (const l of pooled[CONTROL].leaks) say(`  ${l}`);
  say('');
  say(`${ARM} combo topics the subject proxy found no fact word in, all ${pooled[ARM].comboMisses.length}:`);
  for (const l of pooled[ARM].comboMisses) say(`  ${l}`);

  say('');
  say(`SAMPLES FOR AN INDEPENDENT RATER, seed ${F6_SAMPLE_SEED}, verbatim:`);
  for (const a of arms) {
    say(`-- ${a}: 20 first-pass (isolated / fact-only) topics`);
    for (const l of sample(pooled[a].firstSample, 20, F6_SAMPLE_SEED)) say(`  ${l}`);
    say(`-- ${a}: 20 combo topics`);
    for (const l of sample(pooled[a].comboSample, 20, F6_SAMPLE_SEED + 1)) say(`  ${l}`);
  }
  say('');
  say(`COST: $${totalUsd.toFixed(4)} across ${dirs.length} run(s), every arm.`);

  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
  return verdict ? 0 : 1;
}

if (/score-topic-run\.ts$/.test(process.argv[1] ?? '')) {
  try {
    const argv = process.argv.slice(2);
    process.exit(argv.includes('--flow') ? scoreFlow(argv.filter((a) => a !== '--flow')) : main());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
}
