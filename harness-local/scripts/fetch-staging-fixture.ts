// harness-local — freeze ONE live staging fetch as a tracked fixture.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     harness-local/scripts/fetch-staging-fixture.ts \
//       --target staging --auth-endpoint ... --graphql-endpoint ... \
//       --cohort good --limit-per-topic 5 --out harness-local/fixtures/persona-corpus/articles/staging-<date>
//
// WHY THIS IS A SEPARATE, DELIBERATE SCRIPT. `articlesForTopicsByIds` is the
// server's real per-user daily delivery point, so every fresh fetch spends from
// that cap. The corpus runners therefore never call it: they replay tracked
// fixtures. This script is the ONE place that spends, it is run by hand, and
// what it produces is committed so nobody has to spend again to reproduce a
// result.
//
// It writes the same `{_provenance, personaFacts, articles}` shape as
// goldset-348.json, so run-newsharness-corpus.ts takes the output directly with
// --fixture and needs no new code.
//
// Node-only: never imported by the app bundle.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadHarnessEnv } from '../config/env';
import {
  applyEndpointOverrides,
  applyTargetOverride,
  requireStagingTarget,
} from '../lib/staging-guard';
import { getAuthHeaders } from '../adapters/auth';
import { createGraphqlNewsApi } from '../adapters/graphql-news-api';
import { COHORTS, loadCohort } from '../lib/corpus';

interface Args {
  cohort: string;
  limitPerTopic: number;
  maxTopics: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cohort: 'good',
    limitPerTopic: 5,
    maxTopics: 8,
    out: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cohort') args.cohort = argv[++i] ?? args.cohort;
    else if (a === '--limit-per-topic') args.limitPerTopic = Number(argv[++i]);
    else if (a === '--max-topics') args.maxTopics = Number(argv[++i]);
    else if (a === '--out') args.out = resolve(argv[++i] ?? '');
  }
  if (!(COHORTS as readonly string[]).includes(args.cohort)) {
    throw new Error(`harness-local: unknown cohort '${args.cohort}'. Known: ${COHORTS.join(', ')}.`);
  }
  if (!Number.isFinite(args.limitPerTopic) || args.limitPerTopic < 1 || args.limitPerTopic > 20) {
    throw new Error('harness-local: --limit-per-topic must be between 1 and 20. This call spends the daily cap.');
  }
  if (!args.out) throw new Error('harness-local: --out <dir> is required.');
  return args;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  applyTargetOverride(argv);
  applyEndpointOverrides(argv);
  const args = parseArgs(argv);
  const env = loadHarnessEnv({ require: 'staging' });
  requireStagingTarget(env);

  const cohort = loadCohort(args.cohort);
  const topics = cohort.persona.topics.slice(0, args.maxTopics).map((t) => ({ topicText: t.text }));
  const factStatements = cohort.persona.facts.map((f) => f.statement);

  // eslint-disable-next-line no-console
  console.log(
    `cohort   : ${args.cohort}\ntopics   : ${topics.length}` +
      `\nlimit    : ${args.limitPerTopic} per topic (this SPENDS the staging daily delivery cap)` +
      `\nendpoint : ${env.graphqlEndpoint}\nout      : ${args.out}\n`,
  );

  const headers = await getAuthHeaders(env);
  const api = createGraphqlNewsApi({ endpoint: env.graphqlEndpoint, headers });

  const ids = await api.getArticleIdsForTopics(topics, { limitPerTopic: args.limitPerTopic });
  const flat = [...new Set(ids.results.flatMap((r) => r.articleIds))];
  // eslint-disable-next-line no-console
  console.log(`article ids: ${flat.length} distinct across ${ids.results.length} topic result(s)`);
  if (flat.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('No ids came back. Nothing is written rather than freezing an empty fixture.');
    return 1;
  }

  const fetched = await api.getArticlesForTopicsByIds(flat);
  // eslint-disable-next-line no-console
  console.log(
    `articles   : ${fetched.articles.length}` +
      `\ndailyLimit : ${fetched.dailyLimitReached ? `REACHED, resets ${fetched.resetAt ?? 'unknown'}` : 'not reached'}`,
  );

  const byTopic = new Map<string, string[]>();
  for (const r of ids.results) byTopic.set(r.topicText, r.articleIds);
  const topicsFor = (id: string): string[] =>
    [...byTopic.entries()].filter(([, list]) => list.includes(id)).map(([t]) => t);

  const doc = {
    _provenance: {
      what: 'One live STAGING fetch, frozen. Not prod.',
      fetchedAt: new Date().toISOString(),
      cohort: args.cohort,
      limitPerTopic: args.limitPerTopic,
      topicsQueried: topics.length,
      endpoint: env.graphqlEndpoint,
      dailyLimitReached: fetched.dailyLimitReached,
      why_frozen:
        'articlesForTopicsByIds is the server per-user daily delivery point, so every fresh fetch spends from that cap. This file exists so nobody spends again to reproduce a result, and so two prompt owners compare deltas over an identical article set.',
      shape: 'Same {personaFacts, articles} shape as goldset-348.json; pass the file to run-newsharness-corpus.ts with --fixture.',
      caveat:
        'Staging holds far fewer articles than prod, so counts and yields here are RELATIVE between arms and are not a prod estimate.',
    },
    personaFacts: factStatements.map((statement) => ({ statement })),
    articles: fetched.articles.map((a) => ({
      articleId: a._id,
      title: a.title_en,
      description: a.description_en ?? '',
      countryCode: a.country_code ?? null,
      publicationName: a.publication_name ?? null,
      pubDate: a.pubDate,
      relatedFacts: topicsFor(a._id),
    })),
  };

  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, 'goldset-staging.json');
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`\nWritten: ${file}\nCommit it. Re-running costs another slice of the daily cap.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
