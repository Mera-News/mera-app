// harness-local — replay a FIXED persona-chat conversation against the real
// NEAR AI endpoint and report how often the model makes the expected tool call.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/replay-persona-chat.ts \
//     --fixture calibration-confirm --runs 20 --arm after
//
// WHY THIS EXISTS. The two defects this harness measures are STOCHASTIC: the
// model sometimes calls the tool and sometimes does not. A single run — or a
// single simulator session — proves nothing about either. The only meaningful
// measurement is a PASS RATE over N runs, compared before and after a change on
// the SAME fixture. Treat anything below ~20 runs per arm as indicative only,
// and always report the run count alongside the rate.
//
// Node-only: never imported by the app bundle. It posts tools/tool_choice
// directly rather than going through adapters/nearai-llm.ts, whose LlmPort is
// batch TEXT completion and cannot express tool calling.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadHarnessEnv } from '../config/env';
import {
  buildPersonaUpdateStaticPrompt,
  buildToolDefinitions,
  buildPersonaUpdateContext,
} from '../../lib/news-harness/prompts/prompts';

const BIG_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

interface WireMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface Fixture {
  description: string;
  knownFacts: string;
  /** Full conversation, oldest first. The last entry is the user's turn. */
  wire: WireMsg[];
  expect: {
    /** Tool that MUST be called for the run to pass. */
    toolCalled?: string;
    /** Tool that must NOT be called. */
    toolNotCalled?: string;
  };
}

interface Args {
  fixture: string;
  runs: number;
  arm: 'before' | 'after';
  /** Append the P2 `## PENDING INVITATION` block to <context>. */
  intent: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fixture: 'calibration-confirm', runs: 20, arm: 'after', intent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i] ?? args.fixture;
    else if (a === '--runs') args.runs = Number(argv[++i] ?? args.runs);
    else if (a === '--arm') args.arm = (argv[++i] as Args['arm']) ?? args.arm;
    else if (a === '--intent') args.intent = true;
  }
  return args;
}

interface ToolCall {
  function?: { name?: string };
}

/** The P2 intent block, verbatim as planned. Measured here BEFORE shipping it,
 *  because it is the guard against a bare non-confirmation firing the tool. */
const PENDING_INVITATION = `## PENDING INVITATION
Mera offered to re-tune the on-device relevance scoring to match the user's own corrections. If the user confirms (yes / ok / go ahead / please do — any language), call runCalibration and nothing else. If they decline, change the subject, or say anything that is not a confirmation, do NOT call it and do NOT bring it up again.
This is the ONLY action a bare confirmation may trigger.`;

async function runOnce(
  fixture: Fixture,
  arm: Args['arm'],
  intent: boolean,
  env: ReturnType<typeof loadHarnessEnv>,
): Promise<{ tools: string[]; text: string; error?: string }> {
  const systemPrompt = buildPersonaUpdateStaticPrompt({
    surface: 'CONFIG',
    includeToolFormat: false, // cloud path uses native tool calling
    languageName: 'English',
    mode: 'CLOUD',
  });
  let context = buildPersonaUpdateContext({ knownFactsList: fixture.knownFacts });
  if (intent) {
    context = context.replace('\n</context>', `\n\n${PENDING_INVITATION}\n</context>`);
  }

  // BEFORE arm reproduces the old window: ONLY the final user turn, with the
  // conversation that gave it meaning discarded. AFTER carries the whole thing.
  const carried = arm === 'before' ? fixture.wire.slice(-1) : fixture.wire;

  // <context> is injected onto the LAST user message, exactly as the app does.
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...carried.map((m, i) =>
      i === carried.length - 1 && m.role === 'user'
        ? { role: m.role, content: `${context}\n\n${m.content}` }
        : { role: m.role, content: m.content },
    ),
  ];

  const res = await fetch(`${env.nearAiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.nearAiApiKey}`,
    },
    body: JSON.stringify({
      model: BIG_MODEL,
      messages,
      tools: buildToolDefinitions('CONFIG'),
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    return { tools: [], text: '', error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const msg = json.choices?.[0]?.message;
  return {
    tools: (msg?.tool_calls ?? []).map((c) => c.function?.name ?? '?'),
    text: (msg?.content ?? '').slice(0, 120),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadHarnessEnv();

  const fixturePath = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'persona-chat',
    `${args.fixture}.json`,
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture;

  console.log(`fixture : ${args.fixture} — ${fixture.description}`);
  console.log(`arm     : ${args.arm} (${args.arm === 'before' ? 'final user turn only' : 'full history'})`);
  console.log(`runs    : ${args.runs}`);
  console.log(`intent  : ${args.intent ? 'PENDING INVITATION block present (P2)' : 'absent'}`);
  console.log(`model   : ${BIG_MODEL}\n`);

  let pass = 0;
  let errors = 0;
  const toolTally = new Map<string, number>();

  for (let i = 0; i < args.runs; i++) {
    let out;
    try {
      out = await runOnce(fixture, args.arm, args.intent, env);
    } catch (err) {
      out = { tools: [], text: '', error: String(err) };
    }
    if (out.error) {
      errors++;
      console.log(`  run ${String(i + 1).padStart(2)}: ERROR ${out.error}`);
      continue;
    }
    for (const t of out.tools) toolTally.set(t, (toolTally.get(t) ?? 0) + 1);

    const { toolCalled, toolNotCalled } = fixture.expect;
    const ok = toolCalled
      ? out.tools.includes(toolCalled)
      : toolNotCalled
        ? !out.tools.includes(toolNotCalled)
        : false;
    if (ok) pass++;
    console.log(
      `  run ${String(i + 1).padStart(2)}: ${ok ? 'PASS' : 'FAIL'} tools=[${out.tools.join(', ')}] "${out.text.replace(/\n/g, ' ')}"`,
    );
  }

  const attempted = args.runs - errors;
  console.log(
    `\nRESULT ${args.fixture}/${args.arm}: ${pass}/${attempted} ` +
      `(${attempted > 0 ? Math.round((pass / attempted) * 100) : 0}%)` +
      (errors ? `  [${errors} transport errors excluded]` : ''),
  );
  console.log('tool calls seen:', Object.fromEntries(toolTally));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
