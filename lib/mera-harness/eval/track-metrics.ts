// mera-harness/eval: follow-card metrics (proposeTrack) and the More options
// check. Pure, over collected rows like agent-metrics.
//
// A staged card is read off the port's RESULT (`staged: true`, `options`), never
// the model's arguments: the port trims and drops blank labels, so the card is
// what the port accepted.

import { contentJaccard } from '../core/topic-similarity';
import { proseOf } from './copy-rules';
import type { TurnRows } from './agent-metrics';
import type { ScriptMoreOptions, ScriptTurn } from './types';

export interface TrackOption {
  label: string;
  search: string;
}

/** A More options new option must differ from every shown label by less than this. */
export const MORE_OPTIONS_MAX_JACCARD = 0.6;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

interface TrackTurn {
  scriptId: string;
  cohort: string;
  turnIndex: number;
  repeat: number;
  attempted: boolean;
  staged: boolean;
  refused: boolean;
  options: TrackOption[];
}

/** Per TURN, over its legs: the last staged card wins. */
function trackTurn(t: TurnRows): TrackTurn {
  const out: TrackTurn = {
    scriptId: t.scriptId, cohort: t.cohort, turnIndex: t.turnIndex, repeat: t.repeat,
    attempted: false, staged: false, refused: false, options: [],
  };
  for (const l of t.legs) {
    for (const c of l.toolCalls) {
      if (c.name !== 'proposeTrack') continue;
      out.attempted = true;
      const r = c.result && typeof c.result === 'object' ? (c.result as Record<string, unknown>) : null;
      if (r && r.staged === true && Array.isArray(r.options)) {
        out.staged = true;
        out.options = (r.options as unknown[]).flatMap((o) => {
          const rec = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
          return rec && typeof rec.label === 'string'
            ? [{ label: rec.label, search: typeof rec.search === 'string' ? rec.search : '' }]
            : [];
        });
      } else {
        out.refused = true;
      }
    }
  }
  return out;
}

export interface TrackReport {
  attempted: number;
  staged: number;
  refused: number;
  /** Staged cards by option count. */
  histogram: Record<number, number>;
  /** proposeTrack attempts on turns of a non-follow cohort. The bar is 0. */
  offCohortAttempts: number;
  expected: number;
  met: number;
  misses: { scriptId: string; turnIndex: number; repeat: number; detail: string }[];
}

export function trackReport(
  turns: readonly TurnRows[],
  expectFor: (scriptId: string, turnIndex: number) => ScriptTurn['expect'] | null,
  isFollowCohort: (cohort: string) => boolean = (c) => c.startsWith('follow'),
): TrackReport {
  const out: TrackReport = {
    attempted: 0, staged: 0, refused: 0, histogram: {}, offCohortAttempts: 0, expected: 0, met: 0, misses: [],
  };
  for (const t of turns) {
    if (t.legs.some((l) => l.moreOptions)) continue; // scored by moreOptionsReport
    const k = trackTurn(t);
    if (k.attempted) {
      out.attempted += 1;
      if (k.staged) {
        out.staged += 1;
        out.histogram[k.options.length] = (out.histogram[k.options.length] ?? 0) + 1;
      } else out.refused += 1;
      if (!isFollowCohort(t.cohort)) out.offCohortAttempts += 1;
    }
    const want = expectFor(t.scriptId, t.turnIndex)?.track;
    if (!want || t.endedOn === 'transport_error') continue;
    out.expected += 1;
    const why: string[] = [];
    if (want.staged !== k.staged) why.push(want.staged ? 'no card staged' : `card staged (${k.options.length} options)`);
    else if (k.staged) {
      const n = k.options.length;
      if (want.minOptions !== undefined && n < want.minOptions) why.push(`${n} options, wanted at least ${want.minOptions}`);
      if (want.maxOptions !== undefined && n > want.maxOptions) why.push(`${n} options, wanted at most ${want.maxOptions}`);
      const labels = k.options.map((o) => o.label.toLowerCase());
      if (want.labelMatches && !want.labelMatches.some((m) => labels.some((l) => l.includes(m)))) {
        why.push(`no label has any of ${want.labelMatches.join(', ')}`);
      }
      const bad = (want.labelExcludes ?? []).filter((x) => labels.some((l) => l.includes(x)));
      if (bad.length > 0) why.push(`label contains ${bad.join(', ')}`);
    }
    if (why.length === 0) out.met += 1;
    else out.misses.push({ scriptId: t.scriptId, turnIndex: t.turnIndex, repeat: t.repeat, detail: why.join('; ') });
  }
  return out;
}

