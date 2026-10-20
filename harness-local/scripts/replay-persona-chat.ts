// harness-local — replay a FIXED persona-chat conversation against the real
// NEAR AI endpoint and report how often the model makes the expected tool call.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/replay-persona-chat.ts \
//     --fixture calibration-confirm --runs 20 --arm after [--model <id>]
//
// `--model` overrides BIG_MODEL for the run. That is how a CANDIDATE primary or
// fallback is probed before it goes into lib/llm/constants.ts: same prompt,
// same tool schema, same thinking gear as the app, pass rate over N runs. Every
// run prints finish_reason, completion tokens and the raw tool arguments, so an
// empty `{}` or a leaked template marker is visible without a second script.
//
// WHY THIS EXISTS. The two defects this harness measures are STOCHASTIC: the
// model sometimes calls the tool and sometimes does not. A single run — or a
// single simulator session — proves nothing about either. The only meaningful
// measurement is a PASS RATE over N runs, compared before and after a change on
// the SAME fixture. Treat anything below ~20 runs per arm as indicative only,
// and always report the run count alongside the rate.
//
// --engine afm|qwen-local|nano-proxy replays ON-DEVICE persona chat instead
// (lib/news-harness/on-device/persona-chat): its prompt and schema, the reply
// mapped to the executor tools the app would run. `--fixture` then takes a
// comma list, default every `ondevice-*` fixture, and the run is written to
// .local-test-data/runs/. Fixtures expecting runCalibration are N/A on-device.
// On-device expectations may also carry `saveMentions` (each a|b alternative
// must appear in some saved statement) and `deleteIds` (the exact ids removed).
//
// Node-only: never imported by the app bundle. It posts tools/tool_choice
// directly rather than going through adapters/nearai-llm.ts, whose LlmPort is
// batch TEXT completion and cannot express tool calling.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadHarnessEnv } from '../config/env';
import {
  buildPersonaUpdateStaticPrompt,
  buildToolDefinitions,
  buildPersonaUpdateContext,
} from '../../lib/news-harness/prompts/prompts';
import {
  BIG_MODEL,
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_REASONING_HEADROOM_TOKENS,
} from '../../lib/llm/constants';
import { buildChatTurnBody } from '../lib/chat-turn';
import { assertEngineReady, isTransportError, onDeviceChatTurn, parseEngine, type LocalEngine } from '../lib/engine';
import { createRunWriter } from '../lib/run-writer';
import {
  buildPersonaChatPrompt,
  personaChatInstructions,
  personaChatSchema,
  personaChatTurn,
  shownFactIds,
  type PersonaChatContext,
  type PersonaChatReply,
  type PersonaSurface,
} from '../../lib/news-harness/on-device/persona-chat';

interface WireMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface Fixture {
  description: string;
  knownFacts: string;
  /** Full conversation, oldest first. The last entry is the user's turn. */
  wire: WireMsg[];
  expect: {
    /** Tool that MUST be called for the run to pass. */
    toolCalled?: string;
    /** Tool that must NOT be called. */
    toolNotCalled?: string;
    /** On-device: each entry (a|b alternatives) appears in some saved statement. */
    saveMentions?: string[];
    /** On-device: deleteUserFacts names exactly these ids. */
    deleteIds?: string[];
  };
  /** On-device context: facts with ids, newest first. Else parsed from knownFacts. */
  facts?: { id: string; statement: string; attribute?: string }[];
  /** On-device surface, default CONFIG. */
  surface?: PersonaSurface;
  /** Reply language for the on-device instruction, default English. */
  language?: string;
}

/** Tools the on-device persona chat can never call: their fixtures are N/A there. */
const CLOUD_ONLY_TOOLS = new Set(['runCalibration']);

function onDeviceFacts(f: Fixture): PersonaChatContext['facts'] {
  if (f.facts) return f.facts;
  // `- 'attribute': statement` lines, oldest first; the context wants newest first.
  return f.knownFacts
    .split('\n')
    .flatMap((line, i) => {
      const m = /^- (?:'([^']*)': )?(.+)$/.exec(line.trim());
      return m ? [{ id: `k${i}`, statement: m[2], attribute: m[1] ?? null }] : [];
    })
    .reverse();
}

