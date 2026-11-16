// harness-local — score a run-newsharness-corpus run against a calibration
// fixture's per-article targets. No calls, spends nothing.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/score-calibration.ts \
//     <runDir>... [--fixture harness-local/fixtures/calibration-tangential.json] [--need 0.8]
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/score-calibration.ts --selftest
//
// Targets live on each fixture article as `calibration: {group, min?, max?}`
// and apply to the FINAL score: pass 1 unless a reason row in the same
// (arm, repeat) cell carries a parsed rescore (the join rule of the RESCORE
// REPORT). An item passes a repeat when its score sits inside [min, max]. It
// passes the run when it passes in >= `--need` (default 0.8, i.e. 4 of 5) of
// the repeats. A missing score is a FAIL, never a skip: an arm that returned
// nothing must not look calibrated. Exit 1 when any item fails.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readJsonl } from '../lib/agreement';
import type { RunRow } from '../lib/jsonl-writer';

export interface CalibrationTarget { group: 'KEEP' | 'MAYBE' | 'CUT' | 'HIDDEN'; min?: number; max?: number }
export interface CalibrationFixture {
  personaFacts: { statement: string }[];
  articles: { articleId: string; title: string; calibration: CalibrationTarget }[];
}

/** articleId -> final score, per `arm::repeat` cell. */
export function finalScores(rows: Pick<RunRow, 'arm' | 'repeat' | 'callType' | 'parsedSchema' | 'items'>[]): Map<string, Map<string, number>> {
  const cells = new Map<string, Map<string, number>>();
  const cell = (k: string) => cells.get(k) ?? cells.set(k, new Map()).get(k)!;
  for (const r of rows) {
    const key = `${r.arm}::${r.repeat}`;
    const p = r.parsedSchema as { byId?: { articleId: string; s: number | null }[]; score?: number } | null;
    if (r.callType === 'relevance-batch') {
      for (const e of p?.byId ?? []) if (typeof e.s === 'number') cell(key).set(e.articleId, e.s);
    }
  }
  // pass 2 overrides pass 1 for the ids it rescored
  for (const r of rows) {
    const p = r.parsedSchema as { score?: number } | null;
    const id = (r.items as { id: string }[] | null)?.[0]?.id;
    if (r.callType === 'reason' && id && typeof p?.score === 'number') cell(`${r.arm}::${r.repeat}`).set(id, p.score);
  }
  return cells;
}

export interface ItemResult { articleId: string; title: string; group: string; passes: number; repeats: number; ok: boolean; scores: (number | null)[] }

export function scoreArm(fx: CalibrationFixture, cells: Map<string, Map<string, number>>, arm: string, need: number): ItemResult[] {
  const reps = [...cells.keys()].filter((k) => k.startsWith(`${arm}::`)).sort();
  return fx.articles.map((a) => {
    const { min = -Infinity, max = Infinity } = a.calibration;
    const scores = reps.map((k) => cells.get(k)!.get(a.articleId) ?? null);
    const passes = scores.filter((s) => s !== null && s >= min && s <= max).length;
    return { articleId: a.articleId, title: a.title, group: a.calibration.group, passes, repeats: reps.length, scores,
      // targetless items (MAYBE without a bar) are reported, never failed
      ok: a.calibration.min === undefined && a.calibration.max === undefined ? true : reps.length > 0 && passes >= Math.ceil(need * reps.length) };
  });
}

function report(fx: CalibrationFixture, rows: RunRow[], need: number): boolean {
  const cells = finalScores(rows);
  const arms = [...new Set([...cells.keys()].map((k) => k.split('::')[0]))].sort();
  let allOk = true;
  for (const arm of arms) {
    const res = scoreArm(fx, cells, arm, need);
    console.log(`\n== ${arm}  (${res[0]?.repeats ?? 0} repeats, need ${Math.round(need * 100)}%) ==`);
    for (const g of ['KEEP', 'MAYBE', 'CUT', 'HIDDEN']) {
      const rs = res.filter((r) => r.group === g);
      console.log(`${g.padEnd(7)} ${rs.filter((r) => r.ok).length}/${rs.length} within target`);
    }
    for (const r of res.filter((x) => !x.ok)) {
      allOk = false;
      console.log(`  FAIL ${r.group} ${r.passes}/${r.repeats}  [${r.scores.map((s) => s?.toFixed(2) ?? '-').join(' ')}]  ${r.title.slice(0, 70)}`);
    }
  }
  if (arms.length === 0) { console.log('no relevance-batch rows found'); return false; }
  return allOk;
}

// ---------------------------------------------------------------------------

const PRIVATE_WORDS = /owner-private-placeholder/i;

