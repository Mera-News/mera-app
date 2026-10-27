// harness-local — fact-places tuning eval.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/fact-places-eval.ts [--repeat 3] [--dry-run] [--label x]
//
// Runs the production place call (buildFactPlacesRequest / decodeFactPlaces,
// SMALL_MODEL, FACT_PLACES_CALL gear, thinking off) over
// fixtures/fact-places/cases.json, repeated, and scores each answer against the
// labelled place. --dry-run prints the prompts and makes no network call.
// Scorer test: fact-places-eval.test.ts (node --test).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import countries from 'i18n-iso-countries';

import { loadHarnessEnv } from '../config/env';
import { applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';
import { createRunWriter } from '../lib/run-writer';
import { postCompletion } from '../lib/near-call';
import { SMALL_MODEL } from '../../lib/llm/constants';
import { parsePlace, type ReaderPlace } from '../../lib/news-harness/persona-management/fact-places';
import {
  FACT_PLACES_CALL,
  buildFactPlacesRequest,
  decodeFactPlaces,
} from '../../lib/news-harness/persona-management/geo-derivation';

export const BAR = { country: 0.95, level: 0.85, wrong: 0.02 } as const;

export interface EvalCase {
  id: string;
  statement: string;
  expect: { level: string; place: string };
  alsoOk?: string[];
}

export interface CaseScore {
  id: string;
  /** Per repeat; null = no answer (a miss, never a wrong place). */
  answers: (string | null)[];
  correct: boolean[];
  countryHit: (boolean | null)[]; // null = case has no expected country
  levelHit: boolean[];
  wrong: boolean[];
}

const DEEP = new Set(['country', 'region', 'city']);

export function scoreCase(c: EvalCase, answers: (string | null)[]): CaseScore {
  const exp = parsePlace(c.expect.place);
  const ok = new Set([c.expect.place, ...(c.alsoOk ?? [])]);
  const rows = answers.map((a) => {
    const got = a ? parsePlace(a) : null;
    const correct = !!a && ok.has(a);
    return {
      correct,
      countryHit: exp?.country ? correct || (!!got?.country && got.country === exp.country) : null,
      levelHit: correct || (!!got && !!exp && got.level === exp.level),
      // Stricter than real bloc membership (an answer inside the expected bloc
      // still counts as wrong): countriesInBloc lives in lib/place-service.ts
      // and cannot load in harness code.
      wrong:
        !correct && !!got && DEEP.has(got.level) && !!exp &&
        (exp.country ? got.country !== exp.country : exp.level === 'global' || exp.level === 'bloc'),
    };
  });
  return {
    id: c.id,
    answers,
    correct: rows.map((r) => r.correct),
    countryHit: rows.map((r) => r.countryHit),
    levelHit: rows.map((r) => r.levelHit),
    wrong: rows.map((r) => r.wrong),
  };
}

export interface Rates { country: number; level: number; wrong: number; pass: boolean }

const rate = (xs: (boolean | null)[]): number => {
  const n = xs.filter((x) => x !== null);
  return n.length ? n.filter(Boolean).length / n.length : 0;
};

export function summarize(scores: CaseScore[]): Rates {
  const country = rate(scores.flatMap((s) => s.countryHit));
  const level = rate(scores.flatMap((s) => s.levelHit));
  const wrong = rate(scores.flatMap((s) => s.wrong));
  return { country, level, wrong, pass: country >= BAR.country && level >= BAR.level && wrong <= BAR.wrong };
}

export function formatReport(cases: EvalCase[], scores: CaseScore[]): string {
  const lines = scores.map((s, i) => {
    const c = cases[i];
    const flags = [
      s.wrong.some(Boolean) && 'WRONG',
      s.answers.some((a) => a === null) && 'MISSING',
      s.countryHit.some((h) => h === false) && 'COUNTRY',
      s.levelHit.some((h) => !h) && 'LEVEL',
    ].filter(Boolean).join(',');
    return [c.id, c.statement, c.expect.place, (c.alsoOk ?? []).join(' ; ') || '-',
      s.answers.map((a) => a ?? '(none)').join(' / '), flags || 'ok'].join('\t');
  });
  const r = summarize(scores);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    'id\tstatement\texpected\talsoOk\tanswers\tflags',
    ...lines,
    '',
    `country hit ${pct(r.country)} (bar >= 95%)  ${r.country >= BAR.country ? 'PASS' : 'FAIL'}`,
    `level hit   ${pct(r.level)} (bar >= 85%)  ${r.level >= BAR.level ? 'PASS' : 'FAIL'}`,
    `wrong place ${pct(r.wrong)} (bar <= 2%)   ${r.wrong <= BAR.wrong ? 'PASS' : 'FAIL'}`,
  ].join('\n');
}

