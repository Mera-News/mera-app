// harness-local — the three on-device chat flows (persona chat, article chat,
// follow-story) on both routes, judged the same way.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/run-chat-flows.ts \
//     --arms afm:kev,afm:single --split dev [--flow persona,article,follow] [--repeat 3] \
//     [--only id,id] [--label x] [--kev-url <base>]
//
// An arm is <engine>:<route>. engine = afm | nano-proxy | qwen-local (lib/engine.ts);
// route = kev (Kev decides, the built-in model writes: the flows' kev-spec.ts, the
// same RN-free code the app runs) or single (one built-in call: the flow's prompt,
// schema and turn mapper). Both routes get the SAME per-fixture input, rebuilt
// from the on-device agents' respond() bodies: the full conversation, matched
// topics, the facts behind them, already-following, and the waiting card through
// describePending and proposalRequiresUserChoice. As in tryKev, a Kev failure
// runs the single call and the row is flagged.
//
// Fixtures: harness-local/fixtures/splits/<flow>.json names the ids per split;
// persona ids are files in fixtures/persona-chat/, article and follow ids come
// from the frozen singleshot turns.json (read only) and fixtures/<flow>/turns.json.
// Scoring: lib/chat-flow-score.ts (fixed before tuning). Rows to rows.jsonl, the
// table to summary.md. Combine runs with scripts/chat-flow-report.ts.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afmCall, closeAfm } from '../adapters/afm-llm';
import { startKev, type KevBackend } from '../adapters/kev-local';
import {
  assertEngineReady,
  engineContextSize,
  isTransportError,
  onDeviceChatTurn,
  respondStructuredLocal,
  type LocalEngine,
} from '../lib/engine';
import { judgeTurn, summariseRows, summaryTable, type Expect, type Flow, type FlowRow } from '../lib/chat-flow-score';
import { createRunWriter } from '../lib/run-writer';
import { proposalRequiresUserChoice } from '../../lib/news-harness/core/proposals';
import type { StagedProposal } from '../../lib/news-harness/core/types';
import type { DecidePort, KevMessage, KevPorts, KevTurnResult } from '../../lib/news-harness/on-device/kev';
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
import { runPersonaKevTurn } from '../../lib/news-harness/on-device/persona-chat/kev-spec';
import {
  ARTICLE_FEEDBACK_SCHEMA,
  articleFeedbackInstructions,
  articleFeedbackTurn,
  buildArticleFeedbackPrompt,
  type ArticleChatContext,
  type ArticleFeedbackReply,
} from '../../lib/news-harness/on-device/article-feedback';
import { runArticleKevTurn } from '../../lib/news-harness/on-device/article-feedback/kev-spec';
import {
  buildFollowStoryPrompt,
  FOLLOW_STORY_SCHEMA,
  followStoryInstructions,
  followStoryTurn,
  type FollowStoryReply,
} from '../../lib/news-harness/on-device/follow-story';
import { runFollowKevTurn } from '../../lib/news-harness/on-device/follow-story/kev-spec';
import {
  describePending,
  ON_DEVICE_CHAT_MAX_TOKENS,
  promptBudgetTokens,
  type ChatTurn,
  type OnDeviceTurnResult,
} from '../../lib/news-harness/on-device/shared';

const FIXTURES = resolve(__dirname, '..', 'fixtures');
const APP = resolve(__dirname, '..', '..');
/** run-singleshot-corpus's fixed clock, so prompts are byte-stable. */
const TODAY = '2026-10-14';
const FOLLOW_OPENING: ChatTurn[] = [
  { role: 'user', content: 'I want to follow a story' },
  { role: 'assistant', content: 'What story or subject should Mera follow?' },
];
const FLOWS: Flow[] = ['persona', 'article', 'follow'];
const SPLIT_FILE: Record<Flow, string> = { persona: 'persona-chat', article: 'article-chat', follow: 'follow-story' };

// --- Fixtures ---------------------------------------------------------------

