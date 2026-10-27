// harness-local — the single-shot agent runner (follow a story, article chat).
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/run-singleshot-corpus.ts --target staging \
//       --graphql-endpoint ... --auth-endpoint ... [--repeat 3] [--dry-run]
//       [--model <id>] [--arms on,on-twin,off,off-twin]
//
// WHAT IT MEASURES. One turn of FollowStoryAgent or ArticleFeedbackAgent the way
// useCloudPersonaChat's single-shot path runs it: the agent's real system prompt,
// context prepended to the last user message, the app's text tool wire (xml),
// streamed, BIG_MODEL (or --model), a first pass and ONE continuation when a knowledge tool
// ran or no text came back. Tool results are canned per fixture, like the agent
// corpus's fakes, so the arms differ only in the thinking gear.
//
// ARMS: `on` (thinking on, budget + reasoning headroom), `on-twin`
// (byte-identical, the noise floor), `off` (shipped: thinking off, no headroom)
// and `off-twin` (byte-identical to `off`). --arms picks them (default
// on,on-twin,off). The pass rule is printed before any call and judged on the
// turn's outcome; the VERDICT needs `on`, `on-twin` and `off`.
//
// PROMPT-VERSION ARMS (D8): `pre`, `post` and `post-twin`, all thinking off as shipped.
// `post` and `post-twin` use the live prompt builders; `pre` uses the exact shipped strings and
// tool arrays from a JSON snapshot passed with --pre-prompts <path> (keys followStory,
// followStoryTools, article, articleTools; required when `pre` is in --arms). The run throws if
// the snapshot's system prompts are byte-equal to the live ones (the arm would measure nothing).
// With exactly --arms pre,post,post-twin the verdict is, per fixture kind k: spread_k = |post_k - post-twin_k| passes;
// PASS when post proposeTrack passes >= pre - max(1, spread), and proposeFactCheck and
// answer each have |post_k - pre_k| <= max(1, spread_k). No on/off verdict is printed.
//
// --engine afm|qwen-local|nano-proxy runs the ON-DEVICE flows instead
// (lib/news-harness/on-device/follow-story and article-feedback): their prompts,
// schemas and turn mappers, through lib/engine.ts. Arms are `<engine>` and its
// byte-identical `<engine>-twin`; no staging credentials are needed. Score the
// options with scripts/score-option-quality.ts.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessEnv } from '../config/env';
import { applyEndpointOverrides, applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';
import { createRunWriter } from '../lib/run-writer';
import { postBodyStreamTextTools, SpendLimitError, type NearToolCall } from '../lib/near-call';
import { BIG_MODEL, CHAT_MAX_OUTPUT_TOKENS, CHAT_REASONING_HEADROOM_TOKENS } from '../../lib/llm/constants';
import { APP_TOOL_FORMAT } from '../../lib/llm/text-tool-protocol';
import {
  buildFollowStoryContext,
  buildFollowStorySystemPrompt,
  getFollowStoryToolDefinitions,
} from '../../lib/news-harness/follow-story';
import {
  buildArticleFeedbackSystemPrompt,
  buildFeedbackContext,
  getArticleFeedbackToolDefinitions,
  parseTrackScopeOptions,
} from '../../lib/news-harness/article-feedback/agent-core';
import { KNOWLEDGE_TOOL_NAMES } from '../../lib/news-harness/persona-management/persona-agent-core';
import { asUntrusted } from '../../lib/news-harness/prompts/untrusted-text';
import { jsonCandidates } from '../../lib/mera-protocol-toolkit/core/structured-json';
import {
  buildFollowStoryPrompt,
  FOLLOW_STORY_SCHEMA,
  followStoryInstructions,
  followStoryTurn,
  type FollowStoryReply,
} from '../../lib/news-harness/on-device/follow-story';
import {
  ARTICLE_FEEDBACK_SCHEMA,
  articleFeedbackInstructions,
  articleFeedbackTurn,
  buildArticleFeedbackPrompt,
  type ArticleFeedbackReply,
} from '../../lib/news-harness/on-device/article-feedback';
import type { OnDeviceTurnResult } from '../../lib/news-harness/on-device/shared';
import { assertEngineReady, isTransportError, onDeviceChatTurn, parseEngine, type LocalEngine } from '../lib/engine';

interface Fixture {
  id: string;
  agent: 'follow-story' | 'article';
  message: string;
  expect: 'proposeTrack' | 'proposeFactCheck' | 'answer';
  search: string[];
  article?: { title: string; publication: string; description: string; related: string[] };
}

interface Arm { id: string; thinking: boolean; prompts?: 'pre' }
const ARMS: Arm[] = [
  { id: 'on', thinking: true },
  { id: 'on-twin', thinking: true },
  { id: 'off', thinking: false },
  { id: 'off-twin', thinking: false },
  { id: 'pre', thinking: false, prompts: 'pre' },
  { id: 'post', thinking: false },
  { id: 'post-twin', thinking: false },
];

export interface PrePrompts { followStory: string; followStoryTools: unknown[]; article: string; articleTools: unknown[] }

type Msg = { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string };

const FIXTURES = join(__dirname, '../../lib/mera-harness/eval/fixtures/singleshot/turns.json');
// Fixed so prompts are byte-stable across arms and runs.
const NOW_MS = Date.parse('2026-10-14T12:00:00Z');

export function parseArgs(argv: string[]): { repeat: number; dryRun: boolean; label: string; model: string; arms: Arm[]; prePrompts?: string } {
  let repeat = 3;
  let dryRun = false;
  let label = 'singleshot';
  let model = BIG_MODEL;
  let arms = ARMS.slice(0, 3);
  let prePrompts: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeat') repeat = Number(argv[++i]);
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--label') label = argv[++i] ?? label;
    else if (argv[i] === '--model') model = argv[++i] ?? model;
    else if (argv[i] === '--pre-prompts') prePrompts = argv[++i];
    else if (argv[i] === '--arms') {
      arms = (argv[++i] ?? '').split(',').map((id) => {
        const arm = ARMS.find((a) => a.id === id);
        if (!arm) throw new Error(`unknown arm "${id}" (known: ${ARMS.map((a) => a.id).join(',')})`);
        return arm;
      });
      if (new Set(arms.map((a) => a.id)).size !== arms.length) throw new Error('duplicate arm in --arms');
    }
  }
  if (arms.some((a) => a.prompts === 'pre') && !prePrompts) throw new Error('arm "pre" needs --pre-prompts <path>');
  return { repeat, dryRun, label, model, arms, prePrompts };
}

