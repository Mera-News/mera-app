// harness-local: the reply Mera writes after chat removed a fact that got no
// topics. Drives the app's own `runFactRemovedTurn` with the empty outcome taken
// as given: the ladder is not what this measures.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/run-fact-removed.ts \
//     --target staging --graphql-endpoint <staging> --auth-endpoint <staging> \
//     --inference-endpoint <staging> [--repeat 10] [--dry-run]
//
// Node-only: never imported by the app bundle.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { factRemovedPrompt, runFactRemovedTurn } from '../../lib/mera-harness/core/fact-removed-turn';
import { BIG_MODEL } from '../../lib/llm/constants';
import { loadHarnessEnv } from '../config/env';
import { costOf, fetchModelCatalog } from '../lib/model-catalog';
import { postCompletion } from '../lib/near-call';
import { createRunWriter } from '../lib/run-writer';
import { applyEndpointOverrides, applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';

const SPEND_STOP_USD = 1;
const FALLBACK = '__FIXED_LINE__';

const CASES: { name: string; statements: string[]; languageName: string; share: number }[] = [
  { name: 'en', statements: ['30 year old male'], languageName: 'English', share: 1 },
  { name: 'en-no-reason', statements: ['Likes things'], languageName: 'English', share: 0.3 },
  { name: 'en-two', statements: ['30 year old male', 'Prefers mornings'], languageName: 'English', share: 0.3 },
  { name: 'nl', statements: ['30 year old male'], languageName: 'Dutch', share: 0.3 },
  { name: 'hi', statements: ['30 year old male'], languageName: 'Hindi', share: 0.3 },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  applyEndpointOverrides(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);
  if (env.target !== 'staging') throw new Error('refusing: target is not staging');

  const dryRun = argv.includes('--dry-run');
  const ri = argv.indexOf('--repeat');
  const repeat = ri === -1 ? 10 : Number(argv[ri + 1]);
  const planned = CASES.map((c) => ({ ...c, runs: Math.max(1, Math.round(repeat * c.share)) }));
  console.log(`target ${env.target}, model ${BIG_MODEL}, ${planned.reduce((n, c) => n + c.runs, 0)} calls, stop at $${SPEND_STOP_USD}`); // eslint-disable-line no-console
  if (dryRun) {
    console.log(factRemovedPrompt(CASES[0].statements, CASES[0].languageName)); // eslint-disable-line no-console
    return;
  }

  const info = (await fetchModelCatalog({ baseUrl: env.nearAiBaseUrl, apiKey: env.nearAiApiKey }))[BIG_MODEL];
  if (!info) throw new Error(`${BIG_MODEL} is not in the catalogue, cannot price the run`);
  let spent = 0;
  const rows: Record<string, unknown>[] = [];
  for (const c of planned) {
    for (let i = 0; i < c.runs && spent < SPEND_STOP_USD; i++) {
      let raw = '';
      const out = await runFactRemovedTurn({
        statements: c.statements,
        languageName: c.languageName,
        fallback: FALLBACK,
        callModel: async (req) => {
          const r = await postCompletion({
            baseUrl: env.nearAiBaseUrl,
            apiKey: env.nearAiApiKey,
            model: BIG_MODEL,
            messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages] as never,
            maxTokens: req.maxTokens,
            enableThinking: false,
          });
          if (r.usage) spent += costOf(info, r.usage);
          raw = r.error ? `ERROR: ${r.error}` : r.content;
          return { ...r, toolCalls: [] };
        },
      });
      rows.push({ case: c.name, run: i, usedFallback: out.usedFallback, reply: out.reply, raw });
      console.log(`[${c.name} ${i}] ${out.usedFallback ? `FIXED LINE, model said: ${raw}` : out.reply || raw}`); // eslint-disable-line no-console
    }
  }
  const run = createRunWriter({ label: 'fact-removed' });
  writeFileSync(join(run.dir, 'rows.json'), JSON.stringify(rows, null, 1));
  const fell = rows.filter((r) => r.usedFallback).length;
  console.log(`\n${rows.length} replies, ${fell} fell back to the fixed line, spent $${spent.toFixed(4)}, ${run.dir}`); // eslint-disable-line no-console
}

main().catch((err) => {
  console.error(err); // eslint-disable-line no-console
  process.exit(1);
});
