// harness-local — G1. The live contract probe, 20 to 40 real calls.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/probe-agent-contract.ts --target staging \
//       --graphql-endpoint ... --auth-endpoint ... --inference-endpoint ...
//
// WHY THIS EXISTS. A dry run cannot tell you whether the model obeys a new
// output contract: it makes no calls and the report reads identically either
// way. This spends ~30 calls to answer four questions before G2 spends 624.
//
// WHAT "BYTE-IDENTICAL" CAN AND CANNOT MEAN LIVE. The decoder is already
// pinned byte-exact against a canned transcript in selftest.ts. What a LIVE
// probe adds is whether NEAR's real frame shape matches that assumption. Two
// live calls are not deterministic even at temperature 0, so a mismatch
// between the streamed and non-streamed runs is NOT proof of a decoder bug -
// it is usually sampling. So this reports BOTH: the paired exact-match rate
// (informational), and the thing that is actually diagnostic, whether every
// streamed tool-argument string parses as valid JSON. A fragmented-delta bug
// produces garbage like {"qu{"kiery":"Amsterdam"} which cannot parse, so a
// 100% parse rate over real multi-tool responses is the real go signal.

import { loadHarnessEnv } from '../config/env';
import { applyEndpointOverrides, applyTargetOverride, requireStagingTarget } from '../lib/staging-guard';
import { postBody, postBodyStream, SpendLimitError } from '../lib/near-call';
import { BIG_MODEL } from '../../lib/llm/constants';
import { HARNESS_TOOLS } from '../../lib/mera-harness/core/tool-contracts';

const PROMPTS = [
  'I live in Nieuw-West Amsterdam',
  'I am an expat from India living in Amsterdam',
  'I am a software engineer at a small startup',
  'My parents live in Bhopal',
  'I moved to Porto last year and I inspect bridges',
  'Actually forget Porto, I live in Lisbon now',
  'What do you know about me?',
  'I collect vinyl records',
];

const SYSTEM =
  'You are Mera, updating what you know about this person. Use the tools available to you. '
  + 'Resolve any place with lookup_place before it appears in a fact. Check find_similar_facts '
  + 'before proposing anything that might replace what you already hold. Keep prose short.';

function body(model: string, user: string, stream: boolean): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    tools: HARNESS_TOOLS,
    tool_choice: 'auto',
    max_tokens: 512,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    ...(stream ? {} : {}),
  };
}

