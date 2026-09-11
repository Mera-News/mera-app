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
  };
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
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...carried.map((m, i) =>
      i === carried.length - 1 && m.role === 'user'
        ? { role: m.role, content: `${context}\n\n${m.content}` }
        : { role: m.role, content: m.content },
    ),
  ];

  const startedAt = Date.now();
  const res = await fetch(`${env.nearAiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.nearAiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: buildToolDefinitions('CONFIG'),
      tool_choice: 'auto',
      // cloudChatStream adds the reasoning headroom on top of the answer budget.
      max_tokens: CHAT_MAX_OUTPUT_TOKENS + CHAT_REASONING_HEADROOM_TOKENS,
      temperature: 0.4,
      // WIRE PARITY: cloudChatStream hardcodes thinking ON for chat turns. A
      // reasoning model measured with thinking off is a different gear from the
      // one the app ships, and the trace shares max_tokens with the answer.
      chat_template_kwargs: { enable_thinking: thinking },
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
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
  console.log(`stream  : ${args.stream ? 'on — timing first visible delta' : 'off'}\n`);

  let pass = 0;
  let errors = 0;
  let lengthCapped = 0;
  const latencies: number[] = [];
  const visibles: number[] = [];
  const toolTally = new Map<string, number>();

  for (let i = 0; i < args.runs; i++) {
    let out: RunResult;
    try {
      out = await runOnce(fixture, args.arm, args.intent, args.model, args.thinking, args.stream, env);
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
