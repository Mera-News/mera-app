// harness-local - does tool use stay inside the E2EE envelope?
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/probe-text-tools.ts \
//     --target staging --graphql-endpoint https://graphql.staging.mera.news/graphql \
//     --auth-endpoint https://auth.staging.mera.news \
//     --inference-endpoint https://inference.staging.mera.news [--models a,b] [--repeat n] [--format hermes|xml|marker]
//
// Through the REAL staging gateway, with the app's own envelope and the app's
// own text-tool codec (lib/llm/text-tool-protocol). Two rules, fixed before the
// first run:
//
// RULE 1 (privacy, binary). A request with NO `tools` field, whose system prompt
// carries the tools block, asks the model to store a random sentinel through a
// tool. PASS only if the RAW response bytes carry no `tool_calls` key and no
// sentinel in clear, for every model, streamed and buffered. Positive control:
// the decrypted text must hold a parsed call carrying the sentinel, or the row
// proves nothing. Negative control: the same ask with a NATIVE `tools` field
// must show the sentinel in clear, or the detector is blind.
//
// RULE 2 (history). An assistant turn holding `<tool_call>` text and a user
// turn holding `<tool_response>` text (both encrypted) decrypt without a 400
// and the reply uses what the tool returned.
//
// Node-only: never imported by the app bundle.

import { randomBytes } from 'node:crypto';

import { loadHarnessEnv } from '../config/env';
import { applyEndpointOverrides, applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';
import { getAuthHeaders, mintJwt } from '../adapters/auth';
import { fetchModelKey, prepareContext } from '../adapters/gateway-e2ee-llm';
import { decryptContent, encryptContent, type E2EEContext } from '../../lib/e2ee/e2ee-crypto';
import {
  parseToolCallsFromText,
  toTextToolMessages,
  type ProtocolMessageIn,
  type TextToolDefinition,
  type ToolFormat,
} from '../../lib/llm/text-tool-protocol';
import { BIG_MODEL, SMALL_MODEL } from '../../lib/llm/constants';

const TOOL: TextToolDefinition = {
  type: 'function',
  function: {
    name: 'record_code',
    description: "Store the user's code exactly as given.",
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The code, verbatim.' } },
      required: ['code'],
    },
  },
};

const HEX = /^[0-9a-f]+$/i;

function sentinel(): string {
  return `QZX${randomBytes(5).toString('hex').toUpperCase()}`;
}

interface Capture {
  status: number;
  raw: string;
  /** Every non-hex string leaf of every JSON frame, in order: where clear text would hide. */
  clearStrings: string[];
  /** Every content / reasoning_content value. */
  envelopes: string[];
  decrypted: string;
  decryptError: string | null;
}

function leaves(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
}

async function post(
  endpoint: string,
  jwt: string,
  ctx: E2EEContext,
  body: Record<string, unknown>,
): Promise<Capture> {
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, ...ctx.headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const cap: Capture = { status: res.status, raw, clearStrings: [], envelopes: [], decrypted: '', decryptError: null };
  if (!res.ok) return cap;
  const frames: unknown[] = body.stream
    ? raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter((l) => l && l !== '[DONE]')
        .map((l) => JSON.parse(l) as unknown)
    : [JSON.parse(raw) as unknown];
  for (const f of frames) {
    const all: string[] = [];
    leaves(f, all);
    cap.clearStrings.push(...all.filter((s) => !HEX.test(s)));
    const choice = (f as { choices?: { delta?: Record<string, unknown>; message?: Record<string, unknown> }[] })
      .choices?.[0];
    const part = choice?.delta ?? choice?.message ?? {};
    for (const k of ['content', 'reasoning_content']) {
      const v = part[k];
      if (typeof v === 'string' && v.length > 0) {
        cap.envelopes.push(v);
        if (k === 'content') {
          try {
            cap.decrypted += decryptContent(v, ctx.privateKey, ctx.algo);
          } catch (err) {
            cap.decryptError = err instanceof Error ? err.message : String(err);
          }
        }
      }
    }
  }
  return cap;
}

function encrypt(messages: { role: string; content: string }[], ctx: E2EEContext) {
  return messages.map((m) => ({ role: m.role, content: m.content ? encryptContent(m.content, ctx) : m.content }));
}