export const liveSystem = (agent: Fixture['agent']): string =>
  setup({ agent, article: { title: '', publication: '', description: '', related: [] } } as Fixture).system;

/** Loads the shipped-prompt snapshot; throws when it is malformed or equals the live prompts. */
export function loadPrePrompts(path: string): PrePrompts {
  const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrePrompts>;
  for (const k of ['followStory', 'article'] as const) if (typeof j[k] !== 'string' || !j[k]) throw new Error(`--pre-prompts: "${k}" must be a non-empty string`);
  for (const k of ['followStoryTools', 'articleTools'] as const) if (!Array.isArray(j[k])) throw new Error(`--pre-prompts: "${k}" must be an array`);
  const pre = j as PrePrompts;
  if (pre.followStory === liveSystem('follow-story') || pre.article === liveSystem('article')) {
    throw new Error('--pre-prompts: snapshot equals the live system prompt, so the pre arm would measure nothing');
  }
  return pre;
}

interface VerdictRow { arm: string; expect: Fixture['expect']; pass: boolean }
/** D8 rule: see the header. Counts are over the count-matched rows. */
/** D8 rule: see the header. Counts are over the count-matched rows; spread is per fixture kind. */
export function prePostVerdict(rows: VerdictRow[]): { spread: Record<Fixture['expect'], number>; trackOk: boolean; othersOk: boolean; verdict: 'PASS' | 'FAIL' } {
  const n = (arm: string, k: Fixture['expect']): number => rows.filter((x) => x.arm === arm && x.pass && x.expect === k).length;
  const kinds = ['proposeTrack', 'proposeFactCheck', 'answer'] as const;
  const spread = Object.fromEntries(kinds.map((k) => [k, Math.abs(n('post', k) - n('post-twin', k))])) as Record<Fixture['expect'], number>;
  const trackOk = n('post', 'proposeTrack') >= n('pre', 'proposeTrack') - Math.max(1, spread.proposeTrack);
  const othersOk = (['proposeFactCheck', 'answer'] as const).every((k) => Math.abs(n('post', k) - n('pre', k)) <= Math.max(1, spread[k]));
  return { spread, trackOk, othersOk, verdict: trackOk && othersOk ? 'PASS' : 'FAIL' };
}