export interface Fixture {
  id: string;
  flow: Flow;
  clear: boolean;
  expect: Expect;
  messages: ChatTurn[];
  pending: StagedProposal | null;
  language: string;
  // persona
  surface?: PersonaSurface;
  facts?: PersonaChatContext['facts'];
  // article
  article?: ArticleChatContext;
  optionSource?: string;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function personaFacts(f: Raw): PersonaChatContext['facts'] {
  if (f.facts) return f.facts;
  // `- 'attribute': statement` lines, oldest first; the context wants newest first.
  return String(f.knownFacts ?? '')
    .split('\n')
    .flatMap((line, i) => {
      const m = /^- (?:'([^']*)': )?(.+)$/.exec(line.trim());
      return m ? [{ id: `k${i}`, statement: m[2], attribute: m[1] ?? null }] : [];
    })
    .reverse();
}

export function loadFixtures(flow: Flow, split: string): Fixture[] {
  const splits = JSON.parse(readFileSync(join(FIXTURES, 'splits', `${SPLIT_FILE[flow]}.json`), 'utf8')) as Record<string, string[]>;
  const ids = splits[split];
  if (!ids) throw new Error(`harness-local: no split ${split} for ${flow}`);
  if (flow === 'persona') {
    return ids.map((id) => {
      const f = JSON.parse(readFileSync(join(FIXTURES, 'persona-chat', `${id}.json`), 'utf8')) as Raw;
      const { calls, toolCalled, toolNotCalled, saveMentions, deleteIds, replaceIds, intent, ask, askMentions } = f.expect;
      return {
        id, flow, clear: f.clear !== false, pending: f.pending ?? null, language: f.language ?? 'English',
        expect: { calls, toolCalled, toolNotCalled, saveMentions, deleteIds, replaceIds, intent, ask, askMentions },
        messages: f.wire, surface: f.surface ?? 'CONFIG', facts: personaFacts(f),
      };
    });
  }
  const pool = new Map<string, Raw>();
  for (const file of [join(APP, 'lib/mera-harness/eval/fixtures/singleshot/turns.json'), join(FIXTURES, SPLIT_FILE[flow], 'turns.json')]) {
    for (const f of JSON.parse(readFileSync(file, 'utf8')) as Raw[]) pool.set(f.id, f);
  }
  return ids.map((id) => {
    const f = pool.get(id);
    if (!f) throw new Error(`harness-local: fixture ${id} not found for ${flow}`);
    const history: ChatTurn[] = f.history ?? (flow === 'follow' ? FOLLOW_OPENING : []);
    const pending: StagedProposal | null = f.pending ?? null;
    const a = f.article;
    return {
      id, flow, clear: f.clear !== false, pending, language: 'English',
      expect: { kind: f.expect, intent: f.intent, ask: f.ask, askMentions: f.askMentions, target: f.target },
      messages: [...history, { role: 'user', content: f.message }],
      optionSource: a ? `${a.title} ${a.description}` : f.message,
      article: a
        ? {
            today: TODAY, published: null, title: a.title, publication: a.publication, description: a.description,
            category: null, entities: [], relevance: 0.7, note: null,
            matchedTopics: f.matchedTopics ?? [], producingFacts: f.producingFacts ?? [], relatedCoverage: a.related ?? [],
            alreadyFollowing: f.alreadyFollowing ?? false, verdict: null, pending: describePending(pending),
          }
        : undefined,
    };
  });
}

// --- Ports --------------------------------------------------------------------

/** English UI copy: en.json with the unspliced kev fragments on top. Unknown keys throw. */
function loadT(): (key: string) => string {
  const en = JSON.parse(readFileSync(join(APP, 'lib/locales/en.json'), 'utf8')) as Raw;
  const frag = join(APP, 'lib/locales/_p6b-fragments.json');
  const extra = existsSync(frag) ? ((JSON.parse(readFileSync(frag, 'utf8')) as Raw).en ?? {}) : {};
  const get = (obj: Raw, key: string) => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Raw)[k] : undefined), obj);
  return (key) => {
    const v = get(extra, key) ?? get(en, key);
    if (typeof v !== 'string') throw new Error(`harness-local: no English string for ${key}`);
    return v;
  };
}