function base(model: string, stream: boolean) {
  return {
    model,
    stream,
    temperature: 0,
    max_tokens: 300,
    chat_template_kwargs: { enable_thinking: false },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  applyEndpointOverrides(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);
  if (!env.inferenceEndpoint) throw new Error('harness-local: no inference endpoint resolved.');
  const mi = argv.indexOf('--models');
  const models = mi === -1 ? [BIG_MODEL, SMALL_MODEL] : (argv[mi + 1] ?? '').split(',').filter(Boolean);
  const ri = argv.indexOf('--repeat');
  const repeat = ri === -1 ? 2 : Number(argv[ri + 1]);
  const fi = argv.indexOf('--format');
  const format = (fi !== -1 ? argv[fi + 1] : 'hermes') as ToolFormat;
  if (!['hermes', 'xml', 'xml-first', 'marker'].includes(format)) throw new Error(`--format takes hermes|xml|xml-first|marker`);
  console.log(`tool format: ${format}`); // eslint-disable-line no-console

  const jwt = await mintJwt(env.authEndpoint, await getAuthHeaders(env));
  const log = (s: string) => console.log(s); // eslint-disable-line no-console
  let rule1 = true;
  let rule1Rows = 0;
  let rule2 = true;
  let negativeBlind = false;

  for (const model of models) {
    const att = await fetchModelKey({ inferenceEndpoint: env.inferenceEndpoint, jwt }, model);
    log(`\n=== ${model} (${att.algo})`);

    // Negative control: a native tools field must leak the sentinel, or the detector is blind.
    {
      const s = sentinel();
      const ctx = prepareContext(att);
      const cap = await post(env.inferenceEndpoint, jwt, ctx, {
        ...base(model, false),
        messages: encrypt(
          [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: `Store my code ${s} with the tool.` },
          ],
          ctx,
        ),
        tools: [TOOL],
        tool_choice: 'required',
      });
      const leaked = cap.raw.includes(s);
      if (!leaked) negativeBlind = true;
      log(`  negative control (native tools, buffered): status ${cap.status}, sentinel in clear: ${leaked ? 'YES (detector sees it)' : 'NO (BLIND)'}, tool_calls key: ${cap.raw.includes('"tool_calls"')}`);
    }

    for (const stream of [true, false]) {
      for (let r = 0; r < repeat; r++) {
        const s = sentinel();
        const ctx = prepareContext(att);
        const msgs = toTextToolMessages(
          [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: `Store my code ${s} with the tool.` },
          ],
          [TOOL],
          'required',
          format,
        );
        const body: Record<string, unknown> = { ...base(model, stream), messages: encrypt(msgs, ctx) };
        const cap = await post(env.inferenceEndpoint, jwt, ctx, body);
        const keyPresent = cap.raw.includes('"tool_calls"');
        const keyPopulated = /"tool_calls"\s*:\s*\[\s*\{/.test(cap.raw);
        const sentinelRaw = cap.raw.includes(s);
        const sentinelClear = cap.clearStrings.join('').includes(s);
        const allHex = cap.envelopes.every((e) => HEX.test(e));
        const parsed = parseToolCallsFromText(cap.decrypted, [TOOL], format);
        const call = parsed.calls.find((c) => c.name === 'record_code');
        const positive = !!call && call.argumentsRaw.includes(s);
        const ok = cap.status === 200 && !keyPresent && !sentinelRaw && !sentinelClear && allHex && cap.decryptError === null;
        rule1Rows += 1;
        if (!ok) rule1 = false;
        log(
          `  RULE1 ${stream ? 'streamed' : 'buffered'} #${r}: ${ok ? 'PASS' : 'FAIL'}  status ${cap.status}` +
            `  tool_calls key ${keyPresent}${keyPresent ? ` (populated ${keyPopulated})` : ''}` +
            `  sentinel raw ${sentinelRaw} clear ${sentinelClear}  envelopes ${cap.envelopes.length} all-hex ${allHex}` +
            `  decrypt ${cap.decryptError ?? 'ok'}  positive control ${positive ? 'call carried sentinel' : 'NO CALL (row proves nothing)'}`,
        );
        if (!positive) log(`    decrypted: ${JSON.stringify(cap.decrypted.slice(0, 300))}`);
        if (keyPresent) log(`    raw excerpt: ${cap.raw.slice(Math.max(0, cap.raw.indexOf('"tool_calls"') - 40), cap.raw.indexOf('"tool_calls"') + 80)}`);
      }
    }

    // RULE 2: replayed history, streamed (the app's path).
    {
      const s = sentinel();
      const ctx = prepareContext(att);
      const history: ProtocolMessageIn[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: `Store my code ${s} with the tool, then tell me which slot number it was stored in.` },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'record_code', arguments: JSON.stringify({ code: s }) } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ stored: true, code: s, slot: 47 }) },
      ];
      const msgs = toTextToolMessages(history, [TOOL], undefined, format);
      const cap = await post(env.inferenceEndpoint, jwt, ctx, { ...base(model, true), messages: encrypt(msgs, ctx) });
      const coherent = /\b47\b/.test(cap.decrypted);
      const clean = !cap.raw.includes(s) && !cap.raw.includes('"tool_calls"');
      const ok = cap.status === 200 && cap.decryptError === null && coherent && clean;
      if (!ok) rule2 = false;
      log(
        `  RULE2 history: ${ok ? 'PASS' : 'FAIL'}  status ${cap.status}  decrypt ${cap.decryptError ?? 'ok'}` +
          `  reply names slot 47 ${coherent}  raw clean ${clean}`,
      );
      log(`    reply: ${JSON.stringify(cap.decrypted.slice(0, 200))}`);
      if (cap.status !== 200) log(`    body: ${cap.raw.slice(0, 300)}`);
    }
  }

  log(
    `\nRULE 1 (privacy): ${rule1 ? 'PASS' : 'FAIL'} over ${rule1Rows} rows` +
      `${negativeBlind ? '  !! a negative control was BLIND, so a PASS here is not evidence' : ''}` +
      `\nRULE 2 (history): ${rule2 ? 'PASS' : 'FAIL'}`,
  );
  return rule1 && rule2 && !negativeBlind ? 0 : 1;
}

if (process.argv[1]?.includes('probe-text-tools')) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err); // eslint-disable-line no-console
      process.exit(1);
    },
  );
}
