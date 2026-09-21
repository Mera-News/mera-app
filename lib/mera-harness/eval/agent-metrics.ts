// mera-harness/eval — per-turn and per-leg metrics over collected rows. Pure.
//
// READING ORDER IS PART OF THE RESULT. Damage before quality, quality before
// cost. Every block below states what it must NOT be read as, because most of
// these numbers have a way of looking good for the wrong reason.

import { hasBannedDash, proseOf } from './copy-rules';
import type { EvalRow, ScriptTurn, TurnEnd } from './types';

// ---------------------------------------------------------------------------
// Turn assembly
// ---------------------------------------------------------------------------

export interface TurnRows {
  scriptId: string;
  cohort: string;
  turnIndex: number;
  repeat: number;
  arm: string;
  /** Agent legs in order. Excludes the terminal topic-gen call, which is not a
   *  leg and must not inflate the leg count. */
  legs: EvalRow[];
  topicRows: EvalRow[];
  endedOn: TurnEnd | null;
}

export function groupTurns(rows: readonly EvalRow[]): TurnRows[] {
  const byTurn = new Map<string, TurnRows>();
  for (const r of rows) {
    const key = `${r.arm}|${r.scriptId}|${r.repeat}|${r.turnIndex}`;
    let t = byTurn.get(key);
    if (!t) {
      t = {
        scriptId: r.scriptId,
        cohort: r.cohort,
        turnIndex: r.turnIndex,
        repeat: r.repeat,
        arm: r.arm,
        legs: [],
        topicRows: [],
        endedOn: null,
      };
      byTurn.set(key, t);
    }
    if (r.callType === 'agent-topicgen') t.topicRows.push(r);
    else t.legs.push(r);
    if (r.endedOn) t.endedOn = r.endedOn;
  }
  for (const t of byTurn.values()) t.legs.sort((a, b) => a.legIndex - b.legIndex);
  return [...byTurn.values()];
}

// ---------------------------------------------------------------------------
// Router and skill: TWO ALPHABETS, never pooled
// ---------------------------------------------------------------------------

export interface RouteOutcome {
  cohort: string;
  scriptId: string;
  turnIndex: number;
  expected: string;
  actual: string | null;
  correct: boolean;
}

export interface RouterReport {
  /** PER COHORT. Never pooled: turn-0 tool choice already disagrees across
   *  repeats in the adversarial cohort in both prompt variants and in no other,
   *  so a pooled rate hides which cohort moved. */
  byCohort: Record<string, { n: number; correct: number }>;
  /** expected -> actual -> count. A bare percentage does not say which way it
   *  failed, and the direction is the actionable half. */
  confusion: Record<string, Record<string, number>>;
  /** A route that did not parse. Counted apart from a wrong route: the core
   *  never defaults routeKind, because a defaulted route scores as correct and
   *  inflates accuracy. */
  unparsed: number;
}

/** One outcome per TURN, read off its last leg. A turn is the unit that has a
 *  route, not a leg, and every leg repeats the value. */
export function routeOutcomes(turns: readonly TurnRows[]): RouteOutcome[] {
  const out: RouteOutcome[] = [];
  for (const t of turns) {
    const last = t.legs[t.legs.length - 1];
    if (!last) continue;
    const actual = last.routeKind;
    out.push({
      cohort: t.cohort,
      scriptId: t.scriptId,
      turnIndex: t.turnIndex,
      expected: last.expectedRouteKind,
      // The core returns null for "no kind"; a fixture spells that `none`.
      actual: actual ?? 'none',
      correct: (actual ?? 'none') === last.expectedRouteKind,
    });
  }
  return out;
}

/** One skill outcome per turn, likewise off its last leg. */
export function skillOutcomes(
  turns: readonly TurnRows[],
): { expectedSkill: string; loaded: string | null; routeCorrect: boolean }[] {
  const out: { expectedSkill: string; loaded: string | null; routeCorrect: boolean }[] = [];
  for (const t of turns) {
    const last = t.legs[t.legs.length - 1];
    if (!last) continue;
    out.push({
      expectedSkill: last.expectedSkill,
      loaded: last.skillLoaded,
      routeCorrect: (last.routeKind ?? 'none') === last.expectedRouteKind,
    });
  }
  return out;
}