function selftest(): number {
  let f = 0;
  const ck = (n: string, ok: boolean) => { if (!ok) f++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); };
  const fx: CalibrationFixture = { personaFacts: [], articles: [
    { articleId: 'k', title: 'keep', calibration: { group: 'KEEP', min: 0.6 } },
    { articleId: 'c', title: 'cut', calibration: { group: 'CUT', max: 0.39 } },
    { articleId: 'r', title: 'routine', calibration: { group: 'CUT', min: 0.4, max: 0.59 } },
    { articleId: 'm', title: 'free', calibration: { group: 'MAYBE' } },
  ] };
  const batch = (arm: string, repeat: number, s: Record<string, number>) => ({
    arm, repeat, callType: 'relevance-batch' as const, items: null,
    parsedSchema: { byId: Object.entries(s).map(([articleId, v]) => ({ articleId, s: v })) },
  });
  const reason = (arm: string, repeat: number, id: string, score: number) => ({
    arm, repeat, callType: 'reason' as const, items: [{ id }], parsedSchema: { score },
  });
  const good = { k: 0.8, c: 0.2, r: 0.5, m: 0.9 };
  const rows = (s: Record<string, number>, n = 5) => Array.from({ length: n }, (_, i) => batch('A', i, s));
  const run = (rs: ReturnType<typeof batch>[] | (ReturnType<typeof batch> | ReturnType<typeof reason>)[]) =>
    scoreArm(fx, finalScores(rs as never), 'A', 0.8);

  ck('healthy run passes every gated item', run(rows(good)).every((r) => r.ok));
  // positive controls: each planted miss must FAIL
  ck('CONTROL: a KEEP below 0.6 fails', !run(rows({ ...good, k: 0.5 })).find((r) => r.articleId === 'k')!.ok);
  ck('CONTROL: a CUT at 0.6 fails', !run(rows({ ...good, c: 0.6 })).find((r) => r.articleId === 'c')!.ok);
  ck('CONTROL: routine above 0.59 fails', !run(rows({ ...good, r: 0.6 })).find((r) => r.articleId === 'r')!.ok);
  ck('CONTROL: routine below 0.4 fails', !run(rows({ ...good, r: 0.3 })).find((r) => r.articleId === 'r')!.ok);
  const lastBad = [...rows(good, 4), batch('A', 4, { ...good, k: 0.1 })];
  ck('4 of 5 repeats is enough', run(lastBad).find((r) => r.articleId === 'k')!.ok);
  const twoBad = [...rows(good, 3), batch('A', 3, { ...good, k: 0.1 }), batch('A', 4, { ...good, k: 0.1 })];
  ck('CONTROL: 3 of 5 repeats fails', !run(twoBad).find((r) => r.articleId === 'k')!.ok);
  ck('CONTROL: a missing score fails, not skips', !run(rows({ c: 0.2, r: 0.5, m: 0.9 })).find((r) => r.articleId === 'k')!.ok);
  ck('a targetless MAYBE never fails', run(rows({ ...good, m: 0 })).find((r) => r.articleId === 'm')!.ok);
  // the join rule: a pass-2 score overrides pass 1, and a decoder that ignored it would miss this
  const resc = [...rows(good), ...Array.from({ length: 5 }, (_, i) => reason('A', i, 'k', 0.3))];
  ck('CONTROL: a reason-row rescore overrides pass 1 (KEEP 0.8 -> 0.3 fails)', !run(resc).find((r) => r.articleId === 'k')!.ok);
  ck('empty run reports no repeats and fails', !run([]).find((r) => r.articleId === 'k')!.ok);

  // the committed fixture
  const path = join(__dirname, '..', 'fixtures', 'calibration-tangential.json');
  const raw = readFileSync(path, 'utf8');
  const real = JSON.parse(raw) as CalibrationFixture;
  const ids = new Set(real.articles.map((a) => a.articleId));
  ck('fixture: unique ids', ids.size === real.articles.length);
  ck('fixture: every article has a group target', real.articles.every((a) => ['KEEP', 'MAYBE', 'CUT', 'HIDDEN'].includes(a.calibration?.group)));
  const n = (g: string) => real.articles.filter((a) => a.calibration.group === g).length;
  ck('fixture: 2 KEEP, 4 MAYBE, 14 CUT, 14 HIDDEN', n('KEEP') === 2 && n('MAYBE') === 4 && n('CUT') === 14 && n('HIDDEN') === 14);
  ck('fixture: the ended-trip fact is present', real.personaFacts.some((p) => /Slush/.test(p.statement)));
  ck('fixture: no owner-private words', !PRIVATE_WORDS.test(raw));
  ck('CONTROL: the privacy check fires on a planted leak', PRIVATE_WORDS.test(raw + ' Bhopal'));

  console.log(f === 0 ? '\nALL PASS' : `\n${f} FAILURE(S)`);
  return f === 0 ? 0 : 1;
}

if (/score-calibration\.ts$/.test(process.argv[1] ?? '')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  const flag = (n: string, d: string) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const fixture = resolve(flag('--fixture', join(__dirname, '..', 'fixtures', 'calibration-tangential.json')));
  const need = Number(flag('--need', '0.8'));
  const skip = new Set(['--fixture', '--need']);
  const dirs = argv.filter((a, i) => !a.startsWith('--') && !skip.has(argv[i - 1] ?? ''));
  if (dirs.length === 0) { console.error('usage: score-calibration.ts <runDir>... [--fixture f] [--need 0.8] | --selftest'); process.exit(2); }
  const rows = dirs.flatMap((d) => {
    const p = join(resolve(d), 'rows.jsonl');
    if (!existsSync(p)) throw new Error(`no rows.jsonl in ${d}`);
    return readJsonl(p);
  });
  process.exit(report(JSON.parse(readFileSync(fixture, 'utf8')) as CalibrationFixture, rows, need) ? 0 : 1);
}
