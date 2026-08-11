// harness-local — replay the FACT-CHECK claim-picker prompt against the real
// NEAR AI endpoint and dump every option set it proposes.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/replay-fact-check-claims.ts --runs 3 --label v1
//
// WHY THIS EXISTS. The deliverable of F1 is the PROMPT, and a prompt cannot be
// judged by reading it. CLAUDE.md § Measuring a Change requires a NULL
// EXPERIMENT before any delta is attributed to an edit: there is no "unchanged"
// prompt for a brand-new one, so the null run is the SAME prompt run N times
// over the SAME fixtures, and the run-to-run disagreement it reveals is the
// noise floor. Only a v1→v2 delta larger than that floor means anything.
//
// Deliberately NOT a rater. It reports mechanical, non-judgement metrics only
// (did the tool fire, how many options, how many claims recur across runs, how
// many labels overrun). Whether the claims are actually separable and checkable
// is a judgement, and per CLAUDE.md that goes to an INDEPENDENT rater which
// never sees this prompt.
//
// Node-only: never imported by the app bundle. It posts tools/tool_choice
// directly rather than going through adapters/nearai-llm.ts, whose LlmPort is
// batch TEXT completion and cannot express tool calling.
//
// WIRE PARITY with the production chat path (lib/hooks/useCloudPersonaChat.ts
// :199-217 + lib/llm/cloudComplete.ts:1040-1051), because measuring a different
// gear measures a prompt we do not ship:
//   - model BIG_MODEL, max_tokens CHAT_MAX_OUTPUT_TOKENS, no temperature
//   - chat_template_kwargs.enable_thinking = TRUE (the chat path hardcodes it)
//   - <context> is prepended to the LAST USER message, not sent as a system turn
//   - tool_choice 'auto' — never 'required'. Forcing the call would mask a
//     prompt that fails to call the tool, which is one of the real signals.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadHarnessEnv } from '../config/env';
import {
  buildFactCheckContext,
  buildFactCheckSystemPrompt,
  getFactCheckToolDefinitions,
  parseFactCheckClaimOptions,
  type FactCheckArticleInput,
} from '../../lib/news-harness/fact-check';

const BIG_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
const CHAT_MAX_OUTPUT_TOKENS = 1024;
/** Prompt guidance is ≤6 words; this is the reporting threshold for a pill that
 *  will visibly wrap on a card. */
const LABEL_WORD_LIMIT = 6;

interface Fixture {
  id: string;
  /** Why this fixture is in the set — each covers a distinct failure mode. */
  why: string;
  article: FactCheckArticleInput;
  /** The user's opening turn. Defaults to the tick's seeded question. */
  userTurn?: string;
  /** App language, when the fixture exercises the language split. */
  languageName?: string;
}

const SEED = 'What can be fact-checked in this story?';

const FIXTURES: Fixture[] = [
  {
    id: 'vaccines-multi-claim',
    why:
      "the plan's own positive control: a real prod article whose headline+summary carry several "
      + 'distinct, quantified, widely-checked assertions. If separability fails anywhere it fails here.',
    article: {
      articleId: 'fx-vaccines',
      title: 'Trump and RFK Jr. link Tylenol and vaccines to autism, contradicting scientific consensus',
      description:
        'US President Donald Trump said on Monday that pregnant women should avoid paracetamol, '
        + 'claiming it causes autism, and urged that the childhood vaccine schedule be broken up. '
        + 'Health Secretary Robert F. Kennedy Jr. said children now receive 80 different vaccines '
        + 'by the age of 18 and that autism now affects one in 31 American children. Medical bodies '
        + 'including the American Academy of Pediatrics rejected the claims, saying decades of '
        + 'research show no link between vaccines and autism.',
      publicationName: 'France 24',
    },
  },
  {
    id: 'headline-only',
    why:
      'the MISSING-DESCRIPTION case, which the prompt handles explicitly. The failure mode is '
      + 'inventing figures and names the headline never contained.',
    article: {
      articleId: 'fx-headline-only',
      title: 'Government says inflation fell to 4.2% in July, lowest in three years',
      description: null,
      publicationName: 'The Hindu',
    },
  },
  {
    id: 'sports-routine',
    why:
      'the measured ~38% of the corpus that is essentially never fact-checked. The tick is UNGATED, '
      + 'so the prompt WILL hit these. The failure mode is manufacturing a controversy to fill the card.',
    article: {
      articleId: 'fx-sports',
      title: 'Liverpool beat Arsenal 2-1 at Anfield to go top of the Premier League',
      description:
        'Mohamed Salah scored twice in the second half as Liverpool came from behind to beat '
        + 'Arsenal at Anfield on Saturday, moving one point clear at the top of the table with '
        + 'twelve matches played.',
      publicationName: 'BBC Sport',
    },
  },
  {
    id: 'opinion-column',
    why:
      'a piece with NO checkable assertion at all. The prompt says to decline rather than invent; '
      + 'this is the fixture that can make the "decline" rule report failure.',
    article: {
      articleId: 'fx-opinion',
      title: 'Why the new city cycle lanes are the best thing to happen to this town in years',
      description:
        'Our columnist argues that the council finally got something right, and that anyone still '
        + 'complaining about the loss of parking spaces should try riding a bike for a week.',
      publicationName: 'Evening Standard',
    },
  },
  {
    id: 'non-english-reader',
    why:
      'the LANGUAGE SPLIT: conversational text follows the reader, but label and claim must stay '
      + 'ENGLISH because the claim is the retrieval key sent to ClaimReview and web search.',
    article: {
      articleId: 'fx-hindi-reader',
      title: 'Delhi air quality worst in five years as AQI crosses 450, government blames stubble burning',
      description:
        "Delhi's air quality index crossed 450 on Tuesday, the highest reading since 2021, "
        + 'according to the Central Pollution Control Board. The environment minister said 38 percent '
        + 'of the pollution came from stubble burning in neighbouring Punjab and Haryana.',
      publicationName: 'Hindustan Times',
    },
    languageName: 'Hindi',
  },
  {
    id: 'user-typed-claim',
    why:
      'the user types their OWN claim in prose instead of taking the offered ones. Must stage '
      + 'exactly ONE option built from what they typed.',
    article: {
      articleId: 'fx-typed',
      title: 'Council approves new stadium plan after three-hour debate',
      description:
        'Councillors voted 21-14 on Thursday to approve the redevelopment, which the developer says '
        + 'will create 1,200 jobs.',
      publicationName: 'Local Gazette',
    },
    userTurn:
      "Actually I want to check something else — I read that this stadium is going to be the "
      + 'biggest in the country. Can you check that?',
  },
];

