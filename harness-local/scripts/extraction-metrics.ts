// harness-local - mechanical checks for the chat-extraction runs.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/extraction-metrics.ts <runDir>
//
// Extraction is judged WITHOUT a rater, because the two things that matter are
// countable. No blinding is needed and no rater floor applies.
//
// EM DASHES. Invariant: no em dashes and no AI-sounding punctuation in
// user-facing copy. A saved fact statement IS user-facing: it is rendered back
// on the persona card. So the rate is computed over what the model proposed to
// SAVE, not just over its prose, and both are reported since a prompt can fix
// one without the other.
//
// TURN-0 TOOL AGREEMENT. Turn 0 is the only turn whose prompt is fully
// determined by the fixture, so its repeats are directly comparable and any
// disagreement is model noise rather than divergent persona state. Later turns
// carry what earlier turns saved and are expected to differ, which is why they
// are reported separately rather than averaged in.
//
// Node-only: never imported by the app bundle.

import { join, resolve } from 'node:path';
import { readJsonl } from '../lib/agreement';
import type { RunRow } from '../lib/jsonl-writer';

/** The characters the invariant bans from user-facing copy.
 *
 *  The en dash counts ONLY when used AS a dash, that is with a non-digit on at
 *  least one side. "2019-2024" is a range and legitimate; "the plan - and then"
 *  is the tell. Counting every en dash would score date ranges as violations
 *  and make the rate useless on news text, which is full of them. */
const EM_DASH = /—/;
const EN_DASH_AS_DASH = /(^|[^0-9])–|–([^0-9]|$)/;
function hasBannedDash(text: string): boolean {
  return EM_DASH.test(text) || EN_DASH_AS_DASH.test(text);
}

/**
 * The assistant PROSE, which is what a user actually reads. A reasoning trace
 * and any tool-call payload are stripped first: a dash inside a think block or
 * inside JSON arguments never reaches the user, and counting it would blame a
 * prompt for a violation it did not produce.
 */
function proseOf(row: RunRow): string {
  let text = row.rawOutput;
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const lastCloser = text.lastIndexOf('</think>');
  if (lastCloser !== -1) text = text.slice(lastCloser + '</think>'.length);
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/\{[\s\S]*?"extracted_user_information"[\s\S]*?\}\s*\}/g, '');
  return text.trim();
}