export function routerReport(outcomes: readonly RouteOutcome[]): RouterReport {
  const byCohort: RouterReport['byCohort'] = {};
  const confusion: RouterReport['confusion'] = {};
  let unparsed = 0;
  for (const o of outcomes) {
    const c = (byCohort[o.cohort] ??= { n: 0, correct: 0 });
    c.n += 1;
    if (o.correct) c.correct += 1;
    if (o.actual === null) unparsed += 1;
    const row = (confusion[o.expected] ??= {});
    const key = o.actual ?? '(unparsed)';
    row[key] = (row[key] ?? 0) + 1;
  }
  return { byCohort, confusion, unparsed };
}

export type SkillOutcome = 'correct' | 'wrong-id' | 'none-loaded' | 'nonexistent-id';

export interface SkillReport {
  /** FOUR outcomes, not two. "Invented an id that does not exist" is a
   *  different failure from "picked the wrong real one", and loadSkill
   *  returning null cannot tell them apart, which is why the core exposes the
   *  id list separately. */
  outcomes: Record<SkillOutcome, number>;
  /** The cell that matters: fact_update splits between facts/<subject> and
   *  conversation/correction, so a pooled "got it right" rate hides exactly
   *  the split this measures. */
  routeCorrectSkillWrong: number;
  /** Chance is 1-in-5 for a route and 1-in-13 for a skill, so the same
   *  percentage means different things in the two blocks and neither is
   *  comparable to the other. Recorded so a reader cannot forget. */
  distinctSkillIds: number;
}

export function skillReport(
  rows: readonly { expectedSkill: string; loaded: string | null; routeCorrect: boolean }[],
  knownSkillIds: readonly string[],
): SkillReport {
  const known = new Set(knownSkillIds);
  const outcomes: Record<SkillOutcome, number> = {
    correct: 0,
    'wrong-id': 0,
    'none-loaded': 0,
    'nonexistent-id': 0,
  };
  let routeCorrectSkillWrong = 0;
  for (const r of rows) {
    let o: SkillOutcome;
    if (r.loaded === null) o = 'none-loaded';
    else if (r.loaded === r.expectedSkill) o = 'correct';
    else if (!known.has(r.loaded)) o = 'nonexistent-id';
    else o = 'wrong-id';
    outcomes[o] += 1;
    if (o !== 'correct' && r.routeCorrect) routeCorrectSkillWrong += 1;
  }
  return { outcomes, routeCorrectSkillWrong, distinctSkillIds: known.size };
}

// ---------------------------------------------------------------------------
// Tool validity
// ---------------------------------------------------------------------------

export interface ToolValidityReport {
  byTool: Record<string, { calls: number; unparseable: number; schemaInvalid: number }>;
  unknownToolCalls: number;
}

