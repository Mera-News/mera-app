// harness-local - ONE probe call through the staging E2EE gateway.
//
//   NEWS_HARNESS_DEV_BYPASS_TOKEN=... npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/probe-gateway.ts --target staging \
//       --auth-endpoint ... --inference-endpoint ... [--model <id>]
//
// Deliberately ONE completion, not a loop. It answers the questions a corpus
// run cannot be started without: does the dev-bypass session mint a JWT, does
// the gateway serve this model's attestation, does the app's envelope decrypt a
// real response, and is the GATEWAY's own key subject to the same spend limit
// as the development key.
//
// Node-only: never imported by the app bundle.

import { loadHarnessEnv } from '../config/env';
import { applyEndpointOverrides, applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';
import { getAuthHeaders, mintJwt } from '../adapters/auth';
import { fetchModelKey, postGatewayCompletion, prepareContext } from '../adapters/gateway-e2ee-llm';
import { SpendLimitError } from '../lib/near-call';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  applyEndpointOverrides(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);
  if (!env.inferenceEndpoint) throw new Error('harness-local: no inference endpoint resolved.');

  const modelIdx = argv.indexOf('--model');
  const model = modelIdx === -1 ? 'Qwen/Qwen3.6-35B-A3B-FP8' : (argv[modelIdx + 1] as string);

  const step = (n: string, v: string): void => {
    // eslint-disable-next-line no-console
    console.log(`  ${n.padEnd(26)} ${v}`);
  };

  // eslint-disable-next-line no-console
  console.log(`GATEWAY PROBE, exactly one completion call\n  endpoint: ${env.inferenceEndpoint}\n  model   : ${model}\n`);

  const headers = await getAuthHeaders(env);
  step('1 session', Object.keys(headers).join(', ') || 'none');

  const jwt = await mintJwt(env.authEndpoint, headers);
  step('2 JWT minted', `${jwt.split('.').length} segments, ${jwt.length} chars`);

  const att = await fetchModelKey({ inferenceEndpoint: env.inferenceEndpoint, jwt }, model);
  step('3 attestation', `${att.algo}, ${att.publicKey.length / 2} byte key`);

  const ctx = prepareContext(att);
  step('4 envelope', `client key ${ctx.clientPubKeyHex.length / 2} bytes, headers ${Object.keys(ctx.headers).join(' ')}`);

  const result = await postGatewayCompletion(
    { inferenceEndpoint: env.inferenceEndpoint, jwt },
    ctx,
    {
      model,
      messages: [
        { role: 'system', content: 'Reply with exactly one word.' },
        { role: 'user', content: 'Say OK.' },
      ],
      maxTokens: 8,
      temperature: 0,
      enableThinking: false,
    },
  );

  step('5 completion', result.error ? `ERROR ${result.error}` : `ok in ${result.latencyMs}ms`);
  if (!result.error) {
    step('  decrypted content', JSON.stringify(result.content.slice(0, 80)));
    step('  finish_reason', result.finishReason);
    step('  usage', JSON.stringify(result.usage));
    step('  model served', String(result.modelSent));
  }

  // eslint-disable-next-line no-console
  console.log(
    result.error
      ? '\nVERDICT: the gateway lane is NOT yet usable end to end. The step that failed is above.'
      : '\nVERDICT: gateway lane works end to end. The envelope built from lib/e2ee/e2ee-crypto\n' +
          '         decrypted a real gateway response, so the harness and the app agree on the wire format.',
  );
  return result.error ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof SpendLimitError) {
      // eslint-disable-next-line no-console
      console.error(
        `\nGATEWAY IS SPEND LIMITED TOO.\n  spent: $${err.spent ?? 'unknown'}\n  limit: $${err.limit ?? 'unknown'}\n` +
          `  provider said: ${err.message}\n` +
          '  The gateway uses the server key, so this is a SEPARATE budget from the development key.\n',
      );
      process.exit(3);
    }
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