const isPrePostSet = (arms: Arm[]): boolean => arms.map((a) => a.id).join(',') === 'pre,post,post-twin';

/** COUNT-MATCHED: an error row drops its (fixture, repeat) for every arm, not the whole repeat. */
export function countMatched<T extends { fixture: string; repeat: number; error: string | null }>(rows: T[], armCount: number): { valid: T[]; dropped: string[] } {
  const cell = (x: T): string => `${x.fixture} r${x.repeat}`;
  const dropped = new Set(rows.filter((x) => x.error).map(cell));
  // A run cut mid-fixture (spend limit) leaves a cell with only some arms: drop it too.
  const seen = new Map<string, number>();
  for (const x of rows) seen.set(cell(x), (seen.get(cell(x)) ?? 0) + 1);
  for (const [c, n] of seen) if (n < armCount) dropped.add(c);
  return { valid: rows.filter((x) => !dropped.has(cell(x))), dropped: [...dropped].sort() };
}

function setup(f: Fixture, arm?: Arm, pre?: PrePrompts): { system: string; tools: unknown[]; history: Msg[]; context: string } {
  if (f.agent === 'follow-story') {
    return {
      system: arm?.prompts === 'pre' ? pre!.followStory : buildFollowStorySystemPrompt({ needsToolFormat: false, languageName: 'English', canSearch: true, webSearch: true }),
      tools: arm?.prompts === 'pre' ? pre!.followStoryTools : getFollowStoryToolDefinitions('CLOUD', true),
      history: [
        { role: 'user', content: 'I want to follow a story' },
        { role: 'assistant', content: 'What story or subject should Mera follow?' },
      ],
      context: buildFollowStoryContext({ nowMs: NOW_MS, proposal: null }),
    };
  }
  const a = f.article!;
  return {
    system: arm?.prompts === 'pre' ? pre!.article : buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English', webSearch: true, factCheck: true }),
    tools: arm?.prompts === 'pre' ? pre!.articleTools : getArticleFeedbackToolDefinitions('CLOUD', true),
    history: [],
    context: buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: {
        suggestion: {
          title_en: asUntrusted(a.title, a.title.length),
          publication_name: asUntrusted(a.publication, a.publication.length),
          description_en: asUntrusted(a.description, a.description.length),
          isScored: true,
          relevance: 0.7,
        },
        matchedTopicTexts: [],
        linkedFacts: [],
      },
      proposal: null,
      relatedCoverage: a.related,
    }),
  };
}

