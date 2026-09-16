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
}

export interface CostEstimate {
  calls: number;
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

export function estimateRunCost(calls: PlannedCall[], catalog: ModelCatalog): CostEstimate {
  const groups = new Map<string, PlannedCall[]>();
  for (const c of calls) {
    const list = groups.get(c.model);
    if (list) list.push(c);
    else groups.set(c.model, [c]);
  }

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
  return { calls: calls.length, byModel, usdFloor, usdCeiling, unpriced };
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
  out.push('  Floor assumes no output at all, ceiling assumes every call hits max_tokens.');
  out.push('  Input tokens are estimated at 4 chars each, and no cache discount is assumed.');
  if (e.unpriced.length > 0) {
    out.push(`  NOT PRICED, token counts only: ${e.unpriced.join(', ')}`);
  }
  return out.join('\n');
}