interface OnDeviceRun {
  fixture: string;
  run: number;
  pass: boolean;
  why: string;
  calls: { name: string; input: Record<string, unknown> }[];
  reply: string;
  latencyMs: number;
  error: string | null;
}

/** The expectation against the executor calls an on-device turn mapped to. */
export function judgeOnDevice(expect: Fixture['expect'], calls: OnDeviceRun['calls']): { pass: boolean; why: string } {
  const names = calls.map((c) => c.name);
  if (expect.toolCalled && !names.includes(expect.toolCalled)) return { pass: false, why: `no ${expect.toolCalled}` };
  if (expect.toolNotCalled && names.includes(expect.toolNotCalled)) return { pass: false, why: `called ${expect.toolNotCalled}` };
  const saved = calls
    .filter((c) => c.name === 'saveExtractedFacts')
    .flatMap((c) => (c.input.extracted_user_information as { statement: string }[]) ?? [])
    .map((x) => x.statement.toLowerCase());
  for (const m of expect.saveMentions ?? []) {
    const alts = m.toLowerCase().split('|');
    if (!saved.some((st) => alts.some((a) => st.includes(a)))) return { pass: false, why: `no saved statement names ${m}` };
  }
  if (expect.deleteIds) {
    const ids = calls.filter((c) => c.name === 'deleteUserFacts').flatMap((c) => (c.input.fact_ids as string[]) ?? []);
    if ([...new Set(ids)].sort().join(',') !== [...expect.deleteIds].sort().join(',')) return { pass: false, why: `deleted [${ids.join(',')}]` };
  }
  return { pass: true, why: 'ok' };
}

async function mainOnDevice(engine: LocalEngine, argv: string[], runs: number): Promise<number> {
  await assertEngineReady(engine);
  const dir = path.resolve(__dirname, '..', 'fixtures', 'persona-chat');
  const i = argv.indexOf('--fixture');
  const ids = i === -1
    ? fs.readdirSync(dir).filter((n) => n.startsWith('ondevice-')).map((n) => n.replace(/\.json$/, '')).sort()
    : (argv[i + 1] ?? '').split(',').filter(Boolean);
  const run = createRunWriter({ label: `persona-chat-${engine}` });
  const rowsPath = path.join(run.dir, 'rows.jsonl');
  const summary: Record<string, { pass: number; n: number; modelFails: number; na?: string }> = {};
  console.log(`engine  : ${engine} (on-device persona chat)\nruns    : ${runs} per fixture\nrun dir : ${run.dir}\n`);
  for (const id of ids) {
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as Fixture;
    const named = fixture.expect.toolCalled ?? fixture.expect.toolNotCalled ?? '';
    if (CLOUD_ONLY_TOOLS.has(named)) {
      summary[id] = { pass: 0, n: 0, modelFails: 0, na: `${named} is cloud-only` };
      console.log(`${id}: N/A on-device (${named} is cloud-only)`);
      continue;
    }
    const surface = fixture.surface ?? 'CONFIG';
    const context: PersonaChatContext = { facts: onDeviceFacts(fixture), topicPlanNotes: null, pending: null };
    const system = personaChatInstructions(surface, fixture.language ?? 'English');
    const s = (summary[id] = { pass: 0, n: 0, modelFails: 0 });
    for (let r = 0; r < runs; r++) {
      const started = Date.now();
      const out = await onDeviceChatTurn<PersonaChatReply>(engine, system, personaChatSchema(surface), (b) =>
        buildPersonaChatPrompt(surface, context, fixture.wire, b),
      );
      const turn = out.value ? personaChatTurn(out.value, { factIds: shownFactIds(context), hasPending: false }) : null;
      const row: OnDeviceRun = {
        fixture: id, run: r, pass: false, why: '', calls: turn?.calls ?? [], reply: turn?.reply ?? '',
        latencyMs: Date.now() - started, error: out.error,
      };
      if (out.error && isTransportError(out.error)) {
        row.why = `transport: ${out.error}`;
      } else {
        s.n++;
        if (out.error) {
          row.why = out.error;
          s.modelFails++;
        } else {
          Object.assign(row, judgeOnDevice(fixture.expect, row.calls));
          if (row.pass) s.pass++;
        }
      }
      fs.appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
      console.log(`  ${id} run ${String(r + 1).padStart(2)}: ${row.pass ? 'PASS' : 'FAIL'} ${row.latencyMs}ms ${row.why} calls=[${row.calls.map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 140)}`).join(' | ')}]`);
    }
    console.log(`RESULT ${id}: ${s.pass}/${s.n}${s.modelFails ? ` (${s.modelFails} model-outcome fails)` : ''}\n`);
  }
  const scored = Object.values(summary).filter((x) => !x.na);
  const pass = scored.reduce((a, x) => a + x.pass, 0);
  const n = scored.reduce((a, x) => a + x.n, 0);
  console.log(`FACT-SAVE ACCURACY ${engine}: ${pass}/${n} (${n ? Math.round((pass / n) * 100) : 0}%)`);
  run.writeJson('summary', { engine, runs, fixtures: summary, pass, n });
  return 0;
}

interface Args {
  fixture: string;
  runs: number;
  arm: 'before' | 'after';
  /** Append the P2 `## PENDING INVITATION` block to <context>. */
  intent: boolean;
  /** Model id to post. Defaults to the shipped BIG_MODEL. */
  model: string;
  /** chat_template_kwargs.enable_thinking. Defaults ON, the app's chat gear. */
  thinking: boolean;
  /** Post `stream: true` and time the SSE body the way cloudChatStream sees it:
   *  first byte, first VISIBLE delta (content or tool_call), and completion. */
  stream: boolean;
  /** `reasoning_effort` to post (none|low|medium|high|max); omitted by default.
   *  NEAR validates the value, so a bad one 400s — usable as a control. */
  effort?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fixture: 'calibration-confirm',
    runs: 20,
    arm: 'after',
    intent: false,
    model: BIG_MODEL,
    thinking: true,
    stream: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i] ?? args.fixture;
    else if (a === '--runs') args.runs = Number(argv[++i] ?? args.runs);
    else if (a === '--arm') args.arm = (argv[++i] as Args['arm']) ?? args.arm;
    else if (a === '--intent') args.intent = true;
    else if (a === '--model') args.model = argv[++i] ?? args.model;
    else if (a === '--thinking') args.thinking = (argv[++i] ?? 'on') !== 'off';
    else if (a === '--stream') args.stream = true;
    else if (a === '--effort') args.effort = argv[++i];
  }
  return args;
}

