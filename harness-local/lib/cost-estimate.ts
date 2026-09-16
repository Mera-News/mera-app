// harness-local — what a run will cost, BEFORE it is spent.
//
// The development key hit its $10 limit mid-wave with no warning, because
// nothing in this harness ever said what a run would cost until the bill
// arrived. Every runner now prints this on --dry-run, so the number is visible
// while it is still a decision.
//
// HONEST BOUNDS, not a point estimate. Input tokens are estimated from the
// characters actually built, which is close. Output is NOT predictable, so the
// range is reported instead of a guess:
//   floor   = input only, as if every call returned nothing
//   ceiling = input plus every call hitting its max_tokens cap
// The truth is normally much nearer the floor, but the ceiling is what an
// unlucky run can actually cost, and that is the figure a budget needs.
//
// Node-only: never imported by the app bundle.

import { costOf, type ModelCatalog, type ModelInfo } from './model-catalog';

/** Characters per token. A rough industry average, deliberately not tuned:
 *  this is a budgeting aid, and a tuned constant would imply a precision the
 *  estimate does not have. English prose runs ~4; JSON-ish prompts a little
 *  lower, so this errs slightly toward over-estimating, which is the safe
 *  direction for a spend estimate. */
const CHARS_PER_TOKEN = 4;

export interface PlannedCall {
  model: string;
  systemChars: number;
  promptChars: number;
  maxOutputTokens: number;
  /**
   * Set when this call only happens if an earlier call's OUTPUT clears a gate,
   * naming the gate. Reason calls are the case: only articles scoring at or
   * above `reasonRelevanceThreshold` get one, and a dry run cannot know how
   * many will, because its scores are a stand-in.
   *
   * Counting these as certain over-provisioned a real run by 4x: 1590 calls
   * predicted against 987 made, because only about 92 of 348 articles cleared
   * the 0.4 gate. They are now reported separately as an UPPER BOUND.
   */
  conditionalOn?: string;
}

export interface CostEstimate {
  calls: number;
  /** Calls that happen unconditionally. */
  certainCalls: number;
  /** Calls behind a gate, counted at their MAXIMUM. */
  conditionalCalls: number;
  conditionalGates: string[];
  /** Cost with every gated call assumed NOT to happen. */
  usdCertainFloor: number;
  usdCertainCeiling: number;
  byModel: {
    model: string;
    calls: number;
    estInputTokens: number;
    maxOutputTokens: number;
    usdFloor: number;
    usdCeiling: number;
    priced: boolean;
  }[];
  usdFloor: number;
  usdCeiling: number;
  /** Models the catalogue could not price, so their rows are token counts only. */
  unpriced: string[];
}

function groupOf(calls: PlannedCall[]): Map<string, PlannedCall[]> {
  const groups = new Map<string, PlannedCall[]>();
  for (const c of calls) {
    const list = groups.get(c.model);
    if (list) list.push(c);
    else groups.set(c.model, [c]);
  }
  return groups;
}