function jsonOk(s: string): boolean {
  if (s.trim() === '') return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  applyEndpointOverrides(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);
  const model = BIG_MODEL;

  let calls = 0;
  let streamedToolCalls = 0;
  let streamedArgsParsed = 0;
  let plainToolCalls = 0;
  let plainArgsParsed = 0;
  let pairsCompared = 0;
  let pairsIdentical = 0;
  const ttFirstContent: number[] = [];
  let proseLegs = 0;
  let toolOnlyLegsWithNullTtv = 0;
  let toolOnlyLegs = 0;
  const failures: string[] = [];

  // eslint-disable-next-line no-console
  console.log(`G1 contract probe\nmodel   : ${model}\ntarget  : ${env.target}\nprompts : ${PROMPTS.length} x 2 transports\n`);

  for (const p of PROMPTS) {
    const streamed = await postBodyStream(env.nearAiBaseUrl, env.nearAiApiKey, body(model, p, true));
    calls += 1;
    const plain = await postBody(env.nearAiBaseUrl, env.nearAiApiKey, body(model, p, false));
    calls += 1;

    if (streamed.error) failures.push(`stream error on "${p.slice(0, 32)}": ${streamed.error}`);
    if (plain.error) failures.push(`plain error on "${p.slice(0, 32)}": ${plain.error}`);

    for (const t of streamed.toolCalls) {
      streamedToolCalls += 1;
      if (jsonOk(t.argumentsRaw)) streamedArgsParsed += 1;
      else failures.push(`UNPARSEABLE streamed args for ${t.name}: ${t.argumentsRaw.slice(0, 80)}`);
    }
    for (const t of plain.toolCalls) {
      plainToolCalls += 1;
      if (jsonOk(t.argumentsRaw)) plainArgsParsed += 1;
    }

    // Informational only: two live calls are not deterministic.
    const a = streamed.toolCalls.map((t) => `${t.name}:${t.argumentsRaw}`).join('|');
    const b = plain.toolCalls.map((t) => `${t.name}:${t.argumentsRaw}`).join('|');
    pairsCompared += 1;
    if (a === b) pairsIdentical += 1;

    const hasProse = streamed.content.trim().length > 0;
    if (hasProse) {
      proseLegs += 1;
      if (streamed.ttVisibleMs === null) failures.push(`prose leg reported NULL ttVisibleMs on "${p.slice(0, 32)}"`);
      else ttFirstContent.push(streamed.ttVisibleMs);
    } else {
      toolOnlyLegs += 1;
      if (streamed.ttVisibleMs === null) toolOnlyLegsWithNullTtv += 1;
      else failures.push(`tool-only leg reported a non-null ttVisibleMs on "${p.slice(0, 32)}"`);
    }

    // eslint-disable-next-line no-console
    console.log(
      `  ${p.slice(0, 40).padEnd(42)} stream: ${String(streamed.toolCalls.length).padStart(2)} tool call(s), ` +
        `${hasProse ? `ttv ${String(streamed.ttVisibleMs).padStart(5)}ms` : 'no prose      '}, ` +
        `${streamed.latencyMs}ms | plain: ${String(plain.toolCalls.length).padStart(2)} tool call(s), ${plain.latencyMs}ms`,
    );
  }

  // ---- PROSE PHASE, and it is not optional ------------------------------
  //
  // The loop above produced EIGHT tool-call legs and ZERO prose legs, so it
  // proved only that ttVisibleMs is null when it should be. A null that is
  // never seen non-null is indistinguishable from a field nothing ever fills,
  // which is the exact defect this whole transport was added to fix. These
  // four calls force prose with tool_choice none and are the positive control.
  const proseProbes = [
    'In one sentence, what is a news feed for?',
    'Reply with a single short sentence about rail travel.',
    'Say one sentence about why local news matters.',
    'One sentence: what makes a topic worth following?',
  ];
  for (const p of proseProbes) {
    const b = { ...body(model, p, true), tool_choice: 'none' as const };
    const r = await postBodyStream(env.nearAiBaseUrl, env.nearAiApiKey, b);
    calls += 1;
    if (r.error) {
      failures.push(`prose probe error: ${r.error}`);
      continue;
    }
    if (r.content.trim().length === 0) {
      failures.push(`prose probe returned NO content for "${p.slice(0, 32)}"`);
      continue;
    }
    proseLegs += 1;
    if (r.ttVisibleMs === null) {
      failures.push(`PROSE LEG REPORTED NULL ttVisibleMs: the streaming clock never started`);
    } else {
      ttFirstContent.push(r.ttVisibleMs);
    }
    // eslint-disable-next-line no-console
    console.log(
      `  [prose] ${p.slice(0, 34).padEnd(36)} ttv ${String(r.ttVisibleMs).padStart(5)}ms  total ${r.latencyMs}ms  ` +
        `${r.content.trim().slice(0, 40)}...`,
    );
  }

  const pct = (n: number, d: number): string => (d === 0 ? '   n/a' : `${((n / d) * 100).toFixed(1)}%`);
  const sorted = [...ttFirstContent].sort((x, y) => x - y);
  const p50 = sorted.length ? sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)] : null;

  // eslint-disable-next-line no-console
  console.log(
    `\n--- G1 VERDICT -------------------------------------------------------\n` +
      `calls made                     : ${calls}\n` +
      `streamed tool calls            : ${streamedToolCalls}\n` +
      `  arguments parse as JSON      : ${streamedArgsParsed}/${streamedToolCalls} ${pct(streamedArgsParsed, streamedToolCalls)}  <-- THE GO SIGNAL\n` +
      `non-streamed tool calls        : ${plainToolCalls}, parsed ${pct(plainArgsParsed, plainToolCalls)}\n` +
      `paired exact match             : ${pairsIdentical}/${pairsCompared} ${pct(pairsIdentical, pairsCompared)}  (informational: live calls are not deterministic)\n` +
      `prose legs with a ttVisibleMs  : ${ttFirstContent.length}/${proseLegs}\n` +
      `tool-only legs reporting null  : ${toolOnlyLegsWithNullTtv}/${toolOnlyLegs}\n` +
      `first-content p50              : ${p50 === null ? 'n/a' : `${p50}ms`}\n` +
      `failures                       : ${failures.length}`,
  );
  for (const f of failures.slice(0, 12)) console.log(`  ! ${f}`);

  // The gate: every streamed tool argument must parse. That is the signature
  // of the fragmented-delta bug and the only thing here that is diagnostic.
  // BOTH directions required. Parsed tool arguments prove the decoder handles
  // fragmentation; a populated ttVisibleMs on a prose leg proves the clock
  // actually starts. Either alone is half the instrument.
  const pass =
    failures.length === 0 &&
    (streamedToolCalls === 0 || streamedArgsParsed === streamedToolCalls) &&
    ttFirstContent.length > 0;
  // eslint-disable-next-line no-console
  console.log(`\nSTREAMING: ${pass ? 'GO' : 'NO-GO'}\n`);
  return pass ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    if (e instanceof SpendLimitError) {
      // eslint-disable-next-line no-console
      console.error(`\nSPEND LIMIT: spent $${e.spent ?? '?'} of $${e.limit ?? '?'}. Probe aborted.\n`);
      process.exit(3);
    }
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  },
);