interface TurnLog {
  kev: { keys: string[]; answers: Record<string, unknown>; ms: number }[];
  writes: { ms: number; error: string | null }[];
  lastWritten: Record<string, unknown> | null;
}

function harnessPorts(engine: LocalEngine, kev: KevBackend, log: TurnLog, t: (k: string) => string): KevPorts {
  const decide: DecidePort = async (request) => {
    const start = Date.now();
    const result = await kev.decide(request);
    const answers = Object.fromEntries(
      Object.entries(result.answers as Raw).map(([k, a]) => [
        k,
        {
          choice: a.choice,
          confidence: Math.round((a.confidence ?? 0) * 1000) / 1000,
          probabilities: Object.fromEntries(Object.entries((a.probabilities ?? {}) as Record<string, number>).map(([o, p]) => [o, Math.round(p * 1000) / 1000])),
        },
      ]),
    );
    log.kev.push({ keys: Object.keys(request.questions), answers, ms: Date.now() - start });
    return result;
  };
  return {
    decide,
    write: async (system, prompt, schema) => {
      const start = Date.now();
      const out = await respondStructuredLocal<Raw>(engine, { system, prompt, schema, maxTokens: ON_DEVICE_CHAT_MAX_TOKENS, temperature: 0.3 });
      log.writes.push({ ms: Date.now() - start, error: out.error });
      if (out.value === undefined) throw new Error(out.error ?? 'no value');
      log.lastWritten = out.value;
      return out.value as never;
    },
    budget: async (system, schema) =>
      promptBudgetTokens({ contextSize: await engineContextSize(engine), maxTokens: ON_DEVICE_CHAT_MAX_TOKENS, system, schemaJson: JSON.stringify(schema) }),
    t,
  };
}

// --- One turn, per route --------------------------------------------------------

interface Single {
  turn: OnDeviceTurnResult | null;
  error: string | null;
  intent: string | null;
  rawOptionCount?: number;
}

async function runSingle(engine: LocalEngine, f: Fixture): Promise<Single> {
  const history = f.messages.filter((m) => m.content.trim().length > 0);
  const hasPending = f.pending != null;
  if (f.flow === 'persona') {
    const context: PersonaChatContext = { facts: f.facts!, topicPlanNotes: null, pending: describePending(f.pending) };
    const out = await onDeviceChatTurn<PersonaChatReply>(engine, personaChatInstructions(f.surface!, f.language), personaChatSchema(f.surface!), (b) =>
      buildPersonaChatPrompt(f.surface!, context, history, b),
    );
    return { turn: out.value ? personaChatTurn(out.value, { factIds: shownFactIds(context), hasPending }) : null, error: out.error, intent: null };
  }
  if (f.flow === 'article') {
    const c = f.article!;
    const out = await onDeviceChatTurn<ArticleFeedbackReply>(engine, articleFeedbackInstructions(f.language), ARTICLE_FEEDBACK_SCHEMA, (b) =>
      buildArticleFeedbackPrompt(c, history, b),
    );
    const turn = out.value
      ? articleFeedbackTurn(out.value, { matchedTopics: c.matchedTopics.slice(0, 6), publication: c.publication ?? null, hasPending })
      : null;
    return { turn, error: out.error, intent: out.value?.intent ?? null, rawOptionCount: Array.isArray(out.value?.options) ? out.value.options.length : undefined };
  }
  const out = await onDeviceChatTurn<FollowStoryReply>(engine, followStoryInstructions(f.language), FOLLOW_STORY_SCHEMA, (b) =>
    buildFollowStoryPrompt({ today: TODAY, pending: describePending(f.pending) }, history, b),
  );
  return {
    turn: out.value ? followStoryTurn(out.value) : null, error: out.error, intent: null,
    rawOptionCount: Array.isArray(out.value?.options) ? out.value.options.length : undefined,
  };
}