interface Persona { id: string; places: ReaderPlace[]; facts: EvalCase[] }

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.indexOf(n);
  const repeat = flag('--repeat') >= 0 ? Number(argv[flag('--repeat') + 1]) : 3;
  const label = flag('--label') >= 0 ? argv[flag('--label') + 1] : 'fact-places';
  const dryRun = argv.includes('--dry-run');
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');

  const { personas } = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/fact-places/cases.json'), 'utf8'),
  ) as { personas: Persona[] };
  const allowed = new Set(Object.keys(countries.getAlpha2Codes()));

  let env: ReturnType<typeof loadHarnessEnv> | null = null;
  if (!dryRun) {
    applyTargetOverride(argv);
    env = loadHarnessEnv({ require: 'staging' });
    requireStagingTarget(env);
  }

  const cases: EvalCase[] = [];
  const answers = new Map<string, (string | null)[]>();
  // A failed or cut-off call scores its facts as misses; counted so a broken
  // run is never read as a weak model.
  let failedCalls = 0;
  let truncatedCalls = 0;
  for (const p of personas) {
    const context = p.facts.map((f) => f.statement);
    for (const f of p.facts) { cases.push(f); answers.set(f.id, []); }
    for (let r = 0; r < repeat; r++) {
      for (const facts of chunk(p.facts, FACT_PLACES_CALL.perCall)) {
        const batch = facts.map((f) => ({ id: f.id, statement: f.statement, rejected: [] as string[] }));
        const req = buildFactPlacesRequest({ batch, otherFacts: context, readerPlaces: p.places });
        let decoded = new Map<string, string>();
        if (dryRun) {
          if (r === 0) console.log(`--- ${p.id}\n[system]\n${req.systemPrompt}\n[user]\n${req.prompt}\n`);
        } else {
          const res = await postCompletion({
            baseUrl: env!.nearAiBaseUrl,
            apiKey: env!.nearAiApiKey,
            model: SMALL_MODEL,
            messages: [{ role: 'system', content: req.systemPrompt }, { role: 'user', content: req.prompt }],
            temperature: FACT_PLACES_CALL.temperature,
            maxTokens: FACT_PLACES_CALL.maxTokens,
            enableThinking: false,
          });
          if (res.error) {
            failedCalls += 1;
            console.warn(`[fact-places-eval] ${p.id} repeat ${r + 1}: call failed: ${res.error}`);
          }
          if (res.truncated) truncatedCalls += 1;
          decoded = new Map(
            decodeFactPlaces(res.content, batch, allowed).map((d) => [d.factId, d.places[0]] as [string, string]),
          );
        }
        for (const f of facts) answers.get(f.id)!.push(decoded.get(f.id) ?? null);
      }
    }
  }
  if (dryRun) { console.log(`dry run: ${cases.length} facts, ${personas.length} readers, no network call.`); return 0; }

  const scores = cases.map((c) => scoreCase(c, answers.get(c.id)!));
  const report = formatReport(cases, scores);
  console.log(report);
  console.log(`calls failed ${failedCalls}, cut off at the token cap ${truncatedCalls}`);
  const run = createRunWriter({ label });
  run.writeJson('scores', scores);
  run.writeJson('rates', summarize(scores));
  run.finish({ model: SMALL_MODEL, repeat, rates: summarize(scores), failedCalls, truncatedCalls });
  if (failedCalls > 0) return 1;
  return summarize(scores).pass ? 0 : 2;
}

if (/fact-places-eval\.ts$/.test(process.argv[1] ?? '')) main().then(
  (c) => process.exit(c),
  (e) => { console.error(e); process.exit(1); },
);
