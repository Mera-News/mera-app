// harness-local: which turns an agent-corpus run sends (--tier, --only), the
// lane pool that sends them (--lanes), and the count-matched exclusion of an
// errored (script, repeat) cell. Node-only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentScript, EvalRow } from '../../lib/mera-harness/eval/types';

/** Pre-registered, tracked. Outside fixtures/scripts/, which the runner globs. */
export const TIERS_PATH = join(__dirname, '../../lib/mera-harness/eval/fixtures/tiers.json');

/** Script id -> the turn indexes to send (null = every turn). A script not named is not sent. */
export type TurnSelection = Record<string, number[] | null>;

export function loadTier(name: string, path = TIERS_PATH): TurnSelection {
  const tiers = JSON.parse(readFileSync(path, 'utf8')) as Record<string, TurnSelection>;
  if (!tiers[name]) throw new Error(`harness-local: no tier '${name}' in ${path}. Known: ${Object.keys(tiers).join(', ')}.`);
  return tiers[name];
}

/** `--only good` or `--only backref:2,3`, repeatable. */
export function addOnly(sel: TurnSelection, spec: string): void {
  const [id, list] = spec.split(':');
  sel[id] = list === undefined ? null : list.split(',').map(Number);
}

/**
 * Keeps the selected scripts (in their load order) and turns. Turns keep their
 * ORIGINAL index, so rows still key to past runs. A kept choice reply needs its
 * question turn: without it the runner would send a bare option as typed text.
 */
export function selectTurns(scripts: readonly AgentScript[], sel: TurnSelection): AgentScript[] {
  for (const id of Object.keys(sel)) {
    if (!scripts.some((s) => s.id === id)) throw new Error(`harness-local: the selection names script '${id}', which was not loaded.`);
  }
  return scripts.filter((s) => s.id in sel).map((s) => {
    const keep = sel[s.id];
    for (const i of keep ?? []) if (!s.turns.some((t) => t.index === i)) throw new Error(`harness-local: ${s.id} has no turn ${i}.`);
    const turns = keep === null ? s.turns : s.turns.filter((t) => keep.includes(t.index));
    for (const t of turns) {
      if (t.chooses !== undefined && !turns.some((p) => p.index === t.index - 1)) {
        throw new Error(`harness-local: ${s.id} turn ${t.index} is a choice reply but turn ${t.index - 1} is not selected.`);
      }
    }
    return { ...s, turns };
  });
}

/**
 * Runs every job through `lanes` workers. The first throw (a spend limit, or
 * anything else) stops the pool taking jobs; jobs in flight finish so their
 * rows are written, then that throw is rethrown.
 */
export async function runPool<T>(jobs: readonly T[], lanes: number, run: (job: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: { err: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (!failed && next < jobs.length) {
      try {
        await run(jobs[next++]);
      } catch (err) {
        failed ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, lanes) }, lane));
  if (failed) throw (failed as { err: unknown }).err;
}

/** `script|repeat` for every cell with an error row in ANY arm: dropped from every arm's report. */
export function erroredCells(rows: readonly EvalRow[]): Set<string> {
  return new Set(rows.filter((r) => r.error !== null).map((r) => `${r.scriptId}|${r.repeat}`));
}