export function runKev(f: Fixture, ports: KevPorts): Promise<KevTurnResult> {
  const pending = f.pending ? { text: describePending(f.pending)!, tapOnly: proposalRequiresUserChoice(f.pending) } : null;
  const messages: KevMessage[] = f.messages;
  if (f.flow === 'persona') {
    return runPersonaKevTurn({ surface: f.surface!, facts: f.facts!, topicPlanNotes: null, pending, languageName: f.language }, messages, ports);
  }
  if (f.flow === 'article') {
    return runArticleKevTurn({ context: f.article!, pendingTapOnly: pending?.tapOnly ?? false, languageName: f.language }, messages, ports);
  }
  return runFollowKevTurn({ today: TODAY, pending, languageName: f.language }, messages, ports);
}

interface Arm {
  id: string;
  engine: LocalEngine;
  route: 'kev' | 'single';
}

async function runTurn(arm: Arm, f: Fixture, split: string, repeat: number, kev: KevBackend | null, t: (k: string) => string) {
  const log: TurnLog = { kev: [], writes: [], lastWritten: null };
  const started = Date.now();
  let result: OnDeviceTurnResult | null = null;
  let trace: KevTurnResult['trace'] | null = null;
  let intent: string | null = null;
  let error: string | null = null;
  let kevError: string | null = null;
  let rawOptionCount: number | undefined;
  if (arm.route === 'kev') {
    try {
      const k = await runKev(f, harnessPorts(arm.engine, kev!, log, t));
      result = k;
      trace = k.trace;
      intent = k.trace.intent;
      const opts = log.lastWritten?.options;
      rawOptionCount = Array.isArray(opts) ? opts.length : undefined;
    } catch (err) {
      kevError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!result) {
    const s = await runSingle(arm.engine, f);
    result = s.turn;
    error = s.error;
    intent = arm.route === 'single' ? s.intent : intent;
    rawOptionCount = s.rawOptionCount;
  }
  const transport =
    (kevError && /kev-decide|not running|ECONN|fetch failed/.test(kevError) ? kevError : null)
    ?? log.writes.map((w) => w.error).find((e) => e && isTransportError(e))
    ?? (error && isTransportError(error) ? error : null);
  const writerFailed = log.writes.length > 0 && log.writes.every((w) => w.error);
  const verdict = judgeTurn({
    flow: f.flow,
    expect: f.expect,
    today: TODAY,
    optionSource: f.expect.kind === 'proposeTrack' ? f.optionSource : undefined,
    outcome: {
      route: arm.route,
      calls: result?.calls ?? [],
      reply: result?.reply ?? '',
      intent: kevError ? null : intent,
      fallbackReply: arm.route === 'kev' && !kevError && writerFailed,
      tapOnly: f.pending ? proposalRequiresUserChoice(f.pending) : false,
      known: f.flow === 'persona' ? f.facts!.map((x) => x.statement) : undefined,
      rawOptionCount,
    },
  });
  const visibleError = !transport && !result ? error ?? 'no result' : null;
  const row: FlowRow & Record<string, unknown> = {
    ...verdict,
    pass: verdict.pass && !visibleError,
    why: visibleError ? `error: ${visibleError}` : verdict.why,
    flow: f.flow, fixture: f.id, split, arm: arm.id, route: arm.route, repeat, clear: f.clear,
    dropped: transport, visibleError, fallbackReply: arm.route === 'kev' && !kevError && writerFailed,
    kevFallback: kevError != null, kevError,
    wallMs: Date.now() - started, decideMs: trace?.decideMs ?? 0, writeMs: trace?.writeMs ?? 0,
    source: trace?.source ?? arm.route,
    calls: (result?.calls ?? []).map((c) => ({ name: c.name, input: c.input })),
    reply: result?.reply ?? '',
    kev: log.kev,
    writes: log.writes,
    at: new Date().toISOString(),
  };
  return row;
}

// --- AFM outages -----------------------------------------------------------------------

function afmErrored(row: Record<string, unknown>): boolean {
  const errors = [String(row.visibleError ?? ''), ...((row.writes as { error: string | null }[]) ?? []).map((w) => String(w.error ?? ''))];
  return errors.some((e) => e.startsWith('ERR_AFM_'));
}

async function afmHealthy(): Promise<boolean> {
  const r = await afmCall({ instructions: 'You are a helpful assistant.', prompt: 'Say hello in five words.', maxTokens: 30 });
  return !r.error;
}

async function waitForAfm(maxMs = 20 * 60_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 30_000));
    if (await afmHealthy()) return;
  }
  throw new Error('harness-local: the Mac model did not recover in 20 minutes; the run is incomplete.');
}

