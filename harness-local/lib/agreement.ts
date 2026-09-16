// harness-local — the null experiment.
//
// Run the SAME corpus, prompt, model and pinned nonce N times and measure how
// far the answers drift with nothing changed. That number is the noise floor,
// and without it every later delta is unfalsifiable. eval/README.md already
// records the analogue for scoring at temperature 0.1 (up to 1.3 points of
// aggregate movement with no underlying change, so "do not chase deltas
// smaller than ~2 points"); chat runs at 0.4 with thinking on, so expect worse.
//
// N MUST BE 3 OR MORE. Two repeats give one comparison per cell, and one
// comparison is a coin flip, not a floor.
//
// Node-only. Imports nothing from expo/react-native.

import { readFileSync } from 'node:fs';
import type { CallType, RunRow } from './jsonl-writer';
import { costOf, type ModelCatalog } from './model-catalog';

export function readJsonl(path: string): RunRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunRow);
}

/**
 * One measured cell: everything held constant, repeats varying only by luck.
 *
 * `callType` IS PART OF THE KEY. Without it a reason call at index 0 and a
 * relevance call at chunk 0 land in the same cell, their prompts legitimately
 * differ, and the integrity check reports a runner bug that is really just two
 * different prompts sharing an index. Found by the first dry run.
 */
export function cellKey(row: RunRow): string {
  return [
    row.cohort, row.callType, row.turnIndex, row.arm, row.variant, row.lane, row.modelRequested,
  ].join(' | ');
}

/** A reasoning trace in the content, by either tell: a think tag, which
 *  `reasoningLeak` already records, or the narration a thinking model opens
 *  with when the tag is stripped but the habit is not. */
function looksLikeTrace(row: RunRow): boolean {
  if (row.reasoningLeak) return true;
  const head = row.rawOutput.trimStart().slice(0, 40).toLowerCase();
  return /^(let me|okay, let|first, i|i need to|we need to)/.test(head);
}

/** Flattens parsed tool arguments to comparable `path=value` leaves, so two
 *  calls that saved the same facts in a different key order still agree. */
function leaves(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [`${prefix}=null`];
  if (Array.isArray(value)) {
    // Arrays compare as SETS: the model reordering two saved facts is not a
    // disagreement about what it saved.
    return value.flatMap((v) => leaves(v, `${prefix}[]`)).sort();
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [`${prefix}=${String(value)}`];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function toolNameSet(row: RunRow): string {
  return row.toolCalls.map((t) => t.name).sort().join(',');
}

function argLeafSet(row: RunRow): Set<string> {
  return new Set(row.toolCalls.flatMap((t) => leaves(t.parsed, t.name)));
}

function pairs<T>(items: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i], items[j]]);
  }
  return out;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export interface CellAgreement {
  key: string;
  /** Structured copies of the key's parts. The arm rollup filters on these:
   *  matching the formatted key by substring broke the moment the key gained a
   *  field, which is exactly the kind of silent mis-grouping this report exists
   *  to catch in other people's code. */
  arm: string;
  model: string;
  callType: CallType;
  repeats: number;
  /** MORE THAN ONE distinct hash in a cell is a RUNNER BUG, not model noise:
   *  the repeats were not given the same prompt, so their disagreement measures
   *  nothing. This is the check that keeps the null experiment honest. */
  distinctPromptHashes: number;
  /** How many distinct prompts the repeats saw. 1 everywhere for a stateless
   *  runner. Above 1 in a stateful cohort it is the DIVERGENCE: the repeats
   *  have carried the conversation to different persona states, which is worth
   *  reading next to the agreement numbers rather than hidden behind them. */
  distinctPrompts: number;
  promptDeterministic: boolean;
  toolNameAgreement: number;
  toolArgJaccard: number;
  exactOutputRate: number;
  errorRate: number;
  truncatedRate: number;
  /** Count arms only: fraction of repeats whose returned count respected the
   *  requested ceiling. Mechanical, so it can actually fire. */
  countRespected: number | null;
  /**
   * Spread of the per-repeat mean score, for cells whose parsedSchema is a
   * numeric array. RANGE ALONE UNDER-STATES SPREAD at three repeats: a range is
   * the gap between two draws and says nothing about how the middle sits, so a
   * 0.95-point delta can look large against a narrow range while sitting well
   * inside the standard deviation. Both are printed; judge on the SD.
   */
  scoreMean: number | null;
  scoreSd: number | null;
  scoreRange: number | null;
}