interface ToolCall {
  function?: { name?: string; arguments?: string };
}

interface RunResult {
  tools: string[];
  /** Raw JSON arguments per tool call, in call order — schema conformance is
   *  judged by eye on these, exactly as the 2026-08-03 probe did. */
  args: string[];
  text: string;
  finishReason: string;
  completionTokens: number | undefined;
  /** Wall time of the HTTP call — a reasoning model pays its trace here. */
  latencyMs: number;
  /** --stream only: ms to the first SSE byte and to the first VISIBLE delta
   *  (a content or tool_call delta; reasoning deltas are dropped by the app). */
  ttfbMs?: number;
  ttVisibleMs?: number;
  error?: string;
}

/** The P2 intent block, verbatim as planned. Measured here BEFORE shipping it,
 *  because it is the guard against a bare non-confirmation firing the tool. */
const PENDING_INVITATION = `## PENDING INVITATION
Mera offered to re-tune the on-device relevance scoring to match the user's own corrections. If the user confirms (yes / ok / go ahead / please do — any language), call runCalibration and nothing else. If they decline, change the subject, or say anything that is not a confirmation, do NOT call it and do NOT bring it up again.
This is the ONLY action a bare confirmation may trigger.`;

async function runOnce(
  fixture: Fixture,
  arm: Args['arm'],
  intent: boolean,
  model: string,
  thinking: boolean,
  stream: boolean,
  effort: string | undefined,
  env: ReturnType<typeof loadHarnessEnv>,
): Promise<RunResult> {
  const failed = (error: string): RunResult => ({
    tools: [],
    args: [],
    text: '',
    finishReason: '-',
    completionTokens: undefined,
    latencyMs: 0,
    error,
  });
  const systemPrompt = buildPersonaUpdateStaticPrompt({
    surface: 'CONFIG',
    includeToolFormat: false, // cloud path uses native tool calling
    languageName: 'English',
    mode: 'CLOUD',
  });
  let context = buildPersonaUpdateContext({ knownFactsList: fixture.knownFacts });
  if (intent) {
    context = context.replace('\n</context>', `\n\n${PENDING_INVITATION}\n</context>`);
  }

  // BEFORE arm reproduces the old window: ONLY the final user turn, with the
  // conversation that gave it meaning discarded. AFTER carries the whole thing.
  const carried = arm === 'before' ? fixture.wire.slice(-1) : fixture.wire;

  // <context> is injected onto the LAST user message, exactly as the app does.
  // lib/chat-turn.ts exports withContextOnLastUserTurn, which does the same;
  // this local copy stays so this script's behaviour is unchanged by the
  // extraction, which was about the request BODY.
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...carried.map((m, i) =>
      i === carried.length - 1 && m.role === 'user'
        ? { role: m.role, content: `${context}\n\n${m.content}` }
        : { role: m.role, content: m.content },
    ),
  ];

  const startedAt = Date.now();
  // The body is built by harness-local/lib/chat-turn.ts, which the corpus
  // runner also uses, so the two cannot drift apart. It produces byte-identical
  // output to the literal that used to sit here, pinned in scripts/selftest.ts.
  const res = await fetch(`${env.nearAiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.nearAiApiKey}`,
    },
    body: JSON.stringify(
      buildChatTurnBody({
        model,
        messages,
        tools: buildToolDefinitions('CONFIG'),
        thinking,
        stream,
        effort,
      }),
    ),
  });

  if (!res.ok) {
    return failed(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (stream) return readStream(res, startedAt);
  const json = (await res.json()) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: ToolCall[] };
      finish_reason?: string;
    }[];
    usage?: { completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  const msg = choice?.message;
  return {
    tools: (msg?.tool_calls ?? []).map((c) => c.function?.name ?? '?'),
    args: (msg?.tool_calls ?? []).map((c) => c.function?.arguments ?? ''),
    text: (msg?.content ?? '').slice(0, 120),
    finishReason: choice?.finish_reason ?? '-',
    completionTokens: json.usage?.completion_tokens,
    latencyMs: Date.now() - startedAt,
  };
}

