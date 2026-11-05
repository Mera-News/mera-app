// harness-local — the daily sweep's AI check, against labelled facts.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/stake-check-eval.ts \
//     --target staging --graphql-endpoint <staging> --auth-endpoint <staging> \
//     --inference-endpoint <staging> [--repeat 3] [--dry-run] < /dev/null
//
// Runs the production request and decoder (stakeCheckRequest, decodeStakeCheck,
// SMALL_MODEL, STAKE_CHECK_CALL, thinking off) over fixtures/stake-check/cases.json.
// A no-stake fact must decode to no stake with a subject; a stake must not decode
// to an offer. --dry-run prints the prompt and makes no network call.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadHarnessEnv } from '../config/env';
import { applyEndpointOverrides, applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';
import { createRunWriter } from '../lib/run-writer';
import { postCompletion } from '../lib/near-call';
import { SMALL_MODEL } from '../../lib/llm/constants';
import {
  STAKE_CHECK_CALL,
  decodeStakeCheck,
  stakeCheckRequest,
} from '../../lib/news-harness/persona-management/stake-check';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--repeat');
  const repeat = at >= 0 ? Number(argv[at + 1]) : 3;
  const dryRun = argv.includes('--dry-run');
  const { noStake, stake } = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/stake-check/cases.json'), 'utf8'),
  ) as { noStake: string[]; stake: string[] };

  if (dryRun) {
    const req = stakeCheckRequest(noStake[0]);
    console.log(`[system]\n${req.systemPrompt}\n[user]\n${req.prompt}\n`);
    console.log(`dry run: ${noStake.length + stake.length} facts x ${repeat}, no network call.`);
    return 0;
  }

  applyTargetOverride(argv);
  applyEndpointOverrides(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);

  const rows: { statement: string; want: 'no_stake' | 'stake'; subjects: (string | null)[]; right: number; failed: number }[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  for (const [want, facts] of [['no_stake', noStake], ['stake', stake]] as const) {
    for (const statement of facts) {
      const row = { statement, want, subjects: [] as (string | null)[], right: 0, failed: 0 };
      const req = stakeCheckRequest(statement);
      for (let r = 0; r < repeat; r += 1) {
        const res = await postCompletion({
          baseUrl: env.nearAiBaseUrl,
          apiKey: env.nearAiApiKey,
          model: SMALL_MODEL,
          messages: [{ role: 'system', content: req.systemPrompt }, { role: 'user', content: req.prompt }],
          temperature: STAKE_CHECK_CALL.temperature,
          maxTokens: STAKE_CHECK_CALL.maxTokens,
          enableThinking: false,
        });
        if (res.error || res.truncated) row.failed += 1;
        promptTokens += res.usage?.promptTokens ?? 0;
        completionTokens += res.usage?.completionTokens ?? 0;
        const check = decodeStakeCheck(res.content, statement);
        const offers = !check.hasStake && check.subject !== null;
        row.subjects.push(offers ? `${check.subject} [${check.search}]` : null);
        if (offers === (want === 'no_stake')) row.right += 1;
        else console.log(`   wrong: ${res.content.trim().slice(0, 140)}`);
      }
      rows.push(row);
      console.log(`${row.right}/${repeat} ${want.padEnd(8)} ${statement}  ->  ${[...new Set(row.subjects)].join(' | ')}`);
    }
  }

  const rate = (w: string) => {
    const set = rows.filter((x) => x.want === w);
    return set.reduce((n, x) => n + x.right, 0) / (set.length * repeat);
  };
  const rates = { noStake: rate('no_stake'), stake: rate('stake'), failed: rows.reduce((n, x) => n + x.failed, 0) };
  console.log(`\nno-stake offered ${(rates.noStake * 100).toFixed(1)}%, stake held ${(rates.stake * 100).toFixed(1)}%, failed or cut off ${rates.failed}`);
  console.log(`tokens: ${promptTokens} in, ${completionTokens} out`);
  const run = createRunWriter({ label: 'stake-check' });
  run.writeJson('rows', rows);
  run.finish({ model: SMALL_MODEL, repeat, rates, promptTokens, completionTokens });
  return rates.failed > 0 ? 1 : 0;
}

if (/stake-check-eval\.ts$/.test(process.argv[1] ?? '')) main().then(
  (c) => process.exit(c),
  (e) => { console.error(e); process.exit(1); },
);