export function toolValidityReport(rows: readonly EvalRow[]): ToolValidityReport {
  const byTool: ToolValidityReport['byTool'] = {};
  let unknownToolCalls = 0;
  for (const r of rows) {
    for (const t of r.toolCalls) {
      const e = (byTool[t.name] ??= { calls: 0, unparseable: 0, schemaInvalid: 0 });
      e.calls += 1;
      if (t.parsed === null) e.unparseable += 1;
      else if (!t.schemaValid) e.schemaInvalid += 1;
      if (t.unknownTool) unknownToolCalls += 1;
    }
  }
  return { byTool, unknownToolCalls };
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

export interface LegReport {
  histogram: Record<number, number>;
  /** A cap hit on a fixture whose expect.legs is BELOW the cap. Kept apart
   *  from a routine cap hit: on the residence fixture the normal turn is three
   *  legs, so a cap there is a planted failure and not traffic. */
  cappedBelowExpectation: { scriptId: string; turnIndex: number; expected: number; actual: number }[];
  /** A turn that ended early on a transport failure. CORRECT behaviour, and
   *  counted as such rather than as a leg-count mismatch: without this the
   *  failure fixtures would show a standing red on every repeat. */
  endedOnTransportError: number;
  legCountMismatches: { scriptId: string; turnIndex: number; expected: number; actual: number }[];
}

export function legReport(
  turns: readonly TurnRows[],
  expectFor: (scriptId: string, turnIndex: number) => ScriptTurn['expect'] | null,
): LegReport {
  const histogram: Record<number, number> = {};
  const cappedBelowExpectation: LegReport['cappedBelowExpectation'] = [];
  const legCountMismatches: LegReport['legCountMismatches'] = [];
  let endedOnTransportError = 0;

  for (const t of turns) {
    const n = t.legs.length;
    histogram[n] = (histogram[n] ?? 0) + 1;
    if (t.endedOn === 'transport_error') {
      endedOnTransportError += 1;
      // Ending early here is right, so it is not a mismatch.
      continue;
    }
    const expect = expectFor(t.scriptId, t.turnIndex);
    if (!expect) continue;
    if (t.endedOn === 'leg_cap' && expect.legs < 4) {
      cappedBelowExpectation.push({
        scriptId: t.scriptId,
        turnIndex: t.turnIndex,
        expected: expect.legs,
        actual: n,
      });
    }
    if (n !== expect.legs) {
      legCountMismatches.push({
        scriptId: t.scriptId,
        turnIndex: t.turnIndex,
        expected: expect.legs,
        actual: n,
      });
    }
  }
  return { histogram, cappedBelowExpectation, endedOnTransportError, legCountMismatches };
}

// ---------------------------------------------------------------------------
// Time to first prose
// ---------------------------------------------------------------------------

export interface FirstProseReport {
  /** Per arm, the per-turn values in ms. Turns with no prose are EXCLUDED,
   *  never zeroed: an ask_choice turn legitimately has none, and a zero drags
   *  the median down and flatters the arm. */
  byArm: Record<string, number[]>;
  turnsWithoutProse: number;
}

/**
 * Spans legs on purpose.
 *
 * Per-leg ttVisibleMs CANNOT express this. The routing leg emits no prose, so
 * it is excluded from that statistic entirely, and an agent that spends a whole
 * extra leg before the first token shows an UNCHANGED per-leg figure while the
 * user's wait has doubled. Reading the per-leg column alone would report "no
 * latency regression" on exactly the regression this measures.
 */
export function firstProseReport(turns: readonly TurnRows[]): FirstProseReport {
  const byArm: Record<string, number[]> = {};
  let turnsWithoutProse = 0;
  for (const t of turns) {
    const first = t.legs.find((l) => l.ttVisibleMs !== null);
    if (!first || first.ttVisibleMs === null) {
      turnsWithoutProse += 1;
      continue;
    }
    const ms = first.legStartedAtMs + first.ttVisibleMs - first.turnStartedAtMs;
    (byArm[t.arm] ??= []).push(ms);
  }
  return { byArm, turnsWithoutProse };
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

export const FIRST_PROSE_P50_MULTIPLE = 1.5;
export const FIRST_PROSE_P95_MULTIPLE = 2.0;

export interface FirstProseGate {
  armP50: number | null;
  armP95: number | null;
  controlP50: number | null;
  controlP95: number | null;
  passed: boolean;
  /** Stated with the number, always. Fakes answer instantly, so these are a
   *  FLOOR and the bias is not neutral: the agent arms make more tool calls
   *  than the one-shot control, so zero-latency fakes flatter the agent and
   *  this ratio UNDERSTATES the agent's real first-prose time. A gate passing
   *  at 1.4x here could exceed 1.5x on a device. */
  biasNote: string;
}

export function firstProseGate(arm: readonly number[], control: readonly number[]): FirstProseGate {
  const armP50 = percentile(arm, 0.5);
  const armP95 = percentile(arm, 0.95);
  const controlP50 = percentile(control, 0.5);
  const controlP95 = percentile(control, 0.95);
  const passed =
    armP50 !== null && controlP50 !== null && armP95 !== null && controlP95 !== null
      ? armP50 <= controlP50 * FIRST_PROSE_P50_MULTIPLE &&
        armP95 <= controlP95 * FIRST_PROSE_P95_MULTIPLE
      : false;
  return {
    armP50,
    armP95,
    controlP50,
    controlP95,
    passed,
    biasNote:
      'FLOOR, not the user number: fake tools answer instantly. The agent arms make more tool ' +
      'calls than the one-shot control, so this ratio understates the agent. Only a device ' +
      'capture settles it.',
  };
}

// ---------------------------------------------------------------------------
// Consecutive questions
// ---------------------------------------------------------------------------

export interface ConsecutiveQuestionReport {
  /** MUST BE 0 under the router rule. Named pairs, not a rate: a rate would
   *  not say which script interrogates the user. */
  pairs: { arm: string; scriptId: string; firstTurn: number; secondTurn: number }[];
  passed: boolean;
}

export function consecutiveQuestionReport(turns: readonly TurnRows[]): ConsecutiveQuestionReport {
  const pairs: ConsecutiveQuestionReport['pairs'] = [];
  const key = (t: TurnRows): string => `${t.arm}|${t.scriptId}|${t.repeat}`;
  const groups = new Map<string, TurnRows[]>();
  for (const t of turns) {
    const g = groups.get(key(t)) ?? [];
    g.push(t);
    groups.set(key(t), g);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.turnIndex - b.turnIndex);
    for (let i = 1; i < g.length; i++) {
      if (g[i - 1].endedOn === 'awaiting_user' && g[i].endedOn === 'awaiting_user') {
        pairs.push({
          arm: g[i].arm,
          scriptId: g[i].scriptId,
          firstTurn: g[i - 1].turnIndex,
          secondTurn: g[i].turnIndex,
        });
      }
    }
  }
  return { pairs, passed: pairs.length === 0 };
}

// ---------------------------------------------------------------------------
// Input tokens and the thinking gear
// ---------------------------------------------------------------------------

export interface InputTokenReport {
  /** Per arm: per-leg counts and per-turn totals. The agent's central cost
   *  claim is that a slim per-leg context is cheaper, and four slim prompts can
   *  easily exceed one fat one. Nothing measured this before it existed. */
  perLeg: Record<string, number[]>;
  perTurn: Record<string, number[]>;
  /** Kept SEPARATE, never folded in: the two paths cache different prefixes,
   *  so a total mixing cached and uncached overstates one arm by an amount the
   *  table would not reveal. */
  cachedPerTurn: Record<string, number[]>;
}

export function inputTokenReport(turns: readonly TurnRows[]): InputTokenReport {
  const perLeg: Record<string, number[]> = {};
  const perTurn: Record<string, number[]> = {};
  const cachedPerTurn: Record<string, number[]> = {};
  for (const t of turns) {
    let total = 0;
    let cached = 0;
    for (const l of [...t.legs, ...t.topicRows]) {
      // REAL first, estimate second. AgentLeg.inputTokens is a char-based
      // estimate; usage.promptTokens is what the provider billed. Preferring
      // the estimate produced a per-turn total of 918 against a CACHED figure
      // of 2624 from the same rows - a total smaller than its own subset,
      // which is incoherent on its face and was reported anyway.
      const n = l.usage?.promptTokens ?? l.inputTokens ?? 0;
      (perLeg[t.arm] ??= []).push(n);
      total += n;
      cached += l.usage?.cachedTokens ?? 0;
    }
    (perTurn[t.arm] ??= []).push(total);
    (cachedPerTurn[t.arm] ??= []).push(cached);
  }
  return { perLeg, perTurn, cachedPerTurn };
}

export interface ThinkingGearReport {
  requestedOff: number;
  requestedOn: number;
  /** Requested off, yet a trace came back. NEAR answers 200 for unknown
   *  chat_template_kwargs, so an ignored switch is silent by construction and
   *  this comparison is the only thing that says so. It surfaces downstream as
   *  truncation or an empty answer, which reads as the model failing to follow
   *  the output contract. */
  requestedOffButReasoned: number;
}

export function thinkingGearReport(rows: readonly EvalRow[]): ThinkingGearReport {
  let requestedOff = 0;
  let requestedOn = 0;
  let requestedOffButReasoned = 0;
  for (const r of rows) {
    if (r.thinkingRequested === false) {
      requestedOff += 1;
      if ((r.usage?.reasoningTokens ?? 0) > 0) requestedOffButReasoned += 1;
    } else if (r.thinkingRequested === true) {
      requestedOn += 1;
    }
  }
  return { requestedOff, requestedOn, requestedOffButReasoned };
}

// ---------------------------------------------------------------------------
// Reply prose
// ---------------------------------------------------------------------------

export interface ProseReport {
  /** Rated over rows that HAVE prose. A leg whose reply was only a tool call
   *  cannot violate a punctuation rule, and counting it dilutes the rate toward
   *  zero — measured at 2 of 123 turns on one arm against 3 of 123 on another,
   *  which was the whole apparent difference between them. */
  rowsWithProse: number;
  bannedDash: number;
}

export function proseReport(rows: readonly EvalRow[]): ProseReport {
  let rowsWithProse = 0;
  let bannedDash = 0;
  for (const r of rows) {
    const text = proseOf(r.rawOutput);
    if (text.length === 0) continue;
    rowsWithProse += 1;
    if (hasBannedDash(text)) bannedDash += 1;
  }
  return { rowsWithProse, bannedDash };
}