export function estimateRunCost(calls: PlannedCall[], catalog: ModelCatalog): CostEstimate {
  const groups = groupOf(calls);

  const byModel: CostEstimate['byModel'] = [];
  const unpriced: string[] = [];
  let usdFloor = 0;
  let usdCeiling = 0;

  for (const [model, list] of groups) {
    const estInputTokens = list.reduce(
      (n, c) => n + Math.ceil((c.systemChars + c.promptChars) / CHARS_PER_TOKEN),
      0,
    );
    const maxOutputTokens = list.reduce((n, c) => n + c.maxOutputTokens, 0);
    const info: ModelInfo | undefined = catalog[model];
    const priced = Boolean(info) && (info.pricing.inputPerM > 0 || info.pricing.outputPerM > 0);
    if (!priced) unpriced.push(model);

    // Cached tokens are deliberately NOT assumed. A corpus run does repeat its
    // prompts and will pay less than this, but an estimate that counts on a
    // cache hit is an estimate that can only be wrong in the expensive
    // direction.
    const floor = priced
      ? costOf(info as ModelInfo, { promptTokens: estInputTokens, completionTokens: 0, cachedTokens: 0 })
      : 0;
    const ceiling = priced
      ? costOf(info as ModelInfo, { promptTokens: estInputTokens, completionTokens: maxOutputTokens, cachedTokens: 0 })
      : 0;

    byModel.push({ model, calls: list.length, estInputTokens, maxOutputTokens, usdFloor: floor, usdCeiling: ceiling, priced });
    usdFloor += floor;
    usdCeiling += ceiling;
  }

  byModel.sort((a, b) => b.usdCeiling - a.usdCeiling || a.model.localeCompare(b.model));

  // The same arithmetic over the unconditional calls only, so a reader can see
  // the part of the bill that is certain separately from the part that depends
  // on how many articles clear a gate.
  const certain = calls.filter((c) => !c.conditionalOn);
  let usdCertainFloor = 0;
  let usdCertainCeiling = 0;
  for (const [model, list] of groupOf(certain)) {
    const info = catalog[model];
    if (!info) continue;
    const inTok = list.reduce((n, c) => n + Math.ceil((c.systemChars + c.promptChars) / CHARS_PER_TOKEN), 0);
    const outTok = list.reduce((n, c) => n + c.maxOutputTokens, 0);
    usdCertainFloor += costOf(info, { promptTokens: inTok, completionTokens: 0, cachedTokens: 0 });
    usdCertainCeiling += costOf(info, { promptTokens: inTok, completionTokens: outTok, cachedTokens: 0 });
  }

  return {
    calls: calls.length,
    certainCalls: certain.length,
    conditionalCalls: calls.length - certain.length,
    conditionalGates: [...new Set(calls.map((c) => c.conditionalOn).filter((x): x is string => Boolean(x)))],
    usdCertainFloor,
    usdCertainCeiling,
    byModel,
    usdFloor,
    usdCeiling,
    unpriced,
  };
}

export function formatCostEstimate(e: CostEstimate): string {
  const out: string[] = [];
  out.push(`ESTIMATED COST for ${e.calls} call(s), before the run spends anything`);
  out.push(`  ${'model'.padEnd(32)}${'calls'.padStart(7)}${'in tok'.padStart(10)}${'max out'.padStart(10)}${'USD floor'.padStart(12)}${'USD ceiling'.padStart(13)}`);
  for (const m of e.byModel) {
    out.push(
      `  ${m.model.padEnd(32).slice(0, 32)}${String(m.calls).padStart(7)}` +
        `${String(m.estInputTokens).padStart(10)}${String(m.maxOutputTokens).padStart(10)}` +
        (m.priced
          ? `${m.usdFloor.toFixed(4).padStart(12)}${m.usdCeiling.toFixed(4).padStart(13)}`
          : `${'unpriced'.padStart(12)}${'unpriced'.padStart(13)}`),
    );
  }
  out.push(`  ${'TOTAL'.padEnd(32)}${String(e.calls).padStart(7)}${''.padStart(20)}${e.usdFloor.toFixed(4).padStart(12)}${e.usdCeiling.toFixed(4).padStart(13)}`);
  if (e.conditionalCalls > 0) {
    out.push('');
    out.push(
      `  UPPER BOUND: ${e.conditionalCalls} of ${e.calls} call(s) are GATED on an earlier call's output ` +
        `(${e.conditionalGates.join(', ')}) and are counted here at their maximum.`,
    );
    out.push(
      `  If NONE of them fire the run costs ${e.usdCertainFloor.toFixed(4)} to ${e.usdCertainCeiling.toFixed(4)}; ` +
        'the truth is between that and the total above.',
    );
    out.push(
      '  Measured once on the 348-article goldset: about 26% of articles cleared the 0.4 reason gate, ' +
        'so the gated portion ran at roughly a quarter of this bound. Do not provision for the bound.',
    );
  }
  out.push('  Floor assumes no output at all, ceiling assumes every call hits max_tokens.');
  out.push('  Input tokens are estimated at 4 chars each, and no cache discount is assumed.');
  if (e.unpriced.length > 0) {
    out.push(`  NOT PRICED, token counts only: ${e.unpriced.join(', ')}`);
  }
  return out.join('\n');
}