// ---------------------------------------------------------------------------
// More options
// ---------------------------------------------------------------------------

export type GroundingFlag = 'copied-example' | 'ended-season' | 'no-entity';

export interface MoreOptionsTurn {
  scriptId: string;
  turnIndex: number;
  repeat: number;
  options: TrackOption[];
  /** Options too close to a shown one (label Jaccard >= 0.6 or the same normalised search text). */
  repeated: number;
  flags: { option: string; flag: GroundingFlag }[];
  /** The leg wrote prose; the loop discards it, so any is wasted tokens. */
  prose: boolean;
  passed: boolean;
}

export interface MoreOptionsReport {
  turns: MoreOptionsTurn[];
  passed: number;
  options: number;
  repeated: number;
  flags: Record<GroundingFlag, number>;
  proseWritten: number;
}

/** A four-digit year in an option, earlier than this year, names a season that ended. */
const yearsIn = (s: string): number[] => (s.match(/\b(19|20)\d{2}\b/g) ?? []).map(Number);

export function moreOptionsReport(
  turns: readonly TurnRows[],
  moreFor: (scriptId: string, turnIndex: number) => ScriptMoreOptions | null,
  opts: { examples: readonly string[]; nowYear: number },
): MoreOptionsReport {
  const out: MoreOptionsReport = {
    turns: [], passed: 0, options: 0, repeated: 0,
    flags: { 'copied-example': 0, 'ended-season': 0, 'no-entity': 0 }, proseWritten: 0,
  };
  const examples = new Set(opts.examples.map(norm));
  for (const t of turns) {
    if (!t.legs.some((l) => l.moreOptions)) continue;
    const shown = moreFor(t.scriptId, t.turnIndex)?.shown ?? [];
    const k = trackTurn(t);
    const shownSearch = new Set(shown.map((s) => norm(s.searchText)));
    let repeated = 0;
    const flags: MoreOptionsTurn['flags'] = [];
    for (const o of k.options) {
      const tooClose =
        shown.some((s) => contentJaccard(o.label, s.label) >= MORE_OPTIONS_MAX_JACCARD) || shownSearch.has(norm(o.search));
      if (tooClose) repeated += 1;
      if (examples.has(norm(o.label))) flags.push({ option: o.label, flag: 'copied-example' });
      if ([...yearsIn(o.label), ...yearsIn(o.search)].some((y) => y < opts.nowYear)) {
        flags.push({ option: o.label, flag: 'ended-season' });
      }
      if (!/(^|\s)\p{Lu}/u.test(o.search)) flags.push({ option: o.label, flag: 'no-entity' });
    }
    const prose = t.legs.some((l) => proseOf(l.rawOutput).trim() !== '');
    const passed = k.options.length >= 1 && repeated === 0;
    out.turns.push({
      scriptId: t.scriptId, turnIndex: t.turnIndex, repeat: t.repeat, options: k.options, repeated, flags, prose, passed,
    });
    if (passed) out.passed += 1;
    out.options += k.options.length;
    out.repeated += repeated;
    for (const f of flags) out.flags[f.flag] += 1;
    if (prose) out.proseWritten += 1;
  }
  return out;
}
