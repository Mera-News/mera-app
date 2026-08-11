// harness-local — replay ONE persona-chat turn N times and dump the FACT
// STATEMENTS the model actually saved. Sibling of replay-persona-chat.ts, which
// only reports WHICH tool was called; this one reports the tool's ARGUMENTS,
// which is what a fact-extraction prompt change moves.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/replay-fact-extraction.ts --runs 6 --arm before
//
// The `before` arm reconstructs the PRE-r14 fact-extraction rules by string-
// substituting them back into the live system prompt. That is deliberate: this
// tree has no stash/checkout available, so the only way to keep the null
// experiment falsifiable after the prompt has been edited is to carry the old
// text here explicitly. If a substitution stops matching the script FAILS LOUDLY
// rather than silently measuring the new prompt twice — an arm that cannot
// report "I am no longer the old prompt" is not a control.
//
// Node-only: never imported by the app bundle.

import { loadHarnessEnv } from '../config/env';
import {
  buildPersonaUpdateStaticPrompt,
  buildToolDefinitions,
  buildPersonaUpdateContext,
} from '../../lib/news-harness/prompts/prompts';

const BIG_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

/** The exact CLOUD fact-extraction text as it stood BEFORE the r14 edits. */
const REVERT_TO_PRE_R14: { from: string; to: string }[] = [
  {
    from: `- ATOMIC — one concept per fact. "interested in AI and blockchain" → two facts. "software engineer & expat from India" → two facts (profession and identity are different concepts).`,
    to: `- ATOMIC — one concept per fact. "interested in AI and blockchain" → two facts. "software engineer & expat from India" → two facts.`,
  },
  {
    from: /- \*\*IDENTITY COMPOSITION — the ONE exception to ATOMIC\.\*\*[^\n]*\n/,
    to: '',
  },
  {
    from: ` EXCEPTION: origin and current residence ARE the same subject (the user's own identity) and MUST be composed into one fact — see IDENTITY COMPOSITION above.`,
    to: '',
  },
  {
    from: /## Off-script extraction example \(IDENTITY COMPOSITION in practice\)[\s\S]*?Either way return to the unanswered question — do NOT just repeat "What do you do for work\?"\./,
    to: `## Off-script extraction example
Asked: "What do you do for work?" — User: "I'm an expat" → save "Expatriate / lives outside country of origin" with minted attribute "background: origin / cultural identity", reply "Got it — where are you originally from, and what do you do for work?". Do NOT just repeat "What do you do for work?".`,
  },
] as { from: string; to: string }[];

const KNOWN_FACTS = '- Lives in Amsterdam, Netherlands';
const USER_TURN = "I'm an expat from India";

interface Args {
  runs: number;
  arm: 'before' | 'after';
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 6, arm: 'after' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') args.runs = Number(argv[++i] ?? args.runs);
    else if (argv[i] === '--arm') args.arm = (argv[++i] as Args['arm']) ?? args.arm;
  }
  return args;
}

function systemPromptFor(arm: Args['arm']): string {
  let prompt = buildPersonaUpdateStaticPrompt({
    surface: 'ONBOARDING',
    includeToolFormat: false,
    languageName: 'English',
    mode: 'CLOUD',
  });
  if (arm === 'after') return prompt;
  for (const { from, to } of REVERT_TO_PRE_R14) {
    const before = prompt;
    prompt =
      typeof from === 'string'
        ? prompt.replace(from, to as string)
        : prompt.replace(from as unknown as RegExp, to as string);
    if (prompt === before) {
      throw new Error(
        `BEFORE arm is stale: substitution no longer matches → ${String(from).slice(0, 80)}`,
      );
    }
  }
  return prompt;
}

interface ToolCall {
  function?: { name?: string; arguments?: string };
}

async function runOnce(arm: Args['arm'], env: ReturnType<typeof loadHarnessEnv>) {
  const context = buildPersonaUpdateContext({ knownFactsList: KNOWN_FACTS });
  const res = await fetch(`${env.nearAiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.nearAiApiKey}`,
    },
    body: JSON.stringify({
      model: BIG_MODEL,
      messages: [
        { role: 'system', content: systemPromptFor(arm) },
        { role: 'user', content: `${context}\n\n${USER_TURN}` },
      ],
      tools: buildToolDefinitions('ONBOARDING'),
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    return { statements: [] as string[], text: '', error: `HTTP ${res.status}` };
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const msg = json.choices?.[0]?.message;
  const statements: string[] = [];
  for (const call of msg?.tool_calls ?? []) {
    if (call.function?.name !== 'saveExtractedFacts') continue;
    try {
      const args = JSON.parse(call.function.arguments ?? '{}') as {
        extracted_user_information?: { statement?: string; questionnaire_attribute?: string }[];
      };
      for (const f of args.extracted_user_information ?? []) {
        if (f.statement) statements.push(f.statement);
      }
    } catch {
      statements.push('<unparseable arguments>');
    }
  }
  const toolNames = (msg?.tool_calls ?? []).map((c) => c.function?.name ?? '?');
  return { statements, toolNames, text: (msg?.content ?? '').replace(/\n/g, ' ').slice(0, 110) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadHarnessEnv();
  console.log(`arm  : ${args.arm}\nruns : ${args.runs}\nuser : "${USER_TURN}"`);
  console.log(`known: ${KNOWN_FACTS}\nmodel: ${BIG_MODEL}\n`);

  let composed = 0;
  let placeholder = 0;
  let totalFacts = 0;
  for (let i = 0; i < args.runs; i++) {
    const out = await runOnce(args.arm, env);
    if (out.error) {
      console.log(`  run ${i + 1}: ERROR ${out.error}`);
      continue;
    }
    totalFacts += out.statements.length;
    // COMPOSED = one statement naming BOTH the origin country and the host city.
    const isComposed = out.statements.some(
      (s) => /india/i.test(s) && /(amsterdam|netherlands)/i.test(s),
    );
    // PLACEHOLDER = the country-less "Expatriate / lives outside…" shape.
    const hasPlaceholder = out.statements.some(
      (s) => /outside country of origin/i.test(s) || /^expatriate\s*$/i.test(s.trim()),
    );
    if (isComposed) composed++;
    if (hasPlaceholder) placeholder++;
    console.log(`  run ${i + 1}: ${out.statements.length} fact(s) tools=[${(out.toolNames ?? []).join(', ')}]`);
    for (const s of out.statements) console.log(`      • ${s}`);
    console.log(`      reply: "${out.text}"`);
  }
  console.log(
    `\nRESULT ${args.arm}: composed(origin+residence in ONE fact) ${composed}/${args.runs}` +
      ` | country-less placeholder ${placeholder}/${args.runs} | facts emitted ${totalFacts}`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
