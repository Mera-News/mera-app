// harness-local — self-test for the runner libraries.
//
// There is no jest in harness-local (the whole directory is excluded from the
// app's jest run and tsconfig), and `tsc -p harness-local/tsconfig.json` pulls
// in the app tree, where ~1,700 errors pre-exist. So this script IS the gate
// for lib/: run it, check the exit code.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/selftest.ts
//
// EVERY assertion here carries its own control. A check that only ever sees
// the healthy case cannot fail, and a suite of those is worse than no suite:
// it reports green while measuring nothing. So each detector is shown firing
// on planted damage as well as staying quiet on clean input.
//
// Node-only: never imported by the app bundle.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadHarnessEnv } from '../config/env';
import { authCachePath } from '../config/local-data';
import {
  requireStagingTarget, assertStagingEndpoint, parseTargetFlag, applyTargetOverride,
  applyEndpointOverrides, isStagingHost, isProdMeraHost, STAGING_DEFAULTS,
} from '../lib/staging-guard';
import {
  createJsonlWriter, extractFenceNonce, hashMessages, newRowId, type RunRow,
} from '../lib/jsonl-writer';
import { computeAgreement, formatAgreementReport, readJsonl } from '../lib/agreement';
import { hasReasoningLeak, parseSpendLimit, SpendLimitError } from '../lib/near-call';
import { estimateRunCost, formatCostEstimate } from '../lib/cost-estimate';
import { costOf, rosterWarnings, type ModelCatalog } from '../lib/model-catalog';
import { buildChatTurnBody, withContextOnLastUserTurn } from '../lib/chat-turn';
import { filterNewFacts, normalizeStatement } from '../../lib/news-harness/persona-management/fact-rules';
import { CHAT_MAX_OUTPUT_TOKENS, CHAT_REASONING_HEADROOM_TOKENS } from '../../lib/llm/constants';
import {
  COHORTS, applyToolCalls, freshState, loadCohort, measureFactsInPrompt,
  measureTurnsInPrompt, renderKnownFacts, PROMPT_CAPS,
} from '../lib/corpus';