/**
 * Latency and cost for one (arm, model, call type), computed ONLY from
 * interleaved work units.
 *
 * WHY THE FILTER MATTERS. NEAR latency swings several-fold by time of day, so
 * two arms measured an hour apart are not comparable and their difference is a
 * clock reading, not a model property. A work unit counts as interleaved when
 * EVERY arm in the roster produced a row for it, which the reporter derives
 * from `interleaveGroup` rather than trusting a flag the runner set.
 *
 * Rows served by a different model than the arm asked for (a fallback or a
 * hedge win) are dropped from the latency figures and counted separately, so a
 * number is never attributed to the wrong model.
 */
export interface CallTypeRollup {
  arm: string;
  model: string;
  callType: CallType;
  calls: number;
  /** In the latency figures below. calls minus this is what was excluded. */
  interleavedCalls: number;
  misroutedCalls: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Streaming call types only; null when nothing streamed. */
  ttVisibleP50Ms: number | null;
  ttVisibleP95Ms: number | null;
  ttVisibleMaxMs: number | null;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  usdPer100Calls: number;
}

export interface ArmRollup {
  arm: string;
  model: string;
  calls: number;
  errors: number;
  /** Hit the output cap. A truncated relevance batch loses its array and every
   *  article in it falls back, so this is never a detail. */
  truncatedCalls: number;
  /** Returned a reasoning trace inside `content`. */
  leakedCalls: number;
  /** Produced nothing at all. */
  emptyCalls: number;
  /**
   * Calls that produced something a caller could actually use: no transport
   * error, not truncated, no reasoning trace in the content, and non-empty
   * output. This is the ONE number a fallback screen should read first. An arm
   * can look cheap and fast while being unusable, and the cost and latency
   * columns cannot show that, because a refused or truncated call is often the
   * fastest and cheapest one in the run.
   */
  usableCalls: number;
  /** finish_reason -> count, so "stop" versus "length" is visible per arm
   *  rather than averaged into a rate. */
  finishReasons: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  usdPer100Calls: number;
  latencyMedianMs: number;
  latencyP90Ms: number;
  /** The floor: the WORST cell, not the average, because a prompt change has
   *  to beat the worst case to be believed. */
  minToolNameAgreement: number;
  meanToolNameAgreement: number;
  minToolArgJaccard: number;
  meanToolArgJaccard: number;
  meanExactOutputRate: number;
}

export interface AgreementReport {
  runId: string;
  rowsTotal: number;
  rowsScored: number;
  duplicateRows: number;
  integrityFailures: string[];
  cells: CellAgreement[];
  arms: ArmRollup[];
  callTypes: CallTypeRollup[];
  /** True when no row in THIS RUN carried a cached-token count. Live NEAR
   *  responses do carry it once a prefix has been seen before, so this is the
   *  normal state of a dry run and a finding on a live one. */
  cacheBreakdownAbsent: boolean;
  cachedPromptTokens: number;
  reasoningTokens: number;
  /** Work units that not every arm completed. Their rows are excluded from the
   *  latency comparison and named here, because a silently smaller sample is
   *  how a speed claim goes wrong. */
  nonInterleavedGroups: number;
}

