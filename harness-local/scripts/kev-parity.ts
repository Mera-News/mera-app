// Kev parity on this Mac: the app's relevance question (KEV_QUESTIONS + kevState from
// lib/mera-protocol/kev-relevance.ts) on goldset-348 rows, through harness-local's Kev.
// Also the smoke check for the Kev backend (`--rows 3`).
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/kev-parity.ts \
//     [--rows 60] [--kev-url <base>] [--compare-url <base>] [--cloud-run <run dir>]
//
//   --kev-url      the backend under test, default kev-local (see adapters/kev-local.ts)
//   --compare-url  a second /v1/systemone backend run on the same rows, compared per row
//                  (e.g. brew llama-server on the same GGUF at http://127.0.0.1:8090/v1)
//   --cloud-run    a score-kev-goldset run dir; its `geo` answers are the same question on
//                  the same state, scored by cloud kev-4b (default: the 2026-10-16 full run)
//
// k = score / 3, the number kevToRelevance() maps. Reported: the k distribution, the share
// at or above KEV_CUT, A-B-A determinism, latency, and per-row deltas against the others.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DecisionResult } from 'llama.rn';

import { kevUrlBackend, startKev, type KevBackend } from '../adapters/kev-local';
import { ensureLocalTestData } from '../config/local-data';
import { createRunWriter, captureGitSha } from '../lib/run-writer';
import { resolveCountryName } from '../../lib/news-harness';

// --- copied from lib/mera-protocol/kev-relevance.ts ---------------------------------------
// That file imports the toolkit, which loads llama.rn and react-native, so tsx cannot load it.
// assertCopyMatches() fails the run when the app's strings change and these do not.
const KEV_QUESTIONS = {
  rel: {
    type: 'score',
    instructions:
      'How relevant is this news article to this reader, given everything known about them? A story about the domestic affairs of a country the reader has no link to is not relevant, even when its subject matches one of their interests.',
    criteria: [
      "Not relevant: no real link to the reader's life, work, location or interests",
      'Low: only a loose or generic link to the reader',
      "Medium: clearly about one of the reader's interests, their work field, or their country",
      "High: directly affects the reader's daily life, job or home area, or is a major development in a core interest",
    ],
  },
} as const;
const KEV_CUT = 0.29;
const DESCRIPTION_CHARS = 500;
const LEVELS_MAX = KEV_QUESTIONS.rel.criteria.length - 1;

function kevState(
  candidate: { titleEn: string; descriptionEn?: string | null; countryCode: string | null; relatedFacts: { statement: string }[] },
  facts: string[],
) {
  const country = candidate.countryCode === 'GLOBAL' ? undefined : resolveCountryName(candidate.countryCode);
  return {
    reader: facts,
    reader_facts_this_article_matched: candidate.relatedFacts.map((f) => f.statement),
    article: {
      title: candidate.titleEn,
      description: candidate.descriptionEn?.slice(0, DESCRIPTION_CHARS) ?? null,
      ...(country ? { country } : {}),
    },
  };
}
// -----------------------------------------------------------------------------------------

function assertCopyMatches(): void {
  const src = readFileSync(resolve(__dirname, '..', '..', 'lib', 'mera-protocol', 'kev-relevance.ts'), 'utf8');
  const needles = [
    KEV_QUESTIONS.rel.instructions,
    ...KEV_QUESTIONS.rel.criteria,
    `KEV_CUT = ${KEV_CUT};`,
    `DESCRIPTION_CHARS = ${DESCRIPTION_CHARS};`,
    "candidate.countryCode === 'GLOBAL' ? undefined : resolveCountryName(candidate.countryCode)",
    'description: candidate.descriptionEn?.slice(0, DESCRIPTION_CHARS) ?? null',
    // key order renders into the prompt (rn-decision.cpp walks an ordered JSON)
    'reader: facts,\n    reader_facts_this_article_matched: candidate.relatedFacts.map((f) => f.statement),\n    article: {\n      title: candidate.titleEn,',
  ];
  const missing = needles.filter((n) => !src.includes(n));
  if (missing.length) throw new Error(`kev-parity: the copy of kev-relevance.ts is stale:\n${missing.join('\n')}`);
}

interface GoldArticle {
  articleId: string;
  title: string;
  description: string;
  countryCode: string | null;
  relatedFacts: string[];
  verdict: 'must_show' | 'nice_to_have' | 'skip';
}

const arg = (argv: string[], f: string, d: string) => (argv.includes(f) ? (argv[argv.indexOf(f) + 1] ?? d) : d);
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a');
const log = (s: string) => console.log(s); // eslint-disable-line no-console

/** Evenly spaced rows, so every verdict band of the fixture is represented. */
function spreadRows<T>(rows: readonly T[], n: number): T[] {
  if (n >= rows.length) return [...rows];
  return Array.from({ length: n }, (_, i) => rows[Math.floor((i * rows.length) / n)]);
}

async function scoreRows(kev: KevBackend, rows: GoldArticle[], persona: string[]) {
  const out: { articleId: string; k: number; ms: number; probabilities: Record<string, number> }[] = [];
  for (const a of rows) {
    const state = kevState(
      { titleEn: a.title, descriptionEn: a.description, countryCode: a.countryCode, relatedFacts: a.relatedFacts.map((statement) => ({ statement })) },
      persona,
    );
    const t0 = Date.now();
    const r: DecisionResult<typeof KEV_QUESTIONS> = await kev.decide({ state, questions: KEV_QUESTIONS });
    out.push({ articleId: a.articleId, k: r.answers.rel.score / LEVELS_MAX, ms: Date.now() - t0, probabilities: r.answers.rel.probabilities });
  }
  return out;
}