interface Args {
  runs: number;
  label: string;
  only: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 3, label: 'v1', only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') args.runs = Number(argv[++i] ?? args.runs);
    else if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--only') args.only = argv[++i] ?? null;
  }
  return args;
}

interface RawToolCall {
  function?: { name?: string; arguments?: string };
}

interface RunOutcome {
  fixtureId: string;
  run: number;
  /** Tool names the model called, in order. */
  toolsCalled: string[];
  /** Parsed through the SHIPPED parser, so this is what the card would show. */
  options: { label: string; claim: string }[];
  /** The assistant's conversational text (used to see WHAT it says on a decline). */
  text: string;
  error?: string;
}

async function runOnce(fixture: Fixture, apiKey: string, baseUrl: string): Promise<RunOutcome> {
  const system = buildFactCheckSystemPrompt({
    needsToolFormat: false,
    languageName: fixture.languageName ?? 'English',
  });
  const context = buildFactCheckContext({
    nowMs: Date.now(),
    article: fixture.article,
    proposal: null,
  });
  const userTurn = fixture.userTurn ?? SEED;

  const body = {
    model: BIG_MODEL,
    messages: [
      { role: 'system', content: system },
      // Production injects <context> onto the LAST user message, not as its own
      // turn — same here, or the model sees a different prompt from the app's.
      { role: 'user', content: `${context}\n\n${userTurn}` },
    ],
    tools: getFactCheckToolDefinitions(),
    tool_choice: 'auto',
    max_tokens: CHAT_MAX_OUTPUT_TOKENS,
    chat_template_kwargs: { enable_thinking: true },
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return {
      fixtureId: fixture.id,
      run: 0,
      toolsCalled: [],
      options: [],
      text: '',
      error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
    };
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
  };
  const message = json.choices?.[0]?.message ?? {};
  const calls = message.tool_calls ?? [];
  const toolsCalled = calls.map((c) => c.function?.name ?? '(unnamed)');

  let options: { label: string; claim: string }[] = [];
  for (const call of calls) {
    if (call.function?.name !== 'proposeFactCheck') continue;
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(call.function.arguments ?? '{}') as Record<string, unknown>;
    } catch {
      /* malformed arguments count as zero options — that is a real signal */
    }
    // Through the SHIPPED parser, so what this reports is what the card renders.
    options = parseFactCheckClaimOptions(parsedArgs.options ?? parsedArgs.claim);
  }

  return {
    fixtureId: fixture.id,
    run: 0,
    toolsCalled,
    options,
    text: (message.content ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Reporting — mechanical metrics only, per fixture, never averaged across them
// ---------------------------------------------------------------------------

/**
 * Content-word token set for a claim. Stopwords are dropped so "Children in the
 * United States receive 80 different vaccines by the age of 18" and "American
 * children receive 80 different vaccines by the age of 18" are recognisably the
 * same assertion.
 *
 * WHY NOT EXACT STRING MATCH. The first version of this metric compared
 * normalized strings and reported `sharedClaims: 0` on every fixture in every
 * run — including three runs that had plainly proposed the same four claims. An
 * instrument that cannot report anything but zero is not measuring the thing it
 * is named after (CLAUDE.md § "a counter-metric that cannot fail"). The
 * threshold below is checked against that case: it reports 4/4 there, and still
 * reports 0 for two genuinely different assertions.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'has', 'have', 'in',
  'is', 'it', 'its', 'of', 'on', 'or', 'said', 'says', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'their', 'they', 'this', 'these', 'according',
]);

function claimTokens(claim: string): Set<string> {
  return new Set(
    claim
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOPWORDS.has(w)),
  );
}

/** Jaccard over content words. 0.5 is the "same assertion, different wording"
 *  line: paraphrases of one claim land 0.6–0.9, distinct claims from the same
 *  article land below 0.3. */
const SAME_CLAIM_JACCARD = 0.5;

function sameClaim(a: string, b: string): boolean {
  const [ta, tb] = [claimTokens(a), claimTokens(b)];
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / (ta.size + tb.size - shared) >= SAME_CLAIM_JACCARD;
}

/** How many of run 1's claims reappear (as the same assertion) in EVERY other
 *  run. This is the stability number: the noise floor is `optionCount − this`. */
function overlapCount(runs: RunOutcome[]): number {
  if (runs.length < 2) return 0;
  const rest = runs.slice(1);
  return runs[0].options.filter((first) =>
    rest.every((r) => r.options.some((o) => sameClaim(first.claim, o.claim))),
  ).length;
}

function labelOverruns(run: RunOutcome): number {
  return run.options.filter((o) => o.label.trim().split(/\s+/).length > LABEL_WORD_LIMIT).length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadHarnessEnv();
  const apiKey = env.nearAiApiKey;
  const baseUrl = env.nearAiBaseUrl;
  if (!apiKey) throw new Error('No NEAR AI key: set NEWS_HARNESS_NEARAI_API_KEY or NEAR_AI_DEVELOPMENT_KEY');

  const fixtures = args.only ? FIXTURES.filter((f) => f.id === args.only) : FIXTURES;
  const outDir = path.join(
    process.cwd(),
    '.local-test-data',
    'fact-check-claims',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.label}`,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const all: RunOutcome[] = [];
  for (const fixture of fixtures) {
    for (let run = 1; run <= args.runs; run++) {
      const outcome = await runOnce(fixture, apiKey, baseUrl);
      outcome.run = run;
      all.push(outcome);
      const called = outcome.toolsCalled.join(',') || '(none)';
      console.log(
        `[${fixture.id}] run ${run}: tools=${called} options=${outcome.options.length}`
          + (outcome.error ? ` ERROR=${outcome.error}` : ''),
      );
      for (const option of outcome.options) console.log(`    • ${option.label} :: ${option.claim}`);
      if (!outcome.options.length && outcome.text) console.log(`    text: ${outcome.text}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'runs.json'), `${JSON.stringify(all, null, 2)}\n`);

  // Per-fixture table. NEVER averaged across fixtures: an average hides the one
  // fixture where two runs produced disjoint claim sets, which is exactly the
  // instability the null experiment exists to surface.
  // INSTRUMENT SELF-CHECK, printed every run. `sameClaim` is the only judgement
  // in this script, and its first version could only ever report "different".
  // Feeding it the input that must make it say "same" — and the input that must
  // make it say "different" — is what makes the stability column believable.
  const PARAPHRASE: [string, string] = [
    'Children in the United States receive 80 different vaccines by the age of 18.',
    'American children receive 80 different vaccines by the age of 18.',
  ];
  const DISTINCT: [string, string] = [
    'American children receive 80 different vaccines by the age of 18.',
    'Autism affects one in 31 American children.',
  ];
  console.log(
    `\ninstrument self-check: paraphrase⇒same=${sameClaim(...PARAPHRASE)} (want true), `
      + `distinct⇒same=${sameClaim(...DISTINCT)} (want false)`,
  );

  console.log(`\n=== null-experiment summary (label=${args.label}, runs=${args.runs}) ===`);
  console.log('fixture                  toolFired  options(per run)  sharedClaims  labelOverruns');
  const summary: Record<string, unknown>[] = [];
  for (const fixture of fixtures) {
    const runs = all.filter((r) => r.fixtureId === fixture.id);
    const fired = runs.filter((r) => r.toolsCalled.includes('proposeFactCheck')).length;
    const counts = runs.map((r) => r.options.length);
    const shared = overlapCount(runs);
    const overruns = runs.reduce((n, r) => n + labelOverruns(r), 0);
    console.log(
      `${fixture.id.padEnd(24)} ${String(`${fired}/${runs.length}`).padEnd(10)} `
        + `${counts.join('/').padEnd(17)} ${String(shared).padEnd(13)} ${overruns}`,
    );
    summary.push({ fixture: fixture.id, fired, counts, shared, overruns });
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  // The rater's input: options ONLY, with the article. No prompt, no rules, no
  // fixture rationale — a rater that can see the rules grades our intent.
  const raterLines = all
    .filter((r) => r.options.length > 0)
    .map((r) => {
      const fixture = fixtures.find((f) => f.id === r.fixtureId)!;
      return JSON.stringify({
        caseId: `${r.fixtureId}-run${r.run}`,
        headline: fixture.article.title,
        description: fixture.article.description ?? null,
        userAsked: fixture.userTurn ?? SEED,
        options: r.options,
      });
    });
  fs.writeFileSync(path.join(outDir, 'rater-input.jsonl'), `${raterLines.join('\n')}\n`);

  console.log(`\nartifacts: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