/** Canned tool results: the arms must see identical tool output. */
function runTool(f: Fixture, call: NearToolCall): unknown {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.argumentsRaw || '{}'); } catch { /* malformed: still answered */ }
  if (call.name === 'searchNews') {
    if (f.search.length === 0) {
      return { query: args.query ?? '', articles: [], note: "Nothing in the last 48 hours of Mera's news index matches this. Say so plainly; do not invent an article." };
    }
    return {
      query: args.query ?? '',
      articles: f.search.map((t, i) => ({ id: `a${i}`, title: t, publication: 'Reuters', country: null, date: '2026-10-13' })),
      note: 'Headlines only — you do not have the article text. Summarise what the headlines say and never invent details or a link.',
    };
  }
  if (call.name === 'webSearch') {
    return { results: f.search.map((t, i) => ({ title: t, url: `https://example.org/${i}`, description: t })) };
  }
  if (call.name === 'proposeTrack') return { staged: true, options: parseTrackScopeOptions(args.options).length };
  if (call.name === 'proposeFactCheck') return { staged: true };
  return { ok: true };
}

interface TurnRow {
  fixture: string; arm: string; repeat: number; at: string;
  expect: Fixture['expect']; pass: boolean; why: string;
  passes: number; wallMs: number; firstVisibleMs: number | null;
  completionTokens: number; reasoningTokens: number; truncated: boolean; error: string | null;
  /** Cloud: legs postBodyStreamTextTools retried (stall, total timeout, fetch failed). */
  stallRetries?: number;
  calls: string[]; trackOptions: number; reply: string;
  /** The staged options as parsed by the executor, for score-option-quality. */
  options?: { label: string; search: string }[];
  /** On-device: options in the model's raw JSON, before the schema reader cut any. */
  rawOptionCount?: number;
  /** On-device article chat: the intent the model picked. */
  intent?: string;
}

async function runTurn(
  env: { nearAiBaseUrl: string; nearAiApiKey: string },
  f: Fixture, arm: Arm, model: string, repeat: number, dryRun: boolean, pre?: PrePrompts,
): Promise<TurnRow | { dry: number }> {
  const { system, tools, history, context } = setup(f, arm, pre);
  const wire: Msg[] = [...history, { role: 'user', content: f.message }];
  const bodyFor = (): Record<string, unknown> => {
    const last = wire.map((m) => m.role).lastIndexOf('user');
    const msgs = wire.map((m, i) => (i === last ? { ...m, content: `${context}\n\n${m.content}` } : m));
    return {
      model,
      messages: [{ role: 'system', content: system }, ...msgs],
      tools,
      tool_choice: 'auto',
      chat_template_kwargs: { enable_thinking: arm.thinking },
      // Mirrors cloudChatStream: the reasoning headroom exists only for the trace.
      max_tokens: CHAT_MAX_OUTPUT_TOKENS + (arm.thinking ? CHAT_REASONING_HEADROOM_TOKENS : 0),
    };
  };
  if (dryRun) return { dry: JSON.stringify(bodyFor()).length };

  const row: TurnRow = {
    fixture: f.id, arm: arm.id, repeat, at: new Date().toISOString(), expect: f.expect, pass: false, why: '',
    passes: 0, wallMs: 0, firstVisibleMs: null, completionTokens: 0, reasoningTokens: 0, truncated: false,
    error: null, calls: [], trackOptions: 0, reply: '',
  };
  const started = Date.now();
  for (let pass = 0; pass < 2; pass++) {
    const r = await postBodyStreamTextTools(env.nearAiBaseUrl, env.nearAiApiKey, bodyFor(), 120_000, undefined, APP_TOOL_FORMAT);
    row.passes++;
    row.stallRetries = (row.stallRetries ?? 0) + (r.stallRetries ?? 0);
    if (pass === 0) row.firstVisibleMs = r.ttVisibleMs;
    row.completionTokens += r.usage?.completionTokens ?? 0;
    row.reasoningTokens += r.usage?.reasoningTokens ?? 0;
    row.truncated ||= r.truncated;
    if (r.error) { row.error = r.error; break; }
    if (r.content.trim()) row.reply = r.content.trim();
    const ids = r.toolCalls.map((_, i) => `call_${pass}_${i}`);
    wire.push({
      role: 'assistant', content: r.content,
      ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map((c, i) => ({ id: ids[i], type: 'function', function: { name: c.name, arguments: c.argumentsRaw } })) } : {}),
    });
    for (const [i, c] of r.toolCalls.entries()) {
      row.calls.push(c.name);
      if (c.name === 'proposeTrack') {
        try {
          const options = parseTrackScopeOptions(JSON.parse(c.argumentsRaw || '{}').options);
          if (options.length >= row.trackOptions) row.options = options;
          row.trackOptions = Math.max(row.trackOptions, options.length);
        } catch { /* 0 */ }
      }
      wire.push({ role: 'tool', tool_call_id: ids[i], content: JSON.stringify(runTool(f, c)) });
    }
    const knowledge = r.toolCalls.some((c) => KNOWLEDGE_TOOL_NAMES.has(c.name));
    if (!(knowledge || r.content.trim() === '')) break;
  }
  row.wallMs = Date.now() - started;

  const leaked = /<\/?think>|<tool_call>|<function=/.test(row.reply);
  if (row.error) { row.why = 'error'; }
  else if (leaked) { row.why = 'leaked markup in reply'; }
  else if (f.expect === 'proposeTrack') {
    row.pass = row.trackOptions >= 3 && row.trackOptions <= 4;
    row.why = row.pass ? 'ok' : `proposeTrack options=${row.trackOptions}`;
  } else if (f.expect === 'proposeFactCheck') {
    row.pass = row.calls.includes('proposeFactCheck');
    row.why = row.pass ? 'ok' : `calls=${row.calls.join('+') || 'none'}`;
  } else {
    row.pass = row.reply.length > 0 && !row.truncated;
    row.why = row.pass ? 'ok' : row.truncated ? 'truncated' : 'empty reply';
  }
  return row;
}