export function computeAgreement(
  rows: RunRow[],
  catalog: ModelCatalog | null = null,
): AgreementReport {
  // Duplicates exist for the rater's intra-rater agreement. Counting them here
  // would compare a row against a copy of itself and report a perfect floor.
  const scored = rows.filter((r) => r.dupOf === null);
  const byCell = new Map<string, RunRow[]>();
  for (const row of scored) {
    const key = cellKey(row);
    const list = byCell.get(key);
    if (list) list.push(row);
    else byCell.set(key, [row]);
  }

  const integrityFailures: string[] = [];
  const cells: CellAgreement[] = [];

  for (const [key, cellRows] of byCell) {
    const hashes = new Set(cellRows.map((r) => r.promptHash));
    // A cell is only required to hold ONE prompt when its prompt is fully
    // determined by the fixture. Once a turn depends on what the model said
    // earlier, the repeats diverge on purpose and the divergence is the
    // measurement, not a defect.
    const deterministic = cellRows.every((r) => r.promptDeterministic);
    if (deterministic && hashes.size > 1) {
      integrityFailures.push(
        `RUNNER BUG: cell "${key}" has ${hashes.size} distinct promptHash values across ${cellRows.length} repeats, ` +
          'and its prompt is supposed to be fully determined by the fixture. ' +
          'The repeats were not given the same prompt, so their disagreement is not a noise floor. ' +
          'Check the fence nonce is pinned and that state is rebuilt identically per repeat.',
      );
    }
    const nonces = new Set(cellRows.map((r) => r.fenceNonce));
    if (nonces.size > 1) {
      integrityFailures.push(
        `RUNNER BUG: cell "${key}" used ${nonces.size} different fence nonces. Pin it per run.`,
      );
    }

    const ps = pairs(cellRows);
    const nameAgree = ps.length
      ? ps.filter(([a, b]) => toolNameSet(a) === toolNameSet(b)).length / ps.length
      : 1;
    const argAgree = ps.length
      ? ps.reduce((acc, [a, b]) => acc + jaccard(argLeafSet(a), argLeafSet(b)), 0) / ps.length
      : 1;
    const exact = ps.length
      ? ps.filter(([a, b]) => a.rawOutput === b.rawOutput).length / ps.length
      : 1;

    const counted = cellRows.filter((r) => r.requestedCount !== null && r.returnedCount !== null);
    const countRespected = counted.length
      ? counted.filter((r) => (r.returnedCount as number) <= (r.requestedCount as number)).length /
        counted.length
      : null;

    // Per-repeat scalar: the mean of each row's numeric parsedSchema. Absent
    // for rows that do not carry one, which is most non-scoring call types.
    const perRepeat = cellRows
      .map((r) => {
        const v = r.parsedSchema;
        if (!Array.isArray(v)) return null;
        const nums = v.filter((x): x is number => typeof x === 'number');
        return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      })
      .filter((x): x is number => x !== null);
    const scoreMean = perRepeat.length > 0 ? perRepeat.reduce((a, b) => a + b, 0) / perRepeat.length : null;
    const scoreSd =
      perRepeat.length > 1 && scoreMean !== null
        ? Math.sqrt(perRepeat.reduce((n, x) => n + (x - scoreMean) ** 2, 0) / perRepeat.length)
        : null;
    const scoreRange = perRepeat.length > 1 ? Math.max(...perRepeat) - Math.min(...perRepeat) : null;

    cells.push({
      key,
      scoreMean,
      scoreSd,
      scoreRange,
      arm: cellRows[0].arm,
      model: cellRows[0].modelRequested,
      callType: cellRows[0].callType,
      repeats: cellRows.length,
      distinctPromptHashes: hashes.size,
      distinctPrompts: hashes.size,
      promptDeterministic: deterministic,
      toolNameAgreement: nameAgree,
      toolArgJaccard: argAgree,
      exactOutputRate: exact,
      errorRate: cellRows.filter((r) => r.error !== null).length / cellRows.length,
      truncatedRate: cellRows.filter((r) => r.truncated).length / cellRows.length,
      countRespected,
    });

    if (cellRows.length < 3) {
      integrityFailures.push(
        `THIN CELL: "${key}" has ${cellRows.length} repeat(s). A floor needs 3 or more; ` +
          'one comparison is a coin flip.',
      );
    }
  }

  // Arm roll-up, including the cost column.
  const armKeys = new Map<string, RunRow[]>();
  for (const row of scored) {
    const key = `${row.arm} | ${row.modelRequested}`;
    const list = armKeys.get(key);
    if (list) list.push(row);
    else armKeys.set(key, [row]);
  }

  const arms: ArmRollup[] = [];
  for (const [key, armRows] of armKeys) {
    const [arm, model] = key.split(' | ');
    const info = catalog?.[model] ?? null;
    let usd = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    for (const r of armRows) {
      if (!r.usage) continue;
      promptTokens += r.usage.promptTokens;
      completionTokens += r.usage.completionTokens;
      usd += r.cost?.usd ?? (info ? costOf(info, r.usage) : 0);
    }
    const lat = armRows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const armCells = cells.filter((c) => c.arm === arm && c.model === model);
    const nameVals = armCells.map((c) => c.toolNameAgreement);
    const argVals = armCells.map((c) => c.toolArgJaccard);
    const exactVals = armCells.map((c) => c.exactOutputRate);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

    const finishReasons: Record<string, number> = {};
    for (const r of armRows) {
      finishReasons[r.finishReason] = (finishReasons[r.finishReason] ?? 0) + 1;
    }
    arms.push({
      arm,
      model,
      calls: armRows.length,
      errors: armRows.filter((r) => r.error !== null).length,
      truncatedCalls: armRows.filter((r) => r.truncated).length,
      leakedCalls: armRows.filter((r) => looksLikeTrace(r)).length,
      emptyCalls: armRows.filter((r) => r.error === null && r.rawOutput.trim().length === 0).length,
      usableCalls: armRows.filter(
        (r) => r.error === null && !r.truncated && !looksLikeTrace(r) && r.rawOutput.trim().length > 0,
      ).length,
      finishReasons,
      promptTokens,
      completionTokens,
      usd,
      usdPer100Calls: armRows.length ? (usd / armRows.length) * 100 : 0,
      latencyMedianMs: quantile(lat, 0.5),
      latencyP90Ms: quantile(lat, 0.9),
      minToolNameAgreement: nameVals.length ? Math.min(...nameVals) : 1,
      meanToolNameAgreement: mean(nameVals),
      minToolArgJaccard: argVals.length ? Math.min(...argVals) : 1,
      meanToolArgJaccard: mean(argVals),
      meanExactOutputRate: mean(exactVals),
    });
  }

  // ---- per (arm, model, call type), interleaved only ----------------------
  const rosterArms = new Set(scored.map((r) => `${r.arm}|${r.modelRequested}`));
  const groupArms = new Map<string, Set<string>>();
  for (const r of scored) {
    if (!r.interleaveGroup) continue;
    const key = `${r.callType}::${r.interleaveGroup}`;
    const set = groupArms.get(key) ?? new Set<string>();
    set.add(`${r.arm}|${r.modelRequested}`);
    groupArms.set(key, set);
  }
  // A group is comparable only when EVERY arm ran it.
  const completeGroups = new Set(
    [...groupArms.entries()]
      .filter(([, arms]) => arms.size === rosterArms.size)
      .map(([key]) => key),
  );
  const nonInterleavedGroups = groupArms.size - completeGroups.size;

  const ctKeys = new Map<string, RunRow[]>();
  for (const r of scored) {
    const key = `${r.arm}\u0000${r.modelRequested}\u0000${r.callType}`;
    const list = ctKeys.get(key);
    if (list) list.push(r);
    else ctKeys.set(key, [r]);
  }

  const callTypes: CallTypeRollup[] = [];
  for (const [key, ctRows] of ctKeys) {
    const [arm, model, callType] = key.split('\u0000');
    const info = catalog?.[model] ?? null;
    // Served by something other than what this arm asked for: a fallback or a
    // hedge win. Its latency belongs to the OTHER model, so it is excluded.
    const misrouted = ctRows.filter(
      (r) => r.fallbackFrom !== null || (r.modelSent !== null && r.modelSent !== r.modelRequested),
    );
    const usable = ctRows.filter(
      (r) =>
        r.error === null &&
        !misrouted.includes(r) &&
        r.interleaveGroup !== null &&
        completeGroups.has(`${r.callType}::${r.interleaveGroup}`),
    );
    const lat = usable.map((r) => r.latencyMs).sort((a, b) => a - b);
    const vis = usable
      .map((r) => r.ttVisibleMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);

    let promptTokens = 0;
    let completionTokens = 0;
    let usd = 0;
    for (const r of ctRows) {
      if (!r.usage) continue;
      promptTokens += r.usage.promptTokens;
      completionTokens += r.usage.completionTokens;
      usd += r.cost?.usd ?? (info ? costOf(info, r.usage) : 0);
    }

    callTypes.push({
      arm,
      model,
      callType: callType as CallType,
      calls: ctRows.length,
      interleavedCalls: usable.length,
      misroutedCalls: misrouted.length,
      p50Ms: quantile(lat, 0.5),
      p95Ms: quantile(lat, 0.95),
      maxMs: lat.length ? lat[lat.length - 1] : 0,
      ttVisibleP50Ms: vis.length ? quantile(vis, 0.5) : null,
      ttVisibleP95Ms: vis.length ? quantile(vis, 0.95) : null,
      ttVisibleMaxMs: vis.length ? vis[vis.length - 1] : null,
      promptTokens,
      completionTokens,
      usd,
      usdPer100Calls: ctRows.length ? (usd / ctRows.length) * 100 : 0,
    });
  }
  callTypes.sort(
    (a, b) => a.callType.localeCompare(b.callType) || a.arm.localeCompare(b.arm),
  );

  const withUsage = scored.filter((r) => r.usage !== null);
  return {
    callTypes,
    nonInterleavedGroups,
    cacheBreakdownAbsent:
      withUsage.length > 0 && withUsage.every((r) => (r.usage as { cachedTokens: number }).cachedTokens === 0),
    cachedPromptTokens: withUsage.reduce(
      (n, r) => n + (r.usage as { cachedTokens: number }).cachedTokens,
      0,
    ),
    reasoningTokens: withUsage.reduce(
      (n, r) => n + ((r.usage as { reasoningTokens?: number }).reasoningTokens ?? 0),
      0,
    ),
    runId: rows[0]?.runId ?? 'unknown',
    rowsTotal: rows.length,
    rowsScored: scored.length,
    duplicateRows: rows.length - scored.length,
    integrityFailures,
    cells: cells.sort((a, b) => a.key.localeCompare(b.key)),
    arms: arms.sort((a, b) => a.arm.localeCompare(b.arm)),
  };
}