function distribution(ks: number[]) {
  return {
    n: ks.length,
    min: Math.min(...ks),
    p25: q(ks, 0.25),
    median: q(ks, 0.5),
    p75: q(ks, 0.75),
    p90: q(ks, 0.9),
    max: Math.max(...ks),
    atOrAboveCut: ks.filter((k) => k >= KEV_CUT).length,
    atOrAbove062: ks.filter((k) => k >= 0.62).length,
  };
}

function deltas(a: Map<string, number>, b: Map<string, number>) {
  const d = [...a].filter(([id]) => b.has(id)).map(([id, k]) => k - (b.get(id) as number));
  const abs = d.map(Math.abs);
  return { n: d.length, meanSigned: d.reduce((s, x) => s + x, 0) / d.length, medianAbs: q(abs, 0.5), maxAbs: Math.max(...abs) };
}

async function main(): Promise<number> {
  ensureLocalTestData();
  assertCopyMatches();
  const argv = process.argv.slice(2);
  const nRows = Number(arg(argv, '--rows', '60'));
  const fx = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'goldset-348.json'), 'utf8')) as {
    personaFacts: { statement: string }[];
    articles: GoldArticle[];
  };
  const persona = fx.personaFacts.map((f) => f.statement);
  const rows = spreadRows(fx.articles, nRows);

  const kev = await startKev(argv);
  const writer = createRunWriter({ label: `kev-parity-${kev.label.startsWith('kev-url') ? 'url' : 'local'}` });
  try {
    // A, B, A: the hybrid's recurrent state must not leak from one request into the next.
    const [a1] = await scoreRows(kev, rows.slice(0, 1), persona);
    await scoreRows(kev, rows.slice(1, 2), persona);
    const [a2] = await scoreRows(kev, rows.slice(0, 1), persona);
    const deterministic = a1.k === a2.k;
    log(`${kev.label}: A-B-A ${deterministic ? 'identical' : `DIFFERS (${a1.k} vs ${a2.k})`}`);

    const scored = await scoreRows(kev, rows, persona);
    const ks = scored.map((r) => r.k);
    const dist = distribution(ks);
    const lat = scored.map((r) => r.ms);
    log(`rows ${dist.n} | k min ${f3(dist.min)} p25 ${f3(dist.p25)} median ${f3(dist.median)} p75 ${f3(dist.p75)} p90 ${f3(dist.p90)} max ${f3(dist.max)}`);
    log(`k >= KEV_CUT ${KEV_CUT}: ${dist.atOrAboveCut}/${dist.n} | k >= 0.62: ${dist.atOrAbove062}/${dist.n} | latency p50 ${q(lat, 0.5)}ms p95 ${q(lat, 0.95)}ms`);
    const byId = new Map(scored.map((r) => [r.articleId, r.k]));
    const verdict = new Map(fx.articles.map((a) => [a.articleId, a.verdict]));
    const byVerdict = Object.fromEntries(
      (['must_show', 'nice_to_have', 'skip'] as const).map((v) => [v, distribution(scored.filter((r) => verdict.get(r.articleId) === v).map((r) => r.k))]),
    );
    for (const [v, d] of Object.entries(byVerdict)) log(`  ${v.padEnd(13)} n ${d.n} median ${f3(d.median)} max ${f3(d.max)}`);

    let compare: Record<string, unknown> | null = null;
    const compareUrl = arg(argv, '--compare-url', '');
    if (compareUrl) {
      const other = kevUrlBackend(compareUrl);
      const otherRows = await scoreRows(other, rows, persona);
      const d = deltas(byId, new Map(otherRows.map((r) => [r.articleId, r.k])));
      compare = { label: other.label, ...d, distribution: distribution(otherRows.map((r) => r.k)) };
      log(`vs ${other.label}: mean ${f3(d.meanSigned)} median|d| ${d.medianAbs.toExponential(2)} max|d| ${d.maxAbs.toExponential(2)} (n ${d.n})`);
    }

    let cloud: Record<string, unknown> | null = null;
    const cloudRun = arg(argv, '--cloud-run', join(__dirname, '..', '..', '.local-test-data', 'runs', '20261016-194728-kev-full'));
    if (existsSync(join(cloudRun, 'kev-raw-1.json'))) {
      const raw = JSON.parse(readFileSync(join(cloudRun, 'kev-raw-1.json'), 'utf8')) as {
        articleId: string;
        answers?: { geo?: { score: number } };
      }[];
      const cloudK = new Map(raw.filter((r) => r.answers?.geo).map((r) => [r.articleId, (r.answers?.geo?.score as number) / LEVELS_MAX]));
      const cloudOnRows = rows.map((r) => cloudK.get(r.articleId)).filter((k): k is number => k !== undefined);
      const d = deltas(byId, cloudK);
      cloud = { run: cloudRun, ...d, distribution: distribution(cloudOnRows) };
      const cd = distribution(cloudOnRows);
      log(`cloud kev-4b (same rows, geo): median ${f3(cd.median)} max ${f3(cd.max)} >=0.62 ${cd.atOrAbove062}/${cd.n} | ${kev.label} minus cloud: mean ${f3(d.meanSigned)} median|d| ${f3(d.medianAbs)} max|d| ${f3(d.maxAbs)}`);
    }

    writer.writeJson('config', { gitSha: captureGitSha(), backend: kev.label, rows: rows.length, questions: KEV_QUESTIONS, kevCut: KEV_CUT });
    writer.writeJson('scores', scored);
    writer.finish({ backend: kev.label, deterministic, distribution: dist, byVerdict, latencyP50: q(lat, 0.5), latencyP95: q(lat, 0.95), compare, cloud });
    return deterministic ? 0 : 1;
  } finally {
    kev.stop();
  }
}

if (require.main === module) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(e); // eslint-disable-line no-console
      process.exit(1);
    });
}
