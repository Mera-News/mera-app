// harness-local — the rater-facing run format.
//
// ONE JSONL file per run, one row per (cohort, turn, arm, repeat). A blind
// rater agent reads ONLY that file, so every field a rating depends on has to
// be in the row: there is no second artifact to consult and no run-time state
// to ask about.
//
// Node-only. Imports nothing from expo/react-native.

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What a single LLM call cost, priced from the catalogue captured at run
 *  start (lib/model-catalog). Null when the provider returned no usage. */
export interface RowCost {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface RowToolCall {
  name: string;
  /** Exactly what the provider sent, before any parse. A truncated or empty
   *  `{}` is a finding, and it is only visible here. */
  argumentsRaw: string;
  /** POST-FILTER view: what `filterFactChoiceGroups` leaves, which is what the
   *  user is actually offered. The rater scores this. `argumentsRaw` is the
   *  pre-filter wire text, kept so a filtered-away call is still visible. */
  parsed: Record<string, unknown> | null;
  /** False when `parsed` is null or a required property of the tool's schema
   *  is absent. The runner judges this against the SHIPPED tool definitions. */
  schemaValid: boolean;
}

/** The prompts under measurement. Extend deliberately: every value here gets
 *  its own latency and cost line in the report. */
export type CallType =
  | 'relevance-batch'
  | 'reason'
  | 'topicgen-factOnly'
  | 'topicgen-combo'
  | 'chat-extraction'
  | 'other';

export interface RunRow {
  /** Unique per ROW, not per call: a duplicated row carries a new one. */
  rowId: string;
  /** Set on a duplicate to the rowId it copies. The rater is not told which
   *  rows are duplicates; this field is for scoring intra-rater agreement
   *  after the fact, and the runner strips it from the rater's copy. */
  dupOf: string | null;
  runId: string;
  repeat: number;
  cohort: string;
  turnIndex: number;
  /** Which experimental arm produced this row (model arm, prompt arm, count
   *  arm). Free-form so a runner can name its own axis. */
  arm: string;
  /** Which prompt this call exercised. Latency and cost are reported PER CALL
   *  TYPE as well as per arm, because a model that is cheap and fast on a
   *  20-article relevance batch can be neither on a single reason call, and an
   *  arm-level average hides exactly that. */
  callType: CallType;
  /** Work unit shared by every arm that ran it. Arms are interleaved PER CALL,
   *  so the arms inside one group saw the same minute of the day: NEAR latency
   *  swings several-fold between hours, and two arms measured an hour apart are
   *  not comparable at all. The reporter derives "interleaved" from this rather
   *  than trusting a flag: a group counts only when every arm in the roster
   *  produced a row for it. */
  interleaveGroup: string | null;
  lane: 'near' | 'gateway';
  surface: string;
  variant: string;
  /** sha256 over the MATERIALISED messages array. Two rows in one cell with
   *  different hashes are a runner bug wearing noise as a costume, which is
   *  what makes the null experiment self-checking. */
  promptHash: string;
  /**
   * Whether this row's prompt is fully determined by the fixture.
   *
   * TRUE for every stateless call and for the FIRST turn of a stateful one:
   * repeats must then produce an identical prompt, and any difference is a
   * runner bug.
   *
   * FALSE once a prompt depends on what the model said earlier. In a stateful
   * chat cohort the three repeats genuinely diverge after turn 0, because each
   * saved a different set of facts, so their prompts differ BY DESIGN. Calling
   * that a runner bug would fail every live run; measuring it is the useful
   * thing, and the report counts distinct prompts per cell instead.
   */
  promptDeterministic: boolean;
  /** The pinned article-fence nonce, when the prompt under test uses one.
   *  Unpinned, two identical scoring runs build different prompts. */
  fenceNonce: string | null;
  modelRequested: string;
  /** What the provider actually answered as. A gateway hedge can swap models
   *  mid-corpus, so the requested id is not evidence of what ran. */
  modelSent: string | null;
  /** Set when this call was served by a FALLBACK after the primary failed in a
   *  timeout-class way, naming the model that was asked for first. */
  fallbackFrom: string | null;
  /** True when a hedge race decided which model answered. Both this and
   *  `fallbackFrom` exist so a latency figure is never silently attributed to
   *  the model that lost the race. The reporter excludes any row where the
   *  served model is not the arm's own model. */
  hedged: boolean;
  input: {
    systemPrompt: string;
    messages: { role: string; content: string }[];
    toolSchemaNames: string[];
  };
  personaStateIn: {
    factCount: number;
    topicCount: number;
    /** How many facts SURVIVED the prompt builder's cap, not how many exist. */
    factsInPrompt: number;
    turnsInPrompt: number;
  };
  rawOutput: string;
  toolCalls: RowToolCall[];
  /** Parsed structured output for the non-tool prompts (scores, topics). */
  parsedSchema: unknown;
  /**
   * The items this call scored, IN THE SAME ORDER as `parsedSchema`, so a
   * golden-label join is by key rather than by parsing titles back out of
   * `input.messages`. One entry for a reason call, chunk-many for a relevance
   * batch. Null for calls that score nothing, such as a chat turn.
   */
  items: { id: string; verdict?: string | null }[] | null;
  /** Count arms: what the prompt asked for vs what came back. A mechanical
   *  check that can actually fire, unlike a judgement about quality. */
  requestedCount: number | null;
  returnedCount: number | null;
  personaStateDelta: {
    added: string[];
    conflicts: string[];
    rejectedByRails: string[];
  } | null;
  finishReason: string;
  truncated: boolean;
  /**
   * The model returned a reasoning trace INSIDE `content` instead of in
   * `reasoning_content`, detected with lib/llm/reasoning-leak. Recorded rather
   * than stripped: on a measurement run the leak IS the result.
   *
   * It is not cosmetic. A leaked trace shares the output budget with the
   * answer, so it shows up as `truncated` with a half-written JSON array, and
   * `reasoningTokens` stays 0 because the provider never counted it as
   * reasoning. Without this flag that reads as "the model cannot follow the
   * output contract" when the real cause is that the thinking switch was not
   * honoured.
   */
  reasoningLeak: boolean;
  /**
   * `cachedTokens` comes from `usage.prompt_tokens_details.cached_tokens` and
   * is real: NEAR populates it once a prompt prefix has been seen before, so a
   * corpus run, which repeats its prompts by construction, sees substantial
   * hits and they are priced at the cached rate. A 0 on the FIRST call for a
   * prefix means nothing was cached yet, not that the field is missing.
   * `reasoningTokens` is the thinking trace, billed inside the completion
   * budget. It can be 0 while a trace was still produced: a model that returns
   * its trace inside `content` reports no reasoning tokens at all.
   */
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  } | null;
  cost: RowCost | null;
  latencyMs: number;
  ttVisibleMs: number | null;
  error: string | null;
}