// --- Main ---------------------------------------------------------------------------

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const split = arg(argv, '--split') ?? 'dev';
  const repeat = Number(arg(argv, '--repeat') ?? 1);
  const flows = (arg(argv, '--flow') ?? FLOWS.join(',')).split(',') as Flow[];
  const only = arg(argv, '--only')?.split(',');
  const arms: Arm[] = (arg(argv, '--arms') ?? 'afm:kev,afm:single').split(',').map((id) => {
    const [engine, route] = id.split(':');
    if (!['afm', 'nano-proxy', 'qwen-local'].includes(engine) || !['kev', 'single'].includes(route)) {
      throw new Error(`harness-local: arm ${id} must be <afm|nano-proxy|qwen-local>:<kev|single>`);
    }
    return { id, engine: engine as LocalEngine, route: route as Arm['route'] };
  });
  for (const f of flows) if (!FLOWS.includes(f)) throw new Error(`harness-local: unknown flow ${f}`);
  for (const e of new Set(arms.map((a) => a.engine))) await assertEngineReady(e);
  const fixtures = flows.flatMap((f) => loadFixtures(f, split)).filter((f) => !only || only.includes(f.id));
  const kev = arms.some((a) => a.route === 'kev') ? await startKev(argv) : null;
  const t = loadT();

  const run = createRunWriter({ label: arg(argv, '--label') ?? `chat-flows-${split}-${arms.map((a) => a.id.replace(':', '-')).join('+')}` });
  const rowsPath = join(run.dir, 'rows.jsonl');
  console.log(`split ${split}, flows ${flows.join(',')}, ${fixtures.length} fixtures x arms ${arms.map((a) => a.id).join(',')} x repeat ${repeat}${kev ? `, Kev ${kev.label}` : ''}\nrun dir: ${run.dir}`);
  const rows: FlowRow[] = [];
  try {
    for (let r = 0; r < repeat; r++) {
      for (const f of fixtures) {
        for (const arm of r % 2 ? [...arms].reverse() : arms) {
          let row = await runTurn(arm, f, split, r, kev, t);
          // The Mac's model sometimes fails every request for minutes (SensitiveContentAnalysisML
          // error 15, even on "say hello"). A turn that met an AFM error while a benign prompt
          // also fails is an outage, not the turn's outcome: wait it out and run the turn again.
          for (let tries = 0; arm.engine === 'afm' && tries < 3 && afmErrored(row) && !(await afmHealthy()); tries++) {
            console.log(`AFM outage on ${f.id}; waiting for it to answer a benign prompt`);
            await waitForAfm();
            row = await runTurn(arm, f, split, r, kev, t);
          }
          rows.push(row);
          appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
          const intent = row.intentOk === null ? '' : row.intentOk ? ' intent ok' : ` intent ${row.routeIntent}`;
          console.log(`r${r} ${arm.id.padEnd(17)} ${f.id.padEnd(28)} ${row.dropped ? 'DROP' : row.pass ? 'PASS' : 'FAIL'} ${String(row.wallMs).padStart(6)}ms ${row.why}${intent}${row.asked ? ` asked[${row.askOptions.join(' / ')}]` : ''}`);
        }
      }
    }
  } finally {
    kev?.stop();
    closeAfm();
  }
  const table = summaryTable(summariseRows(rows));
  writeFileSync(join(run.dir, 'summary.md'), `${table}\n`);
  run.writeJson('summary', { split, flows, arms, repeat, kev: kev?.label ?? null, summaries: summariseRows(rows) });
  console.log(`\n${table}`);
  return 0;
}

if (/run-chat-flows\.ts$/.test(process.argv[1] ?? '')) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(2);
  });
}