/** Options in the model's raw reply, before fitsSchema cut a fifth. */
function rawOptionCount(content: string): number | undefined {
  for (const t of [content, ...jsonCandidates(content, '{')]) {
    try {
      const v = JSON.parse(t) as { options?: unknown };
      if (Array.isArray(v?.options)) return v.options.length;
    } catch { /* next */ }
  }
  return undefined;
}

/**
 * One on-device turn: the app's on-device agent run in the harness. The
 * history and fixture article are the cloud path's; prompt, schema and the
 * reply-to-executor mapping are the on-device flow's. On-device has no fact
 * check, so a fact-check request passes as an `answer` with no calls.
 */
async function runTurnOnDevice(engine: LocalEngine, f: Fixture, arm: string, repeat: number): Promise<TurnRow> {
  const today = new Date(NOW_MS).toISOString().slice(0, 10);
  const row: TurnRow = {
    fixture: f.id, arm, repeat, at: new Date().toISOString(), expect: f.expect, pass: false, why: '',
    passes: 0, wallMs: 0, firstVisibleMs: null, completionTokens: 0, reasoningTokens: 0, truncated: false,
    error: null, calls: [], trackOptions: 0, reply: '',
  };
  const started = Date.now();
  let turn: OnDeviceTurnResult | null = null;
  let content = '';
  if (f.agent === 'follow-story') {
    const history = [
      { role: 'user' as const, content: 'I want to follow a story' },
      { role: 'assistant' as const, content: 'What story or subject should Mera follow?' },
      { role: 'user' as const, content: f.message },
    ];
    const out = await onDeviceChatTurn<FollowStoryReply>(engine, followStoryInstructions('English'), FOLLOW_STORY_SCHEMA, (b) =>
      buildFollowStoryPrompt({ today }, history, b),
    );
    row.passes = out.attempts.length;
    content = out.attempts.at(-1)?.content ?? '';
    row.error = out.error;
    if (out.value) turn = followStoryTurn(out.value);
  } else {
    const a = f.article!;
    const context = {
      today, title: a.title, publication: a.publication, description: a.description, relevance: 0.7,
      matchedTopics: [], producingFacts: [], relatedCoverage: a.related,
    };
    const out = await onDeviceChatTurn<ArticleFeedbackReply>(engine, articleFeedbackInstructions('English'), ARTICLE_FEEDBACK_SCHEMA, (b) =>
      buildArticleFeedbackPrompt(context, [{ role: 'user', content: f.message }], b),
    );
    row.passes = out.attempts.length;
    content = out.attempts.at(-1)?.content ?? '';
    row.error = out.error;
    if (out.value) {
      row.intent = out.value.intent;
      turn = articleFeedbackTurn(out.value, { matchedTopics: [], publication: a.publication, hasPending: false });
    }
  }
  row.wallMs = Date.now() - started;
  row.rawOptionCount = rawOptionCount(content);
  if (turn) {
    row.reply = turn.reply;
    row.calls = turn.calls.map((c) => c.name);
    const track = turn.calls.find((c) => c.name === 'proposeTrack');
    if (track) {
      row.options = parseTrackScopeOptions(track.input.options);
      row.trackOptions = row.options.length;
    }
  }

  if (row.error) {
    // A model outcome (guardrail, refusal, context, no JSON) is a FAIL the user would see;
    // only a transport failure is an error row that drops its (fixture, repeat) for every arm.
    row.why = row.error;
    if (!isTransportError(row.error)) row.error = null;
    return row;
  }
  if (/<\/?think>|<tool_call>|<function=/.test(row.reply)) row.why = 'leaked markup in reply';
  else if (f.expect === 'proposeTrack') {
    row.pass = row.trackOptions >= 3 && row.trackOptions <= 4;
    row.why = row.pass ? 'ok' : `proposeTrack options=${row.trackOptions}`;
  } else {
    // proposeFactCheck is cloud-only: on-device the right turn explains that, with no calls.
    row.pass = row.reply.length > 0 && row.calls.length === 0 && (row.intent === undefined || row.intent === 'answer');
    row.why = row.pass ? 'ok' : `intent=${row.intent ?? '-'} calls=${row.calls.join('+') || 'none'} reply=${row.reply.length}`;
  }
  return row;
}