function statementsOf(row: RunRow): string[] {
  const out: string[] = [];
  for (const t of row.toolCalls) {
    const entries = (t.parsed as { extracted_user_information?: unknown } | null)?.extracted_user_information;
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (typeof e === 'string') out.push(e);
      else if (e && typeof e === 'object' && typeof (e as { statement?: unknown }).statement === 'string') {
        out.push((e as { statement: string }).statement);
        const alts = (e as { alternatives?: unknown }).alternatives;
        if (Array.isArray(alts)) for (const a of alts) if (typeof a === 'string') out.push(a);
      }
    }
  }
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? '   -' : `${((n / d) * 100).toFixed(1)}%`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const runDir = argv.find((a) => !a.startsWith('--'));
  if (!runDir) throw new Error('harness-local: pass a run directory.');
  const rows = readJsonl(join(resolve(runDir), 'rows.jsonl')).filter((r) => r.dupOf === null);
  const chat = rows.filter((r) => r.callType === 'chat-extraction');
  if (chat.length === 0) throw new Error('harness-local: no chat-extraction rows in that run.');

  const arms = [...new Set(chat.map((r) => r.arm))].sort();

  // ---- banned dashes, per variant per cohort, over PROSE -------------------
  const variants = [...new Set(chat.map((r) => r.variant))].sort();
  const cohorts = [...new Set(chat.map((r) => r.cohort))].sort();
  // eslint-disable-next-line no-console
  console.log(`BANNED DASH RATE over assistant PROSE (think and tool payloads stripped), ${chat.length} row(s)`);
  // eslint-disable-next-line no-console
  console.log(`  ${'variant | cohort'.padEnd(40)}${'turns'.padStart(7)}${'w/prose'.padStart(9)}${'prose'.padStart(9)}${'stmts'.padStart(8)}${'bad stmts'.padStart(11)}`);
  for (const v of variants) {
    for (const c of cohorts) {
      const rs = chat.filter((r) => r.variant === v && r.cohort === c);
      if (rs.length === 0) continue;
      // Denominator is rows that HAVE prose. A turn whose reply was only a tool
      // call has no prose and cannot violate a punctuation rule, so counting it
      // dilutes the rate toward zero and makes two arms look closer than they
      // are. The raw turn count is shown beside it so nothing is hidden.
      const withProse = rs.filter((r) => proseOf(r).length > 0);
      const bad = withProse.filter((r) => hasBannedDash(proseOf(r))).length;
      const stmts = rs.flatMap(statementsOf);
      const badStmts = stmts.filter((x) => hasBannedDash(x)).length;
      // eslint-disable-next-line no-console
      console.log(
        `  ${`${v} | ${c}`.padEnd(40).slice(0, 40)}${String(rs.length).padStart(7)}${String(withProse.length).padStart(9)}` +
          `${pct(bad, withProse.length).padStart(9)}${String(stmts.length).padStart(8)}${pct(badStmts, stmts.length).padStart(11)}`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(`  ${'TOTAL per variant'.padEnd(40)}`);
  for (const v of variants) {
    const rs = chat.filter((r) => r.variant === v);
    const withProse = rs.filter((r) => proseOf(r).length > 0);
    const bad = withProse.filter((r) => hasBannedDash(proseOf(r))).length;
    const stmts = rs.flatMap(statementsOf);
    // eslint-disable-next-line no-console
    console.log(
      `  ${v.padEnd(40).slice(0, 40)}${String(rs.length).padStart(7)}${String(withProse.length).padStart(9)}` +
        `${pct(bad, withProse.length).padStart(9)}` +
        `${String(stmts.length).padStart(8)}${pct(stmts.filter((x) => hasBannedDash(x)).length, stmts.length).padStart(11)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log('  w/prose = rows with any prose after stripping; the rate is over THOSE, since a');
  // eslint-disable-next-line no-console
  console.log('  tool-only reply cannot violate a punctuation rule and would dilute the rate.');
  // eslint-disable-next-line no-console
  console.log('  prose = what the user reads. stmts = the SAVED fact statements, also user-facing');
  // eslint-disable-next-line no-console
  console.log('  (they render on the persona card), so a prompt can fix one and not the other.');
  // eslint-disable-next-line no-console
  console.log('  An en dash counts only when used AS a dash; "2019-2024" is a range, not a violation.');

  // ---- turn-0 tool agreement ------------------------------------------------
  // eslint-disable-next-line no-console
  console.log('\nTURN-0 TOOL AGREEMENT (the only fixture-determined turn, so repeats are comparable)');
  // eslint-disable-next-line no-console
  console.log(`  ${'variant | cohort'.padEnd(40)}${'reps'.padStart(6)}${'same tools'.padStart(12)}${'same stmts'.padStart(12)}${'schema ok'.padStart(11)}`);
  const cells = new Map<string, RunRow[]>();
  for (const r of chat.filter((x) => x.turnIndex === 0)) {
    const k = `${r.variant} | ${r.cohort}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  for (const [k, rs] of [...cells.entries()].sort()) {
    const toolSets = rs.map((r) => r.toolCalls.map((t) => t.name).sort().join(','));
    const stmtSets = rs.map((r) => statementsOf(r).map((s) => s.toLowerCase().trim()).sort().join('|'));
    const allSameTools = new Set(toolSets).size === 1;
    const allSameStmts = new Set(stmtSets).size === 1;
    const schemaOk = rs.filter((r) => r.toolCalls.every((t) => t.schemaValid)).length;
    // eslint-disable-next-line no-console
    console.log(
      `  ${k.padEnd(40).slice(0, 40)}${String(rs.length).padStart(6)}${(allSameTools ? 'yes' : 'NO').padStart(12)}` +
        `${(allSameStmts ? 'yes' : 'NO').padStart(12)}${pct(schemaOk, rs.length).padStart(11)}`,
    );
  }

  // ---- what the rails did ---------------------------------------------------
  // eslint-disable-next-line no-console
  console.log('\nRAILS, per arm (from personaStateDelta, the app own filter and detectors)');
  // eslint-disable-next-line no-console
  console.log(`  ${'arm'.padEnd(40)}${'committed'.padStart(11)}${'rejected'.padStart(10)}${'conflicts'.padStart(11)}${'truncated'.padStart(11)}`);
  for (const arm of arms) {
    const rs = chat.filter((r) => r.arm === arm);
    const added = rs.reduce((n, r) => n + (r.personaStateDelta?.added.length ?? 0), 0);
    const rej = rs.reduce((n, r) => n + (r.personaStateDelta?.rejectedByRails.length ?? 0), 0);
    const con = rs.reduce((n, r) => n + (r.personaStateDelta?.conflicts.length ?? 0), 0);
    const trunc = rs.filter((r) => r.truncated).length;
    // eslint-disable-next-line no-console
    console.log(
      `  ${arm.padEnd(40).slice(0, 40)}${String(added).padStart(11)}${String(rej).padStart(10)}` +
        `${String(con).padStart(11)}${String(trunc).padStart(11)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log('  rejected counts what filterFactChoiceGroups refused, mostly duplicates of facts');
  // eslint-disable-next-line no-console
  console.log('  the persona already held. A prompt that stops re-proposing them moves this number.');
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