/** Consume an SSE body and time it. Mirrors what cloudChatStream keeps: the
 *  first `delta.content` or `delta.tool_calls` is the first thing a user could
 *  see; `delta.reasoning_content` is dropped without being shown. */
async function readStream(res: Response, startedAt: number): Promise<RunResult> {
  const decoder = new TextDecoder();
  const reader = res.body?.getReader();
  if (!reader) {
    return {
      tools: [], args: [], text: '', finishReason: '-', completionTokens: undefined,
      latencyMs: Date.now() - startedAt, error: 'no body',
    };
  }
  let ttfbMs: number | undefined;
  let ttVisibleMs: number | undefined;
  let finishReason = '-';
  let completionTokens: number | undefined;
  let text = '';
  const toolNames = new Map<number, string>();
  const toolArgs = new Map<number, string>();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (ttfbMs === undefined) ttfbMs = Date.now() - startedAt;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let evt: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: { completion_tokens?: number } | null;
      };
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.usage?.completion_tokens !== undefined) completionTokens = evt.usage.completion_tokens;
      const choice = evt.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        if (ttVisibleMs === undefined) ttVisibleMs = Date.now() - startedAt;
        text += delta.content;
      }
      for (const tc of delta?.tool_calls ?? []) {
        if (ttVisibleMs === undefined) ttVisibleMs = Date.now() - startedAt;
        const idx = tc.index ?? 0;
        if (tc.function?.name) toolNames.set(idx, tc.function.name);
        if (tc.function?.arguments) toolArgs.set(idx, (toolArgs.get(idx) ?? '') + tc.function.arguments);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  const order = [...toolNames.keys()].sort((a, b) => a - b);
  return {
    tools: order.map((i) => toolNames.get(i) ?? '?'),
    args: order.map((i) => toolArgs.get(i) ?? ''),
    text: text.slice(0, 120),
    finishReason,
    completionTokens,
    latencyMs: Date.now() - startedAt,
    ttfbMs,
    ttVisibleMs,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const engine = parseEngine(process.argv.slice(2));
  if (engine !== 'cloud') return mainOnDevice(engine, process.argv.slice(2), args.runs);
  const env = loadHarnessEnv();

  const fixturePath = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'persona-chat',
    `${args.fixture}.json`,
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture;

  console.log(`fixture : ${args.fixture} — ${fixture.description}`);
  console.log(`arm     : ${args.arm} (${args.arm === 'before' ? 'final user turn only' : 'full history'})`);
  console.log(`runs    : ${args.runs}`);
  console.log(`intent  : ${args.intent ? 'PENDING INVITATION block present (P2)' : 'absent'}`);
  console.log(`model   : ${args.model}${args.model === BIG_MODEL ? ' (BIG_MODEL)' : ' (override)'}`);
  console.log(`thinking: ${args.thinking ? 'on (app chat gear)' : 'off'}`);
  console.log(`stream  : ${args.stream ? 'on — timing first visible delta' : 'off'}`);
  console.log(`effort  : ${args.effort ?? '(not sent)'}\n`);

  let pass = 0;
  let errors = 0;
  let lengthCapped = 0;
  const latencies: number[] = [];
  const visibles: number[] = [];
  const toolTally = new Map<string, number>();

  for (let i = 0; i < args.runs; i++) {
    let out: RunResult;
    try {
      out = await runOnce(fixture, args.arm, args.intent, args.model, args.thinking, args.stream, args.effort, env);
    } catch (err) {
      out = {
        tools: [],
        args: [],
        text: '',
        finishReason: '-',
        completionTokens: undefined,
        latencyMs: 0,
        error: String(err),
      };
    }
    if (out.error) {
      errors++;
      console.log(`  run ${String(i + 1).padStart(2)}: ERROR ${out.error}`);
      continue;
    }
    for (const t of out.tools) toolTally.set(t, (toolTally.get(t) ?? 0) + 1);
    if (out.finishReason === 'length') lengthCapped++;
    latencies.push(out.latencyMs);
    if (out.ttVisibleMs !== undefined) visibles.push(out.ttVisibleMs);

    const { toolCalled, toolNotCalled } = fixture.expect;
    const ok = toolCalled
      ? out.tools.includes(toolCalled)
      : toolNotCalled
        ? !out.tools.includes(toolNotCalled)
        : false;
    if (ok) pass++;
    const argsShown = out.args.map((a) => a.replace(/\s+/g, ' ').slice(0, 160)).join(' | ');
    console.log(
      `  run ${String(i + 1).padStart(2)}: ${ok ? 'PASS' : 'FAIL'} finish=${out.finishReason} ` +
        `ctok=${out.completionTokens ?? '?'} ms=${out.latencyMs}` +
        (out.ttVisibleMs !== undefined ? ` ttfb=${out.ttfbMs} visible=${out.ttVisibleMs}` : '') +
        ` tools=[${out.tools.join(', ')}] ` +
        `args=${argsShown || '-'} "${out.text.replace(/\n/g, ' ')}"`,
    );
  }
  if (lengthCapped > 0) {
    console.log(
      `\nWARNING ${lengthCapped} run(s) hit max_tokens (${CHAT_MAX_OUTPUT_TOKENS + CHAT_REASONING_HEADROOM_TOKENS}) — the thinking ` +
        'trace is competing with the answer for the chat budget.',
    );
  }

  const attempted = args.runs - errors;
  console.log(
    `\nRESULT ${args.fixture}/${args.arm}: ${pass}/${attempted} ` +
      `(${attempted > 0 ? Math.round((pass / attempted) * 100) : 0}%)` +
      (errors ? `  [${errors} transport errors excluded]` : ''),
  );
  console.log('tool calls seen:', Object.fromEntries(toolTally));
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(`latency ms: median=${p(0.5)} p90=${p(0.9)} max=${sorted[sorted.length - 1]}`);
  }
  if (visibles.length > 0) {
    const sorted = [...visibles].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(`first visible delta ms: median=${p(0.5)} p90=${p(0.9)} max=${sorted[sorted.length - 1]}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