/**
 * sha256 over the materialised messages, canonicalised so that key order and
 * incidental whitespace between runs cannot change the hash. Deliberately
 * covers ONLY the messages: the tool schema travels in `toolSchemaNames` so a
 * schema change shows up as a visible field rather than as an unexplained
 * hash difference.
 */
export function hashMessages(messages: { role: string; content: string }[]): string {
  const canonical = JSON.stringify(
    messages.map((m) => ({ role: m.role, content: m.content })),
  );
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Reads the fence nonce OUT of a built prompt.
 *
 * WHY OBSERVED RATHER THAN INJECTED. `buildScoreCallForChunk` does not thread a
 * nonce through to `buildBatchScoringUserMessage`, so the only way to PIN one
 * would be to stop calling the production builder and assemble the user message
 * here instead. That trades a truthful record for a divergence from the path
 * being measured, which is a bad trade. Reading the nonce back is exact, costs
 * nothing, and keeps the builder call untouched.
 *
 * The field was previously declared and left null on every row, which made one
 * probe vacuous: a check that reads a field nobody fills can only ever pass.
 *
 * Returns null when the prompt carries no fence, which is honest for the
 * prompts that do not use one, and a joined list in the impossible case of a
 * prompt built with more than one nonce, so that shows up rather than hiding.
 */
export function extractFenceNonce(prompt: string): string | null {
  const found = new Set<string>();
  for (const m of prompt.matchAll(/<<\/?ARTICLE ([a-f0-9]{12})>>/g)) found.add(m[1]);
  if (found.size === 0) return null;
  return [...found].sort().join(',');
}

export function newRowId(): string {
  return randomUUID();
}

export interface JsonlWriter {
  path: string;
  write(row: RunRow): RunRow;
  /** Emits a byte-identical copy of `row` under a fresh rowId, so the blind
   *  rater sees the same output twice and its intra-rater agreement can be
   *  measured. The copy records what it duplicates; the rater's own copy of
   *  the file has `dupOf` stripped by the runner. */
  writeDuplicate(row: RunRow): RunRow;
  count(): number;
  close(): Promise<void>;
}

export function createJsonlWriter(opts: { dir: string; name?: string }): JsonlWriter {
  const path = join(opts.dir, opts.name ?? 'rows.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const stream: WriteStream = createWriteStream(path, { flags: 'a' });
  let written = 0;

  const write = (row: RunRow): RunRow => {
    stream.write(`${JSON.stringify(row)}\n`);
    written += 1;
    return row;
  };

  return {
    path,
    write,
    writeDuplicate(row: RunRow): RunRow {
      return write({ ...row, rowId: newRowId(), dupOf: row.dupOf ?? row.rowId });
    },
    count: () => written,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}
