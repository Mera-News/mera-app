// Node-only harness runner for the persona-management flow: fact-acceptance
// rules + cloud topic generation against a real NEAR AI endpoint.
//
//   npx tsx harness-local/scripts/test-news-harness-persona-management.ts \
//     --label my-run --facts .local-test-data/persona.json [--all] [--write-back]

import { loadHarnessEnv } from '../config/env';
import { ensureLocalTestData, defaultPersonaPath } from '../config/local-data';
import { createNearAiLlm, type LlmCallRecord } from '../adapters/nearai-llm';
import { createFilePersonaStore } from '../adapters/file-persona-store';
import { consoleLogger } from '../adapters/console-logger';
import { createRunWriter, captureGitSha } from '../lib/run-writer';
import {
  filterNewFacts,
  generateTopicsForFactsBatch,
  DEFAULT_HARNESS_CONFIG,
  type Fact,
} from '../../lib/news-harness';

interface Args {
  label: string;
  facts: string;
  all: boolean;
  writeBack: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: 'run',
    facts: defaultPersonaPath(),
    all: false,
    writeBack: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i] ?? args.label;
    else if (a === '--facts') args.facts = argv[++i] ?? args.facts;
    else if (a === '--all') args.all = true;
    else if (a === '--write-back') args.writeBack = true;
  }
  return args;
}

function factTopics(f: Fact): string[] {
  return f.metadata?.topics ?? [];
}
function factTopicGenError(f: Fact): string[] {
  return f.metadata?.topicGenError ?? [];
}

async function main(): Promise<number> {
  ensureLocalTestData();
  const args = parseArgs(process.argv.slice(2));
  const env = loadHarnessEnv();
  const topicCfg = DEFAULT_HARNESS_CONFIG.topicGen;
  const model = env.model ?? DEFAULT_HARNESS_CONFIG.articlePipeline.model;

  const personaStore = createFilePersonaStore(args.facts);
  const inputFacts = personaStore.snapshot().facts;

  // --- Fact-acceptance rules: treat the fixture statements as new candidates. ---
  const { accepted, rejected } = filterNewFacts(
    inputFacts.map((f) => f.statement),
    [],
  );
  consoleLogger.info('[persona-mgmt] fact-acceptance', {
    accepted: accepted.length,
    rejected: rejected.length,
  });
  for (const r of rejected) {
    consoleLogger.warn(`[persona-mgmt] rejected (${r.reason}): ${r.statement}`);
  }

  // --- Select facts needing topics. ---
  const targets = inputFacts.filter(
    (f) => args.all || factTopics(f).length === 0,
  );
  consoleLogger.info('[persona-mgmt] topic-gen targets', {
    count: targets.length,
    all: args.all,
  });

  // --- Cloud topic generation. ---
  const llmCalls: LlmCallRecord[] = [];
  const llm = createNearAiLlm({
    apiKey: env.nearAiApiKey,
    baseUrl: env.nearAiBaseUrl,
    defaultModel: model,
    onCall: (rec) => llmCalls.push(rec),
  });

  const t0 = Date.now();
  if (targets.length > 0) {
    await generateTopicsForFactsBatch(
      { llm, personaStore, logger: consoleLogger },
      targets.map((f) => ({ id: f.id, statement: f.statement })),
    );
  }
  const durationMs = Date.now() - t0;

  // --- Read back mutated persona state. ---
  const outputFacts = personaStore.snapshot().facts;
  const callsByFactId = new Map<string, LlmCallRecord[]>();
  for (const rec of llmCalls) {
    const sep = rec.id.lastIndexOf(':');
    const factId = sep === -1 ? rec.id : rec.id.slice(0, sep);
    const bucket = callsByFactId.get(factId) ?? [];
    bucket.push(rec);
    callsByFactId.set(factId, bucket);
  }

  const perFactTopics = targets.map((f) => {
    const out = outputFacts.find((o) => o.id === f.id);
    const topics = out ? factTopics(out) : [];
    const topicGenError = out ? factTopicGenError(out) : [];
    return {
      id: f.id,
      statement: f.statement,
      topics,
      topicGenError: topicGenError.length > 0 ? topicGenError : undefined,
      llmCalls: callsByFactId.get(f.id) ?? [],
    };
  });

  const erroredFacts = perFactTopics.filter(
    (t) => (t.topicGenError?.length ?? 0) > 0,
  );

  const usage = llmCalls.reduce(
    (acc, c) => ({
      promptTokens: acc.promptTokens + (c.usage?.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (c.usage?.completionTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 },
  );

  // --- Write run artifacts. ---
  const writer = createRunWriter({ label: args.label });
  writer.writeJson('config', {
    target: env.target,
    model,
    topicGen: topicCfg,
    gitSha: captureGitSha(),
    factsPath: args.facts,
    all: args.all,
  });
  writer.writeJson('persona', { facts: inputFacts });
  writer.writeJson('topics', perFactTopics);
  writer.writeJson('llm-calls', llmCalls);

  const summary = {
    factsProcessed: targets.length,
    accepted: accepted.length,
    rejected: rejected.length,
    rejectedReasons: rejected.map((r) => r.reason),
    topicsPerFact: perFactTopics.map((t) => ({
      id: t.id,
      count: t.topics.length,
      error: t.topicGenError?.[0],
    })),
    erroredFactCount: erroredFacts.length,
    durationMs,
    usage,
    llmCallCount: llmCalls.length,
  };
  writer.finish(summary);

  if (args.writeBack) {
    await personaStore.writeBack();
    consoleLogger.info(`[persona-mgmt] wrote persona back to ${args.facts}`);
  }

  // --- Readable stdout summary. ---
  // eslint-disable-next-line no-console
  console.log('\nPersona management run summary');
  // eslint-disable-next-line no-console
  console.table(
    perFactTopics.map((t) => ({
      fact: t.statement.slice(0, 40),
      topics: t.topics.length,
      error: t.topicGenError?.[0] ?? '',
    })),
  );

  return erroredFacts.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