export function formatAgreementReport(r: AgreementReport): string {
  const out: string[] = [];
  out.push(`NULL EXPERIMENT  run=${r.runId}`);
  out.push(
    `rows=${r.rowsTotal} scored=${r.rowsScored} duplicates-for-rater=${r.duplicateRows} cells=${r.cells.length}`,
  );

  if (r.integrityFailures.length > 0) {
    out.push('');
    out.push('INTEGRITY FAILURES (the floor below is NOT trustworthy until these are fixed):');
    for (const f of r.integrityFailures) out.push(`  ! ${f}`);
  } else {
    out.push('integrity: every cell held one prompt hash and one nonce across its repeats.');
  }

  out.push('');
  out.push('PER ARM (cost is priced from the catalogue captured in models.json at run start)');
  out.push(
    '  arm / model                                   calls  err   tool-name   tool-args   exact   med ms   p90 ms      USD   USD/100',
  );
  for (const a of r.arms) {
    out.push(
      `  ${`${a.arm} / ${a.model}`.padEnd(44).slice(0, 44)}  ` +
        `${String(a.calls).padStart(5)}  ${String(a.errors).padStart(3)}  ` +
        `${pct(a.minToolNameAgreement).padStart(9)}  ${pct(a.minToolArgJaccard).padStart(9)}  ` +
        `${pct(a.meanExactOutputRate).padStart(6)}  ${String(a.latencyMedianMs).padStart(6)}  ` +
        `${String(a.latencyP90Ms).padStart(6)}  ${a.usd.toFixed(4).padStart(7)}  ${a.usdPer100Calls.toFixed(4).padStart(8)}`,
    );
  }
  out.push('  tool-name / tool-args columns are the WORST cell in the arm, which is the floor.');

  // The line a fallback screen reads first. Put ABOVE the damage detail, since
  // an arm can look cheap and fast precisely BECAUSE its calls failed.
  out.push('');
  out.push('USABLE (no error, not truncated, no trace in content, non-empty). Read this before cost or latency.');
  out.push(`  ${'arm / model'.padEnd(46)}${'calls'.padStart(7)}${'usable'.padStart(9)}${'err'.padStart(6)}${'trunc'.padStart(7)}${'trace'.padStart(7)}${'empty'.padStart(7)}`);
  for (const a of r.arms) {
    const rate = a.calls > 0 ? (a.usableCalls / a.calls) * 100 : 0;
    out.push(
      `  ${`${a.arm} / ${a.model}`.padEnd(46).slice(0, 46)}${String(a.calls).padStart(7)}` +
        `${`${rate.toFixed(1)}%`.padStart(9)}${String(a.errors).padStart(6)}${String(a.truncatedCalls).padStart(7)}` +
        `${String(a.leakedCalls).padStart(7)}${String(a.emptyCalls).padStart(7)}`,
    );
    if (rate < 90 && a.calls > 0) {
      out.push('    ^ below 90% usable. This arm is not a candidate until that is fixed, whatever its cost line says.');
    }
  }

  // Truncation and trace leaks get their own block rather than a column,
  // because an arm that truncates most of its calls has not produced a slower
  // or worse result, it has produced NO result, and that must not be read as a
  // quality difference.
  const damaged = r.arms.filter((a) => a.truncatedCalls > 0 || a.leakedCalls > 0);
  if (damaged.length > 0) {
    out.push('');
    out.push('OUTPUT DAMAGE (read this BEFORE any quality or cost comparison)');
    for (const a of damaged) {
      const pctTrunc = a.calls > 0 ? (a.truncatedCalls / a.calls) * 100 : 0;
      out.push(
        `  ${`${a.arm} / ${a.model}`.padEnd(44).slice(0, 44)} ` +
          `truncated ${a.truncatedCalls}/${a.calls} (${pctTrunc.toFixed(1)}%)` +
          (a.leakedCalls > 0 ? `, reasoning trace inside content ${a.leakedCalls}/${a.calls}` : '') +
          `, finish_reason ${JSON.stringify(a.finishReasons)}`,
      );
      if (pctTrunc >= 50) {
        out.push(
          '    ^ this arm did not produce a usable answer for most calls. Raise its budget with ' +
            '--max-tokens <model>=<n> and re-run before comparing it to anything.',
        );
      }
      if (a.leakedCalls > 0) {
        out.push(
          '    ^ a trace inside content shares the output budget with the answer, so the truncation ' +
            'above is likely its consequence and not an output-contract failure.',
        );
      }
    }
  }

  out.push('');
  out.push('PER ARM AND CALL TYPE (latency from INTERLEAVED calls only, so both arms saw the same minute)');
  out.push(
    '  call type          arm / model                            calls  intlv  misrt    p50    p95    max   vis50   vis95      USD   USD/100',
  );
  for (const c of r.callTypes) {
    out.push(
      `  ${c.callType.padEnd(17).slice(0, 17)}  ${`${c.arm} / ${c.model}`.padEnd(36).slice(0, 36)}  ` +
        `${String(c.calls).padStart(5)}  ${String(c.interleavedCalls).padStart(5)}  ${String(c.misroutedCalls).padStart(5)}  ` +
        `${String(c.p50Ms).padStart(5)}  ${String(c.p95Ms).padStart(5)}  ${String(c.maxMs).padStart(5)}  ` +
        `${String(c.ttVisibleP50Ms ?? '-').padStart(6)}  ${String(c.ttVisibleP95Ms ?? '-').padStart(6)}  ` +
        `${c.usd.toFixed(4).padStart(7)}  ${c.usdPer100Calls.toFixed(4).padStart(8)}`,
    );
  }
  if (r.nonInterleavedGroups > 0) {
    out.push(
      `  NOTE: ${r.nonInterleavedGroups} work unit(s) were not completed by every arm and are excluded from the latency columns.`,
    );
  }
  if (r.cacheBreakdownAbsent) {
    out.push(
      '  NOTE: no row in this run reported cached prompt tokens, so the cache-read rate never applied. ' +
        'Live NEAR responses DO report them once a prompt prefix has been seen before, and a corpus ' +
        'run repeats its prompts by construction, so this line is normal for a --dry-run (the ' +
        'stand-in carries no usage detail) and worth a look on a live run.',
    );
  } else if (r.cachedPromptTokens > 0) {
    out.push(
      `  NOTE: ${r.cachedPromptTokens} prompt token(s) came from NEAR's prefix cache and are priced at ` +
        'the cached rate, a fraction of the full input rate. Repeated prompts are the norm here, so ' +
        'ignoring this would overstate every cost in the table.',
    );
  }
  if (r.reasoningTokens > 0) {
    out.push(
      `  NOTE: ${r.reasoningTokens} reasoning token(s) billed inside the completion totals above. ` +
        'An arm reporting 0 here while its output carries a trace leaked that trace into content instead.',
    );
  }
  const misrouted = r.callTypes.reduce((n, c) => n + c.misroutedCalls, 0);
  if (misrouted > 0) {
    out.push(
      `  NOTE: ${misrouted} call(s) were served by a fallback or a hedge winner and are excluded, so no latency is credited to the wrong model.`,
    );
  }

  out.push('');
  out.push('PER CELL');
  const withSd = r.cells.filter((c) => c.scoreSd !== null);
  if (withSd.length > 0) {
    const meanSd = withSd.reduce((n, c) => n + (c.scoreSd as number), 0) / withSd.length;
    const meanRange = withSd.reduce((n, c) => n + (c.scoreRange as number), 0) / withSd.length;
    out.push(
      `  Across ${withSd.length} scoring cell(s): mean per-repeat SD ${meanSd.toFixed(3)}, mean range ${meanRange.toFixed(3)}. ` +
        'At 3 repeats the RANGE is the gap between two draws and under-states spread; judge a delta against the SD.',
    );
  }
  for (const c of r.cells) {
    out.push(
      `  ${c.key.padEnd(58).slice(0, 58)} n=${c.repeats} ` +
        `names=${pct(c.toolNameAgreement)} args=${pct(c.toolArgJaccard)} exact=${pct(c.exactOutputRate)}` +
        (c.countRespected !== null ? ` count-ok=${pct(c.countRespected)}` : '') +
        (!c.promptDeterministic && c.distinctPrompts > 1
          ? ` diverged=${c.distinctPrompts}/${c.repeats}`
          : '') +
        (c.scoreSd !== null
          ? ` score=${(c.scoreMean as number).toFixed(3)} sd=${c.scoreSd.toFixed(3)} range=${(c.scoreRange as number).toFixed(3)}`
          : '') +
        (c.errorRate > 0 ? ` err=${pct(c.errorRate)}` : '') +
        (c.truncatedRate > 0 ? ` TRUNCATED=${pct(c.truncatedRate)}` : ''),
    );
  }
  return out.join('\n');
}
