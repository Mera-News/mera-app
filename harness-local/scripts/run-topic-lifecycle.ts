// harness-local — the topic lifecycle eval: empty facts and the "Generate more" tap loop.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/run-topic-lifecycle.ts \
//     --target staging --repeat 3 [--dry-run]
//
// Arms, interleaved per fact, null first, so one run holds all of them (two runs
// would put the noise floor between the arms):
//   null-control       promptArm 'null-control' with the skills as of commit 3e62c609
//   long-judgement     shipped skills, last attempt on topics/generic with a nudge
//   catch-all-generic  long-judgement, but `topics: general interests` loads topics/generic
//   short              shipped: the last attempt is JUDGEMENT_SYSTEM alone
//   short-catch-all    short, with the same routing
// Negatives run --negative-repeat times, so a single fact cannot decide that bar. The tap
// pass runs only the arms it can tell apart: append skips the ladder.
// Pass 1 (empty): one generation per fact, records attempts, topics, malformed.
// Pass 2 (tap): a first run, then 5 "Generate more" taps (append, ceiling 10) carrying
// the fact's own topics forward. Per tap: added, near-duplicates against own, leaks.
// Model calls only go through the injected caller; --dry-run injects a fake one.
// Node-only: never imported by the app bundle.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DETECT_JACCARD,
  contentJaccard,
  generateTopicsForFact,
  isSubsetTopic,
  namesFact,
  normalizeTopicText,
  topicSkillForAttribute,
} from '@/lib/mera-harness';
import type { AgentModelResult } from '../../lib/mera-harness/core/types';
import { loadHarnessEnv } from '../config/env';
import { applyEndpointOverrides, applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';
import { createRunWriter } from '../lib/run-writer';
import { costOf, fetchModelCatalog, TOPICGEN_ARM_MODELS } from '../lib/model-catalog';
import { postCompletion, SpendLimitError } from '../lib/near-call';

export const NULL_CONTROL_COMMIT = '3e62c609';
export const SPEND_STOP_USD = 1;
export const TAPS = 5;
export const TAP_CEILING = 10;
export const CATCH_ALL_ATTRIBUTE = 'topics: general interests';
const FIXTURES = resolve(__dirname, '..', 'fixtures', 'persona-corpus', 'personas');

export type ArmName = 'null-control' | 'long-judgement' | 'catch-all-generic' | 'short' | 'short-catch-all';
export const ARM_ORDER: ArmName[] = ['null-control', 'long-judgement', 'catch-all-generic', 'short', 'short-catch-all'];
export const TAP_ARMS: ArmName[] = ['null-control', 'short', 'short-catch-all'];
const isCatchAllArm = (arm: ArmName) => arm === 'catch-all-generic' || arm === 'short-catch-all';

export interface LifecycleFact {
  id: string;
  statement: string;
  questionnaireAttribute: string;
}

export interface Args {
  dryRun: boolean;
  repeat: number;
  negativeRepeat: number;
  label: string;
  runsRoot: string | null;
}

/** `--target staging` is required here too, on top of the guard in main(): a flag the
 *  command line must carry is a flag a pasted command cannot lose. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, repeat: 3, negativeRepeat: 6, label: 'topic-lifecycle', runsRoot: null };
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') target = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--negative-repeat') args.negativeRepeat = Number(argv[++i]);
    else if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--runs-root') args.runsRoot = argv[++i] ?? null;
  }
  if (target !== 'staging') {
    throw new Error(`run-topic-lifecycle: --target staging is required (got ${JSON.stringify(target ?? '')}). Refusing.`);
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error('run-topic-lifecycle: --repeat needs an integer >= 1.');
  return args;
}

export function attributeSkill(arm: ArmName, fact: LifecycleFact): string {
  if (isCatchAllArm(arm) && fact.questionnaireAttribute === CATCH_ALL_ATTRIBUTE) return 'topics/generic';
  return topicSkillForAttribute(fact.questionnaireAttribute);
}

/** The skill composer of core/skill-loader.ts over an arbitrary skill table, because the
 *  shipped loadSkill is bound to the shipped table. A leaf is its group's generic + body. */
export function composeSkillFrom(skills: Record<string, string>): (id: string) => string | null {
  return (id) => {
    if (!(id in skills)) return null;
    const body = skills[id] ?? '';
    if (id.endsWith('/generic')) return body;
    const preamble = skills[`${id.split('/')[0]}/generic`] ?? '';
    return preamble ? `${preamble.trimEnd()}\n\n${body.trimStart()}` : body;
  };
}

/** The skill table at NULL_CONTROL_COMMIT, via git show into a scratch file (the file has no imports). */
export async function loadNullControlSkills(): Promise<Record<string, string>> {
  const src = execFileSync('git', ['show', `${NULL_CONTROL_COMMIT}:lib/mera-harness/skills/index.generated.ts`], {
    cwd: resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const file = join(tmpdir(), `null-control-skills-${process.pid}.ts`);
  writeFileSync(file, src, 'utf8');
  const mod = (await import(pathToFileURL(file).href)) as { PERSONA_SKILLS: Record<string, string> };
  return mod.PERSONA_SKILLS;
}

/** A topic that restates one the fact already has: DETECT_JACCARD, or a subset either way. */
export function isNearDuplicate(topic: string, own: string[]): boolean {
  return own.some(
    (o) =>
      normalizeTopicText(o) === normalizeTopicText(topic) ||
      contentJaccard(topic, o) >= DETECT_JACCARD ||
      isSubsetTopic(topic, o) ||
      isSubsetTopic(o, topic),
  );
}

/** Topics that name another fact and not their own. */
export function leaksOf(topics: string[], own: LifecycleFact, all: LifecycleFact[]): string[] {
  const others = all.filter((f) => f.id !== own.id);
  return topics.filter(
    (t) => !namesFact(t, own.statement) && others.some((o) => namesFact(t, o.statement)),
  );
}

export type Caller = (req: {
  systemPrompt: string;
  messages: { role: 'user'; content: string }[];
  model: string;
  temperature: number;
  maxTokens: number;
}) => Promise<AgentModelResult>;

export interface LifecycleRow {
  pass: 'empty' | 'tap';
  arm: ArmName;
  repeat: number;
  factId: string;
  statement: string;
  skillId: string;
  tap: number;
  attempts: number;
  topics: string[];
  malformed: boolean;
  added: number;
  dupOwn: number;
  leaks: string[];
  error: string | null;
}

export interface LifecycleDeps {
  call: Caller;
  nullSkills: Record<string, string>;
  model: string;
  write: (row: LifecycleRow) => void;
}

async function generate(
  deps: LifecycleDeps,
  arm: ArmName,
  fact: LifecycleFact,
  extra: { existingTopics?: string[]; append?: boolean; ceiling?: number },
) {
  let attempts = 0;
  const skillId = attributeSkill(arm, fact);
  const out = await generateTopicsForFact({
    fact: { statement: fact.statement, questionnaireAttribute: fact.questionnaireAttribute },
    skillId,
    model: deps.model,
    promptArm: arm === 'null-control' ? 'null-control' : arm === 'long-judgement' || arm === 'catch-all-generic' ? 'long-judgement' : undefined,
    ...extra,
    deps: {
      callModel: (req) => {
        attempts += 1;
        return deps.call(req);
      },
      loadSkill: arm === 'null-control' ? composeSkillFrom(deps.nullSkills) : undefined,
    },
  });
  return { out, attempts, skillId };
}

/** Both passes. Per fact, per repeat, arms interleaved null first. */
export async function runLifecycle(
  deps: LifecycleDeps,
  emptyFacts: LifecycleFact[],
  tapFacts: LifecycleFact[],
  repeat: number,
  negativeRepeat = repeat,
): Promise<void> {
  for (const fact of emptyFacts) {
    for (let rep = 1; rep <= (fact.id.startsWith('n') ? negativeRepeat : repeat); rep++) {
      for (const arm of ARM_ORDER) {
        const { out, attempts, skillId } = await generate(deps, arm, fact, {});
        deps.write({
          pass: 'empty', arm, repeat: rep, factId: fact.id, statement: fact.statement, skillId, tap: 0,
          attempts, topics: out.topics, malformed: out.malformed, added: out.topics.length, dupOwn: 0, leaks: [],
          error: out.result.error,
        });
      }
    }
  }
  for (const fact of tapFacts) {
    for (let rep = 1; rep <= repeat; rep++) {
      for (const arm of TAP_ARMS) {
        let own: string[] = [];
        for (let tap = 0; tap <= TAPS; tap++) {
          const { out, attempts, skillId } = await generate(
            deps, arm, fact,
            tap === 0 ? {} : { existingTopics: own, append: true, ceiling: TAP_CEILING },
          );
          deps.write({
            pass: 'tap', arm, repeat: rep, factId: fact.id, statement: fact.statement, skillId, tap,
            attempts, topics: out.topics, malformed: out.malformed, added: out.topics.length,
            dupOwn: out.topics.filter((t) => isNearDuplicate(t, own)).length,
            leaks: leaksOf(out.topics, fact, tapFacts), error: out.result.error,
          });
          const seen = new Set(own.map(normalizeTopicText));
          own = [...own, ...out.topics.filter((t) => !seen.has(normalizeTopicText(t)))];
        }
      }
    }
  }
}

/** Rater view: cleaned topics by fact, arms behind neutral labels. The label order differs
 *  per fact (rotated by fact index) so a label never means one arm throughout. */
export function buildRaterView(rows: LifecycleRow[]): { view: string; key: Record<string, Record<string, ArmName>> } {
  const key: Record<string, Record<string, ArmName>> = {};
  const lines: string[] = [];
  const factIds = [...new Set(rows.map((r) => `${r.pass}:${r.factId}`))];
  factIds.forEach((fk, i) => {
    const mine = rows.filter((r) => `${r.pass}:${r.factId}` === fk);
    const arms = ARM_ORDER.filter((arm) => mine.some((m) => m.arm === arm));
    const rotated = [...arms.slice(i % arms.length), ...arms.slice(0, i % arms.length)];
    key[fk] = {};
    lines.push(`## ${fk.split(':')[0]} pass: ${mine[0].statement}`);
    rotated.forEach((arm, j) => {
      const label = 'ABCDE'[j];
      key[fk][label] = arm;
      lines.push(`### ${label}`);
      for (const r of mine.filter((m) => m.arm === arm)) {
        const topics = [...new Map(r.topics.map((t) => [normalizeTopicText(t), t.trim()])).values()];
        lines.push(`- run ${r.repeat}${r.pass === 'tap' ? ` tap ${r.tap}` : ''}: ${topics.join('; ') || '(none)'}`);
      }
    });
    lines.push('');
  });
  return { view: lines.join('\n'), key };
}

/** Deterministic fake: four topics naming the fact, no network. */
export function dryCaller(): Caller {
  let n = 0;
  return async (req) => {
    n += 1;
    const words = (req.messages[0].content.match(/Fact: "([^"]*)"/)?.[1] ?? 'fact').split(/\s+/).slice(0, 2).join(' ');
    return {
      content: JSON.stringify([1, 2, 3, 4].map((k) => `${words} angle ${n}-${k}`)),
      toolCalls: [], finishReason: 'stop', truncated: false,
      usage: { promptTokens: 700, completionTokens: 60, cachedTokens: 0, reasoningTokens: 0 },
      modelSent: 'dry-run', latencyMs: 1, error: null,
    };
  };
}

function loadFacts(): { empty: LifecycleFact[]; tap: LifecycleFact[] } {
  const life = JSON.parse(readFileSync(join(FIXTURES, 'sentryfix-lifecycle.json'), 'utf8')) as {
    facts: LifecycleFact[];
    tapIds: string[];
  };
  const owner = JSON.parse(readFileSync(join(FIXTURES, 'owner-nieuw-west.json'), 'utf8')) as { facts: LifecycleFact[] };
  const slim = (f: LifecycleFact): LifecycleFact => ({
    id: f.id, statement: f.statement, questionnaireAttribute: f.questionnaireAttribute,
  });
  return {
    empty: life.facts.map(slim),
    tap: [...life.facts.filter((f) => life.tapIds.includes(f.id)), ...owner.facts].map(slim),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  const overridden = applyEndpointOverrides(argv);
  const args = parseArgs(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);
  console.log(`target   : ${env.target} (${env.graphqlEndpoint})${overridden.length ? `\noverride : ${overridden.join(', ')}` : ''}`);
  if (env.target !== 'staging') throw new Error('refusing: target is not staging');

  const model = TOPICGEN_ARM_MODELS[0];
  const { empty, tap } = loadFacts();
  const negatives = empty.filter((f) => f.id.startsWith('n')).length;
  const calls = (empty.length - negatives) * ARM_ORDER.length * args.repeat
    + negatives * ARM_ORDER.length * args.negativeRepeat
    + tap.length * TAP_ARMS.length * (1 + TAPS) * args.repeat;
  console.log(`mode     : ${args.dryRun ? 'DRY RUN, zero model calls' : 'live'}\nmodel    : ${model}\nrepeat   : ${args.repeat}\nplanned  : ~${calls} generations (retries add calls), stop at $${SPEND_STOP_USD}`);

  const info = args.dryRun
    ? null
    : (await fetchModelCatalog({ baseUrl: env.nearAiBaseUrl, apiKey: env.nearAiApiKey }))[model];
  if (!args.dryRun && !info) throw new Error(`model ${model} is not in the catalogue, cannot price the run`);

  let spent = 0;
  let modelCalls = 0;
  const live: Caller = async (req) => {
    if (spent >= SPEND_STOP_USD) throw new SpendLimitError(`local $${SPEND_STOP_USD} stop reached`, spent.toFixed(4), String(SPEND_STOP_USD), '');
    const r = await postCompletion({
      baseUrl: env.nearAiBaseUrl,
      apiKey: env.nearAiApiKey,
      model: req.model,
      messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      enableThinking: false,
    });
    if (r.usage && info) spent += costOf(info, r.usage);
    return { ...r, toolCalls: r.toolCalls.map((t) => ({ name: t.name, argumentsRaw: t.argumentsRaw })) };
  };
  const inner = args.dryRun ? dryCaller() : live;
  const call: Caller = (req) => {
    modelCalls += 1;
    return inner(req);
  };

  const run = createRunWriter({ label: args.label, runsRoot: args.runsRoot ? resolve(args.runsRoot) : undefined });
  const rowsPath = join(run.dir, 'rows.jsonl');
  writeFileSync(rowsPath, '', 'utf8');
  const rows: LifecycleRow[] = [];
  let stopped: string | null = null;
  try {
    await runLifecycle(
      { call, model, nullSkills: await loadNullControlSkills(), write: (r) => { rows.push(r); appendFileSync(rowsPath, `${JSON.stringify(r)}\n`); } },
      empty, tap, args.repeat, args.negativeRepeat,
    );
  } catch (err) {
    if (!(err instanceof SpendLimitError)) throw err;
    stopped = err.message;
  }
  const { view, key } = buildRaterView(rows);
  writeFileSync(join(run.dir, 'rater-view.md'), `${view}\n`, 'utf8');
  run.writeJson('rater-key', key);
  console.log(`rows     : ${rows.length}\n${args.dryRun ? 'fake calls (no network)' : 'model calls'}: ${modelCalls}\nspend    : $${spent.toFixed(4)}${stopped ? `\nSTOPPED  : ${stopped}` : ''}`);
  run.finish({ target: env.target, dryRun: args.dryRun, rows: rowsPath, spent, modelCalls, stopped });
  return stopped ? 3 : 0;
}

// Guarded: harness-local specs import this module under node's test runner.
if (/run-topic-lifecycle\.ts$/.test(process.argv[1] ?? '')) main().then(
  (code) => process.exit(code),
  (err) => { console.error(err); process.exit(1); },
);