let f = 0;
function ck(n: string, ok: boolean, d = ''): void {
  if (!ok) f++;
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`);
}
function throws(n: string, fn: () => unknown, mustInclude: string): void {
  try { fn(); ck(n, false, 'did NOT throw'); }
  catch (e) { ck(n, String((e as Error).message).includes(mustInclude), String((e as Error).message).slice(0, 110)); }
}

const MSGS = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];

function row(over: Partial<RunRow>): RunRow {
  return {
    rowId: newRowId(), dupOf: null, runId: 'r1', repeat: 0, cohort: 'good', turnIndex: 0,
    arm: 'control', callType: 'chat-extraction', interleaveGroup: 'g0',
    lane: 'near', surface: 'CONFIG', variant: 'baseline',
    promptHash: hashMessages(MSGS), promptDeterministic: true, fenceNonce: 'N1',
    modelRequested: 'Qwen/Qwen3.6-35B-A3B-FP8', modelSent: 'Qwen/Qwen3.6-35B-A3B-FP8',
    fallbackFrom: null, hedged: false,
    input: { systemPrompt: 'S', messages: MSGS, toolSchemaNames: ['saveFact'] },
    personaStateIn: { factCount: 3, topicCount: 5, factsInPrompt: 3, turnsInPrompt: 1 },
    rawOutput: 'out', toolCalls: [], parsedSchema: null, items: null,
    requestedCount: null, returnedCount: null, personaStateDelta: null,
    finishReason: 'stop', truncated: false, reasoningLeak: false,
    usage: { promptTokens: 1000, completionTokens: 500, cachedTokens: 0, reasoningTokens: 0 },
    cost: null, latencyMs: 100, ttVisibleMs: null, error: null, ...over,
  };
}
const tool = (name: string, parsed: Record<string, unknown>) =>
  [{ name, argumentsRaw: JSON.stringify(parsed), parsed, schemaValid: true }];

async function main(): Promise<number> {
  console.log('== staging rail ==');
  const STAGING = { target: 'staging' as const, graphqlEndpoint: STAGING_DEFAULTS.graphqlEndpoint, authEndpoint: STAGING_DEFAULTS.authEndpoint, inferenceEndpoint: STAGING_DEFAULTS.inferenceEndpoint };

  // 1. positive control: the staging trio is accepted
  try { requireStagingTarget(STAGING); ck('staging trio accepted', true); }
  catch (e) { ck('staging trio accepted', false, String(e)); }

  // 2. the exact prod values currently in .env.harness are refused, by name
  throws('prod graphql refused as PROD', () => requireStagingTarget({ ...STAGING, graphqlEndpoint: 'https://graphql.mera.news/graphql' }), 'is the PROD host');
  throws('prod auth refused as PROD', () => requireStagingTarget({ ...STAGING, authEndpoint: 'https://auth.mera.news' }), 'is the PROD host');
  throws('prod inference refused as PROD', () => requireStagingTarget({ ...STAGING, inferenceEndpoint: 'https://inference.mera.news' }), 'is the PROD host');

  // 3. target itself must be staging
  throws('target=prod refused', () => requireStagingTarget({ ...STAGING, target: 'prod' as const }), 'staging-only');
  throws('target=local refused', () => requireStagingTarget({ ...STAGING, target: 'local' as const }), 'staging-only');

  // 4. suffix matching is DNS-suffix, not substring
  throws('lookalike host refused', () => assertStagingEndpoint('X', 'https://staging.mera.news.evil.test/graphql'), 'not a *');
  throws('substring-in-path refused', () => assertStagingEndpoint('X', 'https://graphql.mera.news/staging'), 'is the PROD host');
  ck('isStagingHost true for staging', isStagingHost('https://graphql.staging.mera.news/graphql'));
  ck('isProdMeraHost false for staging', !isProdMeraHost('https://graphql.staging.mera.news/graphql'));

  // 5. --target override + parse
  const argv = ['--cohorts', 'good', '--target', 'staging', '--repeat', '3'];
  ck('parseTargetFlag reads staging', parseTargetFlag(argv) === 'staging');
  delete process.env.NEWS_HARNESS_TARGET;
  applyTargetOverride(argv);
  ck('applyTargetOverride sets process.env', process.env.NEWS_HARNESS_TARGET === 'staging', String(process.env.NEWS_HARNESS_TARGET));
  throws('bad --target value throws', () => parseTargetFlag(['--target', 'production']), "must be one of");
  ck('no --target leaves undefined', parseTargetFlag(['--repeat', '3']) === undefined);

  // 6. auth cache is namespaced and the three targets never collide
  const paths = (['local', 'staging', 'prod'] as const).map((t) => authCachePath(t));
  ck('cache paths distinct', new Set(paths).size === 3, paths.join(' | '));
  ck('staging cache path named', paths[1].endsWith('.auth-cache.staging.json'), paths[1]);
  ck('no path is the legacy name', paths.every((p) => !p.endsWith('/.auth-cache.json')));


  console.log('\n== env loading ==');
  // The guard section above set NEWS_HARNESS_TARGET. Clear it so dotenv can
  // fill the value from .env.harness, which is what the 7 pre-existing scripts
  // see. That ordering hazard is real, not test-only: applyTargetOverride wins
  // over the file precisely because dotenv never overwrites a set variable.
  delete process.env.NEWS_HARNESS_TARGET;

  // A. the no-arg call the pre-existing scripts use still works and still
  //    reports whatever the env file says. Asserting the INVARIANT rather than
  //    a literal 'prod' keeps this green when the user edits that file, which
  //    they do, in parallel, while this runs.
  const legacy = loadHarnessEnv();
  ck('no-arg load works', typeof legacy.nearAiBaseUrl === 'string', `${legacy.target} ${legacy.graphqlEndpoint}`);
  ck('no-arg returns a valid target', ['local', 'staging', 'prod'].includes(legacy.target), legacy.target);
  ck('no-arg does NOT fill staging defaults',
    legacy.graphqlEndpoint === process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT?.trim(),
    legacy.graphqlEndpoint);

  // B. the rail and the loaded config agree: staging-shaped passes, anything
  //    else is refused. Both branches are a real assertion, so this check is
  //    meaningful whichever way the user's env file is currently pointed.
  const stagingShaped =
    legacy.target === 'staging' &&
    isStagingHost(legacy.graphqlEndpoint) &&
    isStagingHost(legacy.authEndpoint);
  try {
    requireStagingTarget(legacy);
    ck('rail verdict matches the loaded config', stagingShaped, `accepted target=${legacy.target}`);
  } catch (e) {
    ck('rail verdict matches the loaded config', !stagingShaped, String((e as Error).message).slice(0, 70));
  }

  // C. the staging rail FILLS a missing endpoint rather than throwing, and the
  //    filled value passes its own guard.
  const savedG = process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT;
  const savedA = process.env.NEWS_HARNESS_AUTH_ENDPOINT;
  const savedI = process.env.NEWS_HARNESS_INFERENCE_ENDPOINT;
  delete process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT;
  delete process.env.NEWS_HARNESS_AUTH_ENDPOINT;
  delete process.env.NEWS_HARNESS_INFERENCE_ENDPOINT;
  process.env.NEWS_HARNESS_TARGET = 'staging';
  const railed = loadHarnessEnv({ require: 'staging' });
  ck('rail fills the staging graphql default', railed.graphqlEndpoint === STAGING_DEFAULTS.graphqlEndpoint, railed.graphqlEndpoint);
  ck('rail fills the staging inference default', railed.inferenceEndpoint === STAGING_DEFAULTS.inferenceEndpoint, String(railed.inferenceEndpoint));
  try { requireStagingTarget(railed); ck('filled defaults pass the guard', true); }
  catch (e) { ck('filled defaults pass the guard', false, String(e)); }
  if (savedG !== undefined) process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT = savedG;
  if (savedA !== undefined) process.env.NEWS_HARNESS_AUTH_ENDPOINT = savedA;
  if (savedI !== undefined) process.env.NEWS_HARNESS_INFERENCE_ENDPOINT = savedI;


  console.log('\n== jsonl, agreement, cost ==');
  // --- 1. hash is stable, and sensitive to a real change -----------------------
  ck('hash stable across calls', hashMessages(MSGS) === hashMessages(MSGS));
  ck('hash differs on changed content',
    hashMessages(MSGS) !== hashMessages([{ role: 'system', content: 'S' }, { role: 'user', content: 'U2' }]));
  ck('hash ignores extra keys',
    hashMessages(MSGS) === hashMessages(MSGS.map((m) => ({ ...m, extra: 1 })) as never));

  // --- 2. writer round-trips, duplicates get a new id -------------------------
  const dir = mkdtempSync(join(tmpdir(), 'u2-'));
  const w = createJsonlWriter({ dir, name: 'rows.jsonl' });
  const base = w.write(row({}));
  const dup = w.writeDuplicate(base);
  const closed = w.close();
  await closed;
  const back = readJsonl(w.path);
  ck('jsonl round-trip', back.length === 2, `${back.length} rows`);
  ck('duplicate has new rowId', dup.rowId !== base.rowId);
  ck('duplicate points at original', dup.dupOf === base.rowId);
  ck('one row per line', readFileSync(w.path, 'utf8').trim().split('\n').length === 2);

  // --- 3. POSITIVE CONTROL: identical repeats report a perfect floor ----------
  const same = [0, 1, 2].map((i) => row({ repeat: i, toolCalls: tool('saveFact', { statement: 'A' }) }));
  const rSame = computeAgreement(same);
  ck('identical repeats: no integrity failure', rSame.integrityFailures.length === 0, rSame.integrityFailures.join('; '));
  ck('identical repeats: names 100%', rSame.cells[0].toolNameAgreement === 1);
  ck('identical repeats: args 100%', rSame.cells[0].toolArgJaccard === 1);
  ck('identical repeats: exact 100%', rSame.cells[0].exactOutputRate === 1);

  // --- 4. NEGATIVE CONTROL: planted drift must be DETECTED --------------------
  const drift = [
    row({ repeat: 0, toolCalls: tool('saveFact', { statement: 'A' }), rawOutput: 'x' }),
    row({ repeat: 1, toolCalls: tool('proposeTrack', { statement: 'A' }), rawOutput: 'y' }),
    row({ repeat: 2, toolCalls: tool('saveFact', { statement: 'B' }), rawOutput: 'z' }),
  ];
  const rDrift = computeAgreement(drift);
  ck('planted drift: name agreement below 1', rDrift.cells[0].toolNameAgreement < 1, String(rDrift.cells[0].toolNameAgreement));
  ck('planted drift: arg jaccard below 1', rDrift.cells[0].toolArgJaccard < 1, rDrift.cells[0].toolArgJaccard.toFixed(3));
  ck('planted drift: exact output 0', rDrift.cells[0].exactOutputRate === 0);

  // --- 5. the self-check: a split prompt hash is a RUNNER BUG, not noise ------
  const split = [
    row({ repeat: 0 }),
    row({ repeat: 1, promptHash: 'sha256:different' }),
    row({ repeat: 2 }),
  ];
  const rSplit = computeAgreement(split);
  ck('split hash flagged as runner bug',
    rSplit.integrityFailures.some((x) => x.startsWith('RUNNER BUG') && x.includes('promptHash')),
    rSplit.integrityFailures[0] ?? 'none');
  const nonceSplit = computeAgreement([row({ repeat: 0 }), row({ repeat: 1, fenceNonce: 'N2' }), row({ repeat: 2 })]);
  ck('split nonce flagged', nonceSplit.integrityFailures.some((x) => x.includes('fence nonces')));

  // --- 6. thin cell (n<3) is called out --------------------------------------
  const thin = computeAgreement([row({ repeat: 0 }), row({ repeat: 1 })]);
  ck('n=2 flagged as thin', thin.integrityFailures.some((x) => x.startsWith('THIN CELL')));

  // --- 7. duplicates are EXCLUDED from the floor ------------------------------
  const withDup = [...same, { ...same[0], rowId: newRowId(), dupOf: same[0].rowId }];
  const rDup = computeAgreement(withDup);
  ck('duplicate not scored', rDup.rowsScored === 3 && rDup.duplicateRows === 1, `${rDup.rowsScored}/${rDup.duplicateRows}`);

  // --- 8. cost: real catalogue numbers, checked by hand ------------------------
  const catalog: ModelCatalog = {
    'z-ai/glm-5.3-flash': {
      id: 'z-ai/glm-5.3-flash', name: 'GLM', ownedBy: 'nearai', isReady: true,
      deprecationDate: null, pricing: { inputPerM: 0.15, outputPerM: 0.5, cachedInputPerM: 0.035 },
      supportedFeatures: [], maxOutputLength: 131072, selfHosted: true,
    },
    'deepseek-ai/DeepSeek-V4-Flash': {
      id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DS', ownedBy: 'nearai', isReady: true,
      deprecationDate: '2026-09-17T13:00:00Z', pricing: { inputPerM: 0.17, outputPerM: 0.35, cachedInputPerM: 0.035 },
      supportedFeatures: [], maxOutputLength: 8192, selfHosted: true,
    },
  };
  // 1M prompt @0.15 + 1M completion @0.5 = 0.65 exactly.
  const c1 = costOf(catalog['z-ai/glm-5.3-flash'], { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 });
  ck('cost per 1M+1M is 0.65', Math.abs(c1 - 0.65) < 1e-9, c1.toFixed(6));
  // half the prompt cached: 0.5M@0.15 + 0.5M@0.035 + 0 = 0.075 + 0.0175
  const c2 = costOf(catalog['z-ai/glm-5.3-flash'], { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 500_000 });
  ck('cached tokens billed at the cache rate', Math.abs(c2 - 0.0925) < 1e-9, c2.toFixed(6));
  const c3 = costOf(catalog['z-ai/glm-5.3-flash'], { promptTokens: 100, completionTokens: 0, cachedTokens: 999_999 });
  ck('over-reported cache clamps, never credits', c3 >= 0, c3.toFixed(9));

  // --- 9. roster warnings: fires on the real deprecation, silent otherwise -----
  const now = new Date('2026-09-16T12:00:00Z');
  const warn = rosterWarnings(catalog, ['deepseek-ai/DeepSeek-V4-Flash'], { now });
  ck('retiring model warns', warn.some((x) => x.startsWith('RETIRING')), warn[0] ?? 'none');
  ck('healthy model is silent', rosterWarnings(catalog, ['z-ai/glm-5.3-flash'], { now }).length === 0);
  ck('unknown id warns', rosterWarnings(catalog, ['deepseek/deepseek-v4.1-flash'], { now })[0]?.startsWith('MISSING') === true);
  ck('past deprecation says RETIRED',
    rosterWarnings(catalog, ['deepseek-ai/DeepSeek-V4-Flash'], { now: new Date('2026-10-01T00:00:00Z') })[0]?.startsWith('RETIRED') === true);

  // --- 10. the report renders and names the arm ------------------------------
  const txt = formatAgreementReport(computeAgreement(same.map((r) => ({ ...r, cost: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, usd: 0.0004 } })), catalog));
  ck('report mentions the model', txt.includes('Qwen/Qwen3.6-35B-A3B-FP8'));
  ck('report has a USD column', txt.includes('USD/100'));


  // --- 10b. THE CASE THIS MACHINE IS ACTUALLY IN -----------------------------
  // .env.harness sets the endpoints explicitly to the PROD hosts, and the
  // loader passes a set endpoint through untouched, so --target staging alone
  // hard-fails here. The per-endpoint flags are what make a staging run
  // possible without editing a file the user edits in parallel.
  {
    const saved = {
      t: process.env.NEWS_HARNESS_TARGET,
      g: process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT,
      a: process.env.NEWS_HARNESS_AUTH_ENDPOINT,
      i: process.env.NEWS_HARNESS_INFERENCE_ENDPOINT,
    };
    process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT = 'https://graphql.mera.news/graphql';
    process.env.NEWS_HARNESS_AUTH_ENDPOINT = 'https://auth.mera.news';
    const cli = [
      '--target', 'staging',
      '--graphql-endpoint', STAGING_DEFAULTS.graphqlEndpoint,
      '--auth-endpoint', STAGING_DEFAULTS.authEndpoint,
      '--inference-endpoint', STAGING_DEFAULTS.inferenceEndpoint,
    ];
    applyTargetOverride(cli);
    const applied = applyEndpointOverrides(cli);
    ck('all three endpoint flags applied', applied.length === 3, applied.join(','));
    const overridden = loadHarnessEnv({ require: 'staging' });
    ck('CLI endpoint beats the prod value in the env file',
      overridden.graphqlEndpoint === STAGING_DEFAULTS.graphqlEndpoint, overridden.graphqlEndpoint);
    try { requireStagingTarget(overridden); ck('overridden config passes the guard', true); }
    catch (e) { ck('overridden config passes the guard', false, String(e)); }
    // and the override is still CHECKED, not merely obeyed
    applyEndpointOverrides(['--graphql-endpoint', 'https://graphql.mera.news/graphql']);
    throws('an overridden PROD endpoint is still refused',
      () => requireStagingTarget(loadHarnessEnv({ require: 'staging' })), 'is the PROD host');
    throws('endpoint flag with no value throws',
      () => applyEndpointOverrides(['--auth-endpoint', '--target']), 'needs a URL');
    for (const [k, v] of [['NEWS_HARNESS_TARGET', saved.t], ['NEWS_HARNESS_GRAPHQL_ENDPOINT', saved.g],
      ['NEWS_HARNESS_AUTH_ENDPOINT', saved.a], ['NEWS_HARNESS_INFERENCE_ENDPOINT', saved.i]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // --- 10c. a zero cache column must be reported as NOT REPORTED -------------
  {
    const rows = [0, 1, 2].map((i) => row({ repeat: i }));
    const rep = formatAgreementReport(computeAgreement(rows));
    ck('absent cache breakdown is stated', rep.includes('no row in this run reported cached prompt tokens'));
    const cached = computeAgreement(rows.map((r) => ({
      ...r, usage: { promptTokens: 1000, completionTokens: 500, cachedTokens: 400, reasoningTokens: 0 },
    })));
    ck('a real cache count suppresses the note', cached.cacheBreakdownAbsent === false);
    const thinking = computeAgreement(rows.map((r) => ({
      ...r, usage: { promptTokens: 1000, completionTokens: 500, cachedTokens: 0, reasoningTokens: 240 },
    })));
    ck('reasoning tokens are surfaced', formatAgreementReport(thinking).includes('reasoning token'));
  }

  // --- 11. latency is computed ONLY from interleaved, correctly-routed calls -
  // Two arms, three work units. Arm B skips g2 entirely, and its g1 call was
  // served by a fallback. Only g0 is comparable for both arms.
  const armA = (g: string, ms: number, over: Partial<RunRow> = {}) =>
    row({ arm: 'A', modelRequested: 'Qwen/Qwen3.6-35B-A3B-FP8', modelSent: 'Qwen/Qwen3.6-35B-A3B-FP8',
      callType: 'relevance-batch', interleaveGroup: g, latencyMs: ms, ...over });
  const armB = (g: string, ms: number, over: Partial<RunRow> = {}) =>
    row({ arm: 'B', modelRequested: 'z-ai/glm-5.3-flash', modelSent: 'z-ai/glm-5.3-flash',
      callType: 'relevance-batch', interleaveGroup: g, latencyMs: ms, ...over });
  const mixed = computeAgreement([
    armA('g0', 100), armB('g0', 200),
    armA('g1', 9000), armB('g1', 50, { fallbackFrom: 'z-ai/glm-5.3-flash', modelSent: 'Qwen/Qwen3.6-35B-A3B-FP8' }),
    armA('g2', 9999),
  ]);
  const ctA = mixed.callTypes.find((c) => c.arm === 'A');
  const ctB = mixed.callTypes.find((c) => c.arm === 'B');
  ck('lonely work unit excluded from latency', ctA?.interleavedCalls === 2, `A interleaved=${ctA?.interleavedCalls} of ${ctA?.calls}`);
  ck('non-interleaved groups counted', mixed.nonInterleavedGroups === 1, String(mixed.nonInterleavedGroups));
  ck('fallback-served call excluded', ctB?.misroutedCalls === 1 && ctB?.interleavedCalls === 1,
    `B misrouted=${ctB?.misroutedCalls} interleaved=${ctB?.interleavedCalls}`);
  ck('the 9999ms outlier never enters p95', (ctA?.maxMs ?? 0) < 9999, `A max=${ctA?.maxMs}`);
  ck('call types split out', new Set(mixed.callTypes.map((c) => c.callType)).size >= 1);
  const rpt = formatAgreementReport(mixed);
  ck('report shows the per-call-type table', rpt.includes('PER ARM AND CALL TYPE'));
  ck('report names the excluded units', rpt.includes('not completed by every arm'));
  ck('report names the misrouted calls', rpt.includes('hedge winner'));
  const streamed = computeAgreement([
    armA('s0', 100, { ttVisibleMs: 40 }), armB('s0', 120, { ttVisibleMs: 60 }),
  ]);
  ck('time-to-first-visible reported when streaming',
    streamed.callTypes.every((c) => c.ttVisibleP50Ms !== null),
    JSON.stringify(streamed.callTypes.map((c) => c.ttVisibleP50Ms)));
  ck('time-to-first-visible null when nothing streamed', ctA?.ttVisibleP50Ms === null);

  // --- 11b. designed divergence is NOT a runner bug ------------------------
  // A stateful chat cohort's repeats carry the conversation to different
  // persona states, so their prompts differ on purpose after turn 0. Flagging
  // that would fail every live run. The control pair: same divergence, one
  // marked fixture-determined and one not.
  {
    const diverged = [
      row({ repeat: 0, turnIndex: 4, promptDeterministic: false, promptHash: 'sha256:a' }),
      row({ repeat: 1, turnIndex: 4, promptDeterministic: false, promptHash: 'sha256:b' }),
      row({ repeat: 2, turnIndex: 4, promptDeterministic: false, promptHash: 'sha256:c' }),
    ];
    const rd = computeAgreement(diverged);
    ck('state-dependent divergence is NOT a runner bug',
      !rd.integrityFailures.some((x) => x.startsWith('RUNNER BUG')), rd.integrityFailures.join('; '));
    ck('divergence is COUNTED instead', rd.cells[0].distinctPrompts === 3, String(rd.cells[0].distinctPrompts));
    ck('the report shows the divergence', formatAgreementReport(rd).includes('diverged=3/3'));
    // the same shape, but claiming to be fixture-determined, MUST still fail
    const claimed = diverged.map((r) => ({ ...r, promptDeterministic: true }));
    ck('a fixture-determined cell with split prompts still fails',
      computeAgreement(claimed).integrityFailures.some((x) => x.startsWith('RUNNER BUG')));
  }

  // --- 11c. output damage is surfaced before any quality comparison --------
  // The live baseline found GLM returning its trace inside content and
  // truncating at the 320-token cap on every relevance batch, with
  // reasoningTokens 0. An arm in that state produced NO answer, and reading it
  // as "worse quality" or "cheaper" would be wrong on both counts.
  {
    const damaged = [0, 1, 2].map((i) => row({
      repeat: i, arm: 'glm', modelRequested: 'z-ai/glm-5.3-flash', modelSent: 'z-ai/glm-5.3-flash',
      finishReason: 'length', truncated: true, reasoningLeak: true,
      usage: { promptTokens: 900, completionTokens: 320, cachedTokens: 0, reasoningTokens: 0 },
    }));
    const rep = formatAgreementReport(computeAgreement(damaged));
    ck('truncation is reported per arm', rep.includes('truncated 3/3 (100.0%)'));
    ck('the trace leak is reported', rep.includes('reasoning trace inside content 3/3'));
    ck('finish_reason breakdown is shown', rep.includes('"length":3'));
    ck('a mostly-truncated arm is called out', rep.includes('did not produce a usable answer'));
    ck('the leak is named as the likely cause', rep.includes('shares the output budget'));
    const clean = formatAgreementReport(computeAgreement([0, 1, 2].map((i) => row({ repeat: i }))));
    ck('a healthy arm prints no damage block', !clean.includes('OUTPUT DAMAGE'));
  }

  // --- 11d. the leak detector agrees with the app's own stripper ------------
  ck('a closed think block is a leak', hasReasoningLeak('<think>hmm</think>[0.4]'));
  ck('a bare closer is a leak', hasReasoningLeak('thinking out loud</think>[0.4]'));
  ck('clean JSON is not a leak', !hasReasoningLeak('[0.4,0.2]'));
  ck('empty content is not a leak', !hasReasoningLeak(''));

  // --- 11e. cached prompt tokens are priced, and the banner tells the truth --
  {
    const cachedRows = [0, 1, 2].map((i) => row({
      repeat: i,
      usage: { promptTokens: 5203, completionTokens: 100, cachedTokens: 4416, reasoningTokens: 0 },
    }));
    const r2 = computeAgreement(cachedRows);
    ck('cached tokens are totalled', r2.cachedPromptTokens === 4416 * 3, String(r2.cachedPromptTokens));
    ck('the absent-cache banner does NOT fire when cache is reported', r2.cacheBreakdownAbsent === false);
    ck('the report says cached tokens were priced at the cached rate',
      formatAgreementReport(r2).includes("prefix cache"));
    // and the first-call case still says so honestly
    ck('the absent-cache banner DOES fire when nothing was cached',
      formatAgreementReport(computeAgreement([0, 1, 2].map((i) => row({ repeat: i }))))
        .includes('no row in this run reported cached prompt tokens'));
  }

  // --- 11f. the fence nonce is READ BACK, not left null --------------------
  // It was declared and never populated, which made one probe vacuous: a check
  // that reads a field nobody fills can only ever pass.
  {
    const fenced = '===== Article 0 =====\n<<ARTICLE a1b2c3d4e5f6>>\nNews Title: x\n<</ARTICLE a1b2c3d4e5f6>>';
    ck('nonce read back from a fenced prompt', extractFenceNonce(fenced) === 'a1b2c3d4e5f6', String(extractFenceNonce(fenced)));
    ck('unfenced prompt reports null', extractFenceNonce('News Title: x') === null);
    ck('a short id is not mistaken for a nonce', extractFenceNonce('<<ARTICLE abc>>') === null);
    ck('two nonces in one prompt are both surfaced',
      extractFenceNonce('<<ARTICLE aaaaaaaaaaaa>> <<ARTICLE bbbbbbbbbbbb>>') === 'aaaaaaaaaaaa,bbbbbbbbbbbb');
  }

  // --- 11g. spend limit is detected and carries its figures ----------------
  // Pinned on the VERBATIM body observed on 2026-09-16, so a wording change
  // fails here rather than turning a run back into a file of empty rows.
  {
    const real = '{"error":{"message":"API key spend limit exceeded. Spent: $10.004511644, Limit: $10.00","type":"api_key_limit_exceeded","param":null,"code":null}}';
    const e = parseSpendLimit(real);
    ck('real 402 body is recognised', e instanceof SpendLimitError);
    ck('spent is extracted', e?.spent === '10.004511644', String(e?.spent));
    ck('limit is extracted', e?.limit === '10.00', String(e?.limit));
    // the machine-readable type alone is enough, even without the figures
    ck('type alone is enough',
      parseSpendLimit('{"error":{"message":"no funds","type":"api_key_limit_exceeded"}}') instanceof SpendLimitError);
    // and the human message alone is enough, if the type ever moves
    ck('message alone is enough',
      parseSpendLimit('{"error":{"message":"API key spend limit exceeded"}}') instanceof SpendLimitError);
    // an ordinary error must NOT be mistaken for a spend limit
    ck('a normal error is not a spend limit',
      parseSpendLimit('{"error":{"message":"model is warming up","type":"server_error"}}') === null);
    ck('a rate limit is not a spend limit',
      parseSpendLimit('{"error":{"message":"Too many requests","type":"rate_limit"}}') === null);
  }

  // --- 11h. the cost estimate, checked against hand arithmetic --------------
  {
    const cat: ModelCatalog = {
      m1: { id: 'm1', name: 'm1', ownedBy: 'nearai', isReady: true, deprecationDate: null,
            pricing: { inputPerM: 0.17, outputPerM: 1.1, cachedInputPerM: 0.056 },
            supportedFeatures: [], maxOutputLength: 8192, selfHosted: true },
      m2: { id: 'm2', name: 'm2', ownedBy: 'nearai', isReady: true, deprecationDate: null,
            pricing: { inputPerM: 0, outputPerM: 0, cachedInputPerM: 0 },
            supportedFeatures: [], maxOutputLength: 0, selfHosted: true },
    };
    // 4000 chars at 4 chars/token = 1000 input tokens.
    // floor   = 1000 * 0.17/1e6                    = 0.00017
    // ceiling = floor + 320 * 1.1/1e6 = +0.000352  = 0.000522
    const est = estimateRunCost(
      [{ model: 'm1', systemChars: 2000, promptChars: 2000, maxOutputTokens: 320 }],
      cat,
    );
    ck('input tokens estimated', est.byModel[0].estInputTokens === 1000, String(est.byModel[0].estInputTokens));
    ck('floor is input only', Math.abs(est.usdFloor - 0.00017) < 1e-9, est.usdFloor.toFixed(8));
    ck('ceiling adds max output', Math.abs(est.usdCeiling - 0.000522) < 1e-9, est.usdCeiling.toFixed(8));
    ck('ceiling exceeds floor', est.usdCeiling > est.usdFloor);
    // no cache discount is assumed, so the estimate cannot be too low
    ck('no cache discount assumed', est.usdFloor > 1000 * cat.m1.pricing.cachedInputPerM / 1e6);
    const un = estimateRunCost([{ model: 'm2', systemChars: 400, promptChars: 0, maxOutputTokens: 10 }], cat);
    ck('a zero-priced model is flagged unpriced', un.unpriced.includes('m2'), un.unpriced.join(','));
    ck('unpriced is not silently costed as zero', formatCostEstimate(un).includes('NOT PRICED'));
    const missing = estimateRunCost([{ model: 'nope', systemChars: 40, promptChars: 0, maxOutputTokens: 1 }], cat);
    ck('an unknown model is flagged too', missing.unpriced.includes('nope'));
  }

  console.log('\n== corpus ==');
  // --- 12. every cohort loads and is shaped as designed ---------------------
  const loaded = COHORTS.map((c) => loadCohort(c));
  ck('all four cohorts load', loaded.length === 4, loaded.map((c) => c.name).join(','));
  ck('every cohort has turns', loaded.every((c) => c.turns.length >= 8),
    loaded.map((c) => `${c.name}:${c.turns.length}`).join(' '));
  const heavy = loaded.find((c) => c.name === 'heavy')!;
  ck('heavy starts at 20 facts', heavy.persona.facts.length === 20, String(heavy.persona.facts.length));
  ck('heavy starts at 40 topics', heavy.persona.topics.length === 40, String(heavy.persona.topics.length));
  ck('heavy starts BELOW the context cap', heavy.persona.facts.length < PROMPT_CAPS.maxFactsInContext,
    `${heavy.persona.facts.length} < ${PROMPT_CAPS.maxFactsInContext}`);
  ck('heavy has enough turns to CROSS the cap',
    heavy.persona.facts.length + heavy.turns.length > PROMPT_CAPS.maxFactsInContext,
    `${heavy.persona.facts.length} + ${heavy.turns.length} > ${PROMPT_CAPS.maxFactsInContext}`);
  ck('no em dash in any fixture turn',
    loaded.every((c) => c.turns.every((t) => !t.user.includes('\u2014'))));

  // --- 13. factsInPrompt is MEASURED, and the cap is observable -------------
  ck('measured count matches a sub-cap persona',
    measureFactsInPrompt(renderKnownFacts(heavy.persona)) === 20,
    String(measureFactsInPrompt(renderKnownFacts(heavy.persona))));
  const overCap = freshState(heavy.persona);
  for (let i = 0; i < 10; i++) {
    overCap.facts.push({ ...heavy.persona.facts[0], id: `x${i}`, statement: `Extra fact ${i}` });
  }
  const measuredOver = measureFactsInPrompt(renderKnownFacts(overCap));
  ck('the cap is OBSERVED, not assumed', measuredOver === PROMPT_CAPS.maxFactsInContext,
    `${overCap.facts.length} facts rendered as ${measuredOver}`);
  ck('an empty persona measures 0', measureFactsInPrompt(renderKnownFacts({ ...heavy.persona, facts: [] })) === 0);
  ck('turnsInPrompt counts user turns only',
    measureTurnsInPrompt([{ role: 'system' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }]) === 2);

  // --- 14. cross-turn state, through the REAL tool schema -------------------
  // The tool is saveExtractedFacts and its payload is
  // extracted_user_information, not a flat {statement}. An earlier version of
  // this matched on 'saveFact' and would have produced empty deltas forever
  // while every assertion about them still passed.
  const save = (entries: unknown[]) => [
    { name: 'saveExtractedFacts', parsed: { extracted_user_information: entries } },
  ];

  // POSITIVE CONTROL: a residence replacing a known residence must be flagged.
  const moved = applyToolCalls(heavy.persona,
    save([{ statement: 'Lives in Utrecht, Netherlands', questionnaire_attribute: 'location: residence' }]));
  ck('an offered fact is committed', moved.state.facts.length === 21, String(moved.state.facts.length));
  ck('a conflicting residence IS detected', moved.delta.conflicts.length > 0, moved.delta.conflicts[0] ?? 'none');

  // NEGATIVE CONTROL: an unrelated fact under a plural subject must NOT be
  // flagged, or the detector is just saying yes to everything.
  const unrelated = applyToolCalls(heavy.persona,
    save([{ statement: 'Enjoys sailing at weekends', questionnaire_attribute: 'interest: topic' }]));
  ck('an unrelated fact is NOT flagged', unrelated.delta.conflicts.length === 0, unrelated.delta.conflicts.join('; '));
  ck('added is recorded', unrelated.delta.added.length === 1, unrelated.delta.added.join(''));

  // THE CONFUSED COHORT'S WHOLE POINT: restating a fact already held must be
  // rejected by the app's own filter, as a duplicate.
  const restated = applyToolCalls(heavy.persona,
    save([{ statement: heavy.persona.facts[0].statement, questionnaire_attribute: 'location: residence' }]));
  ck('restating a saved fact is rejected as duplicate',
    restated.delta.rejectedByRails.some((r) => r.startsWith('duplicate')), restated.delta.rejectedByRails.join('; '));
  ck('a rejected fact is NOT committed', restated.state.facts.length === 20, String(restated.state.facts.length));
  // The tripwire fired and has been flipped. filterNewFacts now normalizes on
  // INSERT as well as on lookup, so dedup works for ANY caller rather than only
  // for one that had already normalized. Both directions are pinned so a
  // regression to the old keying is caught immediately.
  ck('dedup works on RAW existing statements (fixed upstream)',
    filterNewFacts(['Lives in Rotterdam, Netherlands'], ['Lives in Rotterdam, Netherlands'])
      .rejected[0]?.reason === 'duplicate',
    'if this fails, fact-rules has regressed to keying its set on the caller\'s raw strings');
  ck('dedup still works on pre-normalized statements',
    filterNewFacts(['Lives in Rotterdam, Netherlands'], [normalizeStatement('Lives in Rotterdam, Netherlands')])
      .rejected[0]?.reason === 'duplicate');
  // and the fix did not start rejecting things it should accept
  ck('an unrelated statement is still accepted',
    filterNewFacts(['Enjoys sailing at weekends'], ['Lives in Rotterdam, Netherlands']).rejected.length === 0);

  // alternatives are OFFERED but only the first is committed
  const alts = applyToolCalls(heavy.persona,
    save([{ statement: 'Supports Ajax', questionnaire_attribute: 'interest: sport', alternatives: ['Follows Ajax matches'] }]));
  ck('every reading is recorded as offered', alts.delta.offered.length === 2, alts.delta.offered.join(' | '));
  ck('only the first reading is committed', alts.delta.added.length === 1, alts.delta.added.join(''));

  // deleteUserFacts takes ATTRIBUTE strings, not ids
  const del = applyToolCalls(heavy.persona,
    [{ name: 'deleteUserFacts', parsed: { fact_ids: ['location: residence'] } }]);
  ck('deleteUserFacts matches on the ATTRIBUTE', del.state.facts.length === 19, String(del.state.facts.length));
  const delById = applyToolCalls(heavy.persona,
    [{ name: 'deleteUserFacts', parsed: { fact_ids: ['f01'] } }]);
  ck('passing an id deletes nothing, as the schema implies',
    delById.state.facts.length === 20, String(delById.state.facts.length));

  ck('the cohort fixture is not mutated', heavy.persona.facts.length === 20, String(heavy.persona.facts.length));
  ck('an empty extraction array is a no-op',
    applyToolCalls(heavy.persona, save([])).state.facts.length === 20);
  ck('an unknown tool name is ignored',
    applyToolCalls(heavy.persona, [{ name: 'runCalibration', parsed: {} }]).state.facts.length === 20);

  console.log('\n== chat turn extraction ==');
  // --- 15. the extracted body is BYTE-IDENTICAL to the literal it replaced ---
  // This is the control R4 asked for. The right-hand side is a verbatim copy of
  // the object replay-persona-chat.ts used to build inline, key order included,
  // and it is compared on SERIALIZED BYTES, not on deep equality, because key
  // order is what a request body actually is. If either side is edited without
  // the other, this fails, which is the whole reason the copy is kept here.
  {
    const msgs = [
      { role: 'system' as const, content: 'SYS' },
      { role: 'user' as const, content: 'U1' },
    ];
    const tools = [{ type: 'function', function: { name: 'saveFact' } }];
    for (const [label, thinking, stream, effort] of [
      ['plain', true, false, undefined],
      ['thinking off', false, false, undefined],
      ['streaming', true, true, undefined],
      ['with effort', true, true, 'none'],
    ] as [string, boolean, boolean, string | undefined][]) {
      const extracted = JSON.stringify(
        buildChatTurnBody({ model: 'M', messages: msgs, tools, thinking, stream, effort }),
      );
      const original = JSON.stringify({
        model: 'M',
        messages: msgs,
        tools,
        tool_choice: 'auto',
        max_tokens: CHAT_MAX_OUTPUT_TOKENS + CHAT_REASONING_HEADROOM_TOKENS,
        temperature: 0.4,
        chat_template_kwargs: { enable_thinking: thinking },
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
      });
      ck(`request body byte-identical: ${label}`, extracted === original,
        extracted === original ? '' : `\n    extracted: ${extracted}\n    original:  ${original}`);
    }
    // and the check itself can fail: a reordered body must NOT compare equal
    const reordered = JSON.stringify({
      messages: msgs, model: 'M', tools, tool_choice: 'auto',
      max_tokens: CHAT_MAX_OUTPUT_TOKENS + CHAT_REASONING_HEADROOM_TOKENS,
      temperature: 0.4, chat_template_kwargs: { enable_thinking: true },
    });
    ck('the byte comparison can actually fail',
      JSON.stringify(buildChatTurnBody({ model: 'M', messages: msgs, tools })) !== reordered);
    ck('thinking defaults ON, the app chat gear',
      (buildChatTurnBody({ model: 'M', messages: msgs, tools }).chat_template_kwargs as { enable_thinking: boolean }).enable_thinking === true);
    ck('budget carries the reasoning headroom',
      buildChatTurnBody({ model: 'M', messages: msgs, tools }).max_tokens ===
        CHAT_MAX_OUTPUT_TOKENS + CHAT_REASONING_HEADROOM_TOKENS,
      String(buildChatTurnBody({ model: 'M', messages: msgs, tools }).max_tokens));
  }

  // --- 16. context lands on the LAST user turn and nothing is mutated -------
  {
    const wire = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'last' },
    ];
    const out = withContextOnLastUserTurn('SYS', '<context>C</context>', wire);
    ck('system prompt is first', out[0].role === 'system');
    ck('context lands on the LAST user turn', out[3].content.startsWith('<context>C</context>'));
    ck('earlier user turn is untouched', out[1].content === 'first');
    ck('the input array is not mutated', wire[2].content === 'last');
  }

  console.log(`\n${f === 0 ? 'ALL PASS' : f + ' FAILURE(S)'}`);
  return f === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