async function mainOnDevice(engine: LocalEngine, args: { repeat: number; label: string }, fixtures: Fixture[]): Promise<number> {
  await assertEngineReady(engine);
  const arms = [engine, `${engine}-twin`];
  console.log(
    `fixtures ${fixtures.length} x arms ${arms.join(',')} x repeat ${args.repeat}, ON-DEVICE flows on ${engine}\n` +
      'PASS RULE (fixed before the run): proposeTrack = 3 or 4 staged options; proposeFactCheck and answer = intent answer,\n' +
      'a non-empty reply and no calls (fact checks are cloud-only). A guardrail, refusal, context or no-JSON outcome is a FAIL;\n' +
      'only a transport failure is an error row, and it drops its (fixture, repeat) for every arm. The twin is the noise floor.',
  );
  const run = createRunWriter({ label: args.label });
  const out = join(run.dir, 'rows.jsonl');
  const rows: TurnRow[] = [];
  for (let r = 0; r < args.repeat; r++) {
    for (const f of fixtures) {
      for (const arm of r % 2 ? [...arms].reverse() : arms) {
        const row = await runTurnOnDevice(engine, f, arm, r);
        rows.push(row);
        appendFileSync(out, `${JSON.stringify(row)}\n`);
        console.log(`r${r} ${arm.padEnd(16)} ${f.id.padEnd(24)} ${row.pass ? 'PASS' : 'FAIL'} ${String(row.wallMs).padStart(6)}ms ${row.why}`);
      }
    }
  }
  const { valid, dropped } = countMatched(rows, arms.length);
  console.log(`\nrun dir: ${run.dir}\ndropped (fixture, repeat) cells (transport errors): ${dropped.join(', ') || 'none'}`);
  const stats: Record<string, { pass: number; n: number; p50: number; p90: number; modelFails: number }> = {};
  for (const a of arms) {
    const xs = valid.filter((x) => x.arm === a);
    const s = (stats[a] = {
      pass: xs.filter((x) => x.pass).length, n: xs.length,
      p50: pct(xs.map((x) => x.wallMs), 50), p90: pct(xs.map((x) => x.wallMs), 90),
      modelFails: xs.filter((x) => /^(ERR_AFM_|StructuredOutputError|HTTP 400)/.test(x.why)).length,
    });
    console.log(`${a.padEnd(16)} pass ${s.pass}/${s.n}  turn p50 ${s.p50}ms p90 ${s.p90}ms  model-outcome fails ${s.modelFails}`);
    for (const kind of ['proposeTrack', 'proposeFactCheck', 'answer'] as const) {
      const k = xs.filter((x) => x.expect === kind);
      console.log(`                 ${kind.padEnd(16)} ${k.filter((x) => x.pass).length}/${k.length}`);
    }
  }
  run.writeJson('summary', { engine, stats, droppedCells: dropped });
  return 0;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  applyEndpointOverrides(argv);
  const args = parseArgs(argv);
  const engine = parseEngine(argv);
  if (engine !== 'cloud') {
    return mainOnDevice(engine, { ...args, label: args.label === 'singleshot' ? `singleshot-${engine}` : args.label },
      JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixture[]);
  }
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);
  const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixture[];
  const pre = args.prePrompts ? loadPrePrompts(args.prePrompts) : undefined;
  const prePost = isPrePostSet(args.arms);
  const missing = prePost ? [] : ['on', 'on-twin', 'off'].filter((id) => !args.arms.some((a) => a.id === id));
  const noVerdict = `NO VERDICT: arm(s) ${missing.join(', ')} not in --arms; the pass rule needs on, on-twin and off.`;

  // eslint-disable-next-line no-console
  console.log(
    `fixtures ${fixtures.length} x arms ${args.arms.map((a) => a.id).join(',')} x repeat ${args.repeat}, model ${args.model}, format ${APP_TOOL_FORMAT}\n` +
      (prePost
        ? 'PASS RULE (fixed before the run): per kind k, spread_k = |post_k - post-twin_k| passes; PASS when post proposeTrack >= pre - max(1, spread_proposeTrack)\n' +
          'and proposeFactCheck and answer each satisfy |post_k - pre_k| <= max(1, spread_k). An error row drops its (fixture, repeat) for every arm.'
        : 'PASS RULE (fixed before the run): `off` passes if its turn pass count is >= `on` minus max(1, |on - on-twin|),\n' +
          'it leaks no markup, and its p50 AND p90 turn wall time are below `on`. An error row drops its (fixture, repeat) for every arm.'),
  );
  if (missing.length > 0) console.log(noVerdict);

  if (args.dryRun) {
    let chars = 0;
    for (const f of fixtures) for (const a of args.arms) chars += ((await runTurn(env, f, a, args.model, 0, true, pre)) as { dry: number }).dry;
    const inTok = (chars / 4) * args.repeat * 1.6;
    console.log(`DRY RUN: ~${Math.round(inTok / 1000)}k input tokens planned, est. cost < $${((inTok * 0.04 + fixtures.length * args.arms.length * args.repeat * 1500 * 1.35) / 1e6).toFixed(2)}`);
    return 0;
  }

  const run = createRunWriter({ label: args.label });
  const out = join(run.dir, 'rows.jsonl');
  const rows: TurnRow[] = [];
  try {
    for (let r = 0; r < args.repeat; r++) {
      for (const f of fixtures) {
        const order = args.arms.map((_, i) => args.arms[(i + r) % args.arms.length]);
        for (const arm of order) {
          const row = (await runTurn(env, f, arm, args.model, r, false, pre)) as TurnRow;
          rows.push(row);
          appendFileSync(out, `${JSON.stringify(row)}\n`);
          console.log(`r${r} ${arm.id.padEnd(7)} ${f.id.padEnd(24)} ${row.pass ? 'PASS' : 'FAIL'} ${String(row.wallMs).padStart(6)}ms think=${row.reasoningTokens} ${row.why}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof SpendLimitError) console.error('STOPPED: staging spend limit (402). Partial rows kept; result INVALID.');
    else throw err;
  }

  const { valid, dropped } = countMatched(rows, args.arms.length);
  console.log(`\nrun dir: ${run.dir}\ndropped (fixture, repeat) cells (error rows): ${dropped.join(', ') || 'none'}`);
  const stats: Record<string, { pass: number; n: number; p50: number; p90: number; max: number; fv50: number; think: number }> = {};
  for (const a of args.arms) {
    const xs = valid.filter((x) => x.arm === a.id);
    const fv = xs.map((x) => x.firstVisibleMs).filter((v): v is number => v !== null);
    stats[a.id] = {
      pass: xs.filter((x) => x.pass).length, n: xs.length,
      p50: pct(xs.map((x) => x.wallMs), 50), p90: pct(xs.map((x) => x.wallMs), 90), max: Math.max(...xs.map((x) => x.wallMs)),
      fv50: pct(fv, 50), think: pct(xs.map((x) => x.reasoningTokens), 50),
    };
    const s = stats[a.id];
    console.log(`${a.id.padEnd(8)} pass ${s.pass}/${s.n}  turn p50 ${s.p50}ms p90 ${s.p90}ms max ${s.max}ms  first-visible p50 ${s.fv50}ms  reasoning-tokens p50 ${s.think}`);
    for (const kind of ['proposeTrack', 'proposeFactCheck', 'answer'] as const) {
      const k = xs.filter((x) => x.expect === kind);
      console.log(`         ${kind.padEnd(16)} ${k.filter((x) => x.pass).length}/${k.length}`);
    }
  }
  if (missing.length > 0) {
    console.log(`\n${noVerdict}`);
    run.writeJson('summary', { model: args.model, stats, verdict: null, droppedCells: dropped });
    return 0;
  }
  if (prePost) {
    const v = prePostVerdict(valid);
    console.log(`\nspread track ${v.spread.proposeTrack} factCheck ${v.spread.proposeFactCheck} answer ${v.spread.answer}; proposeTrack ${v.trackOk ? 'ok' : 'WORSE'}; proposeFactCheck/answer ${v.othersOk ? 'ok' : 'MOVED'}\nVERDICT: ${v.verdict}`);
    run.writeJson('summary', { model: args.model, stats, ...v, droppedCells: dropped });
    return v.verdict === 'PASS' ? 0 : 1;
  }
  const noise = Math.max(1, Math.abs(stats.on.pass - stats['on-twin'].pass));
  const leaks = valid.filter((x) => x.arm === 'off' && x.why === 'leaked markup in reply').length;
  const qualityOk = stats.off.pass >= stats.on.pass - noise && leaks === 0;
  const faster = stats.off.p50 < stats.on.p50 && stats.off.p90 < stats.on.p90;
  const verdict = qualityOk && faster && valid.length > 0 ? 'PASS' : 'FAIL';
  console.log(`\nnoise floor ${noise}; off leaks ${leaks}; quality ${qualityOk ? 'ok' : 'WORSE'}; latency ${faster ? 'faster' : 'NOT faster'}\nVERDICT: ${verdict}`);
  run.writeJson('summary', { model: args.model, stats, noise, leaks, qualityOk, faster, verdict, droppedCells: dropped });
  return verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1]?.endsWith('run-singleshot-corpus.ts')) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
}
