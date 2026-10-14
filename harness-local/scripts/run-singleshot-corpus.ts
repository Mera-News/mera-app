// harness-local — the single-shot agent runner (follow a story, article chat).
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/run-singleshot-corpus.ts --target staging \
//       --graphql-endpoint ... --auth-endpoint ... [--repeat 3] [--dry-run]
//
// WHAT IT MEASURES. One turn of FollowStoryAgent or ArticleFeedbackAgent the way
// useCloudPersonaChat's single-shot path runs it: the agent's real system prompt,
// context prepended to the last user message, the app's text tool wire (xml),
// streamed, BIG_MODEL, a first pass and ONE continuation when a knowledge tool
// ran or no text came back. Tool results are canned per fixture, like the agent
// corpus's fakes, so the arms differ only in the thinking gear.
//
// ARMS: `on` (shipped: thinking on, budget + reasoning headroom), `on-twin`
// (byte-identical, the noise floor) and `off` (thinking off, no headroom).
// The pass rule is printed before any call and judged on the turn's outcome.
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

interface Fixture {
  id: string;
  agent: 'follow-story' | 'article';
  message: string;
  expect: 'proposeTrack' | 'proposeFactCheck' | 'answer';
  search: string[];
  article?: { title: string; publication: string; description: string; related: string[] };
}

interface Arm { id: string; thinking: boolean }
const ARMS: Arm[] = [
  { id: 'on', thinking: true },
  { id: 'on-twin', thinking: true },
  { id: 'off', thinking: false },
];

type Msg = { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string };

const FIXTURES = join(__dirname, '../../lib/mera-harness/eval/fixtures/singleshot/turns.json');
// Fixed so prompts are byte-stable across arms and runs.
const NOW_MS = Date.parse('2026-10-14T12:00:00Z');

function parseArgs(argv: string[]): { repeat: number; dryRun: boolean; label: string } {
  let repeat = 3;
  let dryRun = false;
  let label = 'singleshot';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeat') repeat = Number(argv[++i]);
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--label') label = argv[++i] ?? label;
  }
  return { repeat, dryRun, label };
}

function setup(f: Fixture): { system: string; tools: unknown[]; history: Msg[]; context: string } {
  if (f.agent === 'follow-story') {
    return {
      system: buildFollowStorySystemPrompt({ needsToolFormat: false, languageName: 'English', canSearch: true, webSearch: true }),
      tools: getFollowStoryToolDefinitions('CLOUD', true),
      history: [
        { role: 'user', content: 'I want to follow a story' },
        { role: 'assistant', content: 'What story or subject should Mera follow?' },
      ],
      context: buildFollowStoryContext({ nowMs: NOW_MS, proposal: null }),
    };
  }
  const a = f.article!;
  return {
    system: buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English', webSearch: true, factCheck: true }),
    tools: getArticleFeedbackToolDefinitions('CLOUD', true),
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
  calls: string[]; trackOptions: number; reply: string;
}

async function runTurn(
  env: { nearAiBaseUrl: string; nearAiApiKey: string },
  f: Fixture, arm: Arm, repeat: number, dryRun: boolean,
): Promise<TurnRow | { dry: number }> {
  const { system, tools, history, context } = setup(f);
  const wire: Msg[] = [...history, { role: 'user', content: f.message }];
  const bodyFor = (): Record<string, unknown> => {
    const last = wire.map((m) => m.role).lastIndexOf('user');
    const msgs = wire.map((m, i) => (i === last ? { ...m, content: `${context}\n\n${m.content}` } : m));
    return {
      model: BIG_MODEL,
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
        try { row.trackOptions = Math.max(row.trackOptions, parseTrackScopeOptions(JSON.parse(c.argumentsRaw || '{}').options).length); } catch { /* 0 */ }
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
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);
  const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixture[];

  // eslint-disable-next-line no-console
  console.log(
    `fixtures ${fixtures.length} x arms ${ARMS.map((a) => a.id).join(',')} x repeat ${args.repeat}, model ${BIG_MODEL}, format ${APP_TOOL_FORMAT}\n` +
      'PASS RULE (fixed before the run): `off` passes if its turn pass count is >= `on` minus max(1, |on - on-twin|),\n' +
      'it leaks no markup, and its p50 AND p90 turn wall time are below `on`. Error rows invalidate their repeat for every arm.',
  );

  if (args.dryRun) {
    let chars = 0;
    for (const f of fixtures) for (const a of ARMS) chars += ((await runTurn(env, f, a, 0, true)) as { dry: number }).dry;
    const inTok = (chars / 4) * args.repeat * 1.6;
    console.log(`DRY RUN: ~${Math.round(inTok / 1000)}k input tokens planned, est. cost < $${((inTok * 0.04 + fixtures.length * ARMS.length * args.repeat * 1500 * 1.35) / 1e6).toFixed(2)}`);
    return 0;
  }

  const run = createRunWriter({ label: args.label });
  const out = join(run.dir, 'rows.jsonl');
  const rows: TurnRow[] = [];
  try {
    for (let r = 0; r < args.repeat; r++) {
      for (const f of fixtures) {
        const order = ARMS.map((_, i) => ARMS[(i + r) % ARMS.length]);
        for (const arm of order) {
          const row = (await runTurn(env, f, arm, r, false)) as TurnRow;
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

  const badRepeats = new Set(rows.filter((x) => x.error).map((x) => x.repeat));
  const valid = rows.filter((x) => !badRepeats.has(x.repeat));
  console.log(`\nrun dir: ${run.dir}\ndropped repeats (error rows): ${[...badRepeats].join(',') || 'none'}`);
  const stats: Record<string, { pass: number; n: number; p50: number; p90: number; max: number; fv50: number; think: number }> = {};
  for (const a of ARMS) {
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
  const noise = Math.max(1, Math.abs(stats.on.pass - stats['on-twin'].pass));
  const leaks = valid.filter((x) => x.arm === 'off' && x.why === 'leaked markup in reply').length;
  const qualityOk = stats.off.pass >= stats.on.pass - noise && leaks === 0;
  const faster = stats.off.p50 < stats.on.p50 && stats.off.p90 < stats.on.p90;
  const verdict = qualityOk && faster && valid.length > 0 ? 'PASS' : 'FAIL';
  console.log(`\nnoise floor ${noise}; off leaks ${leaks}; quality ${qualityOk ? 'ok' : 'WORSE'}; latency ${faster ? 'faster' : 'NOT faster'}\nVERDICT: ${verdict}`);
  run.writeJson('summary', { stats, noise, leaks, qualityOk, faster, verdict, droppedRepeats: [...badRepeats] });
  return verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1]?.endsWith('run-singleshot-corpus.ts')) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
}
