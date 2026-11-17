// lib/mera-protocol/stage-scoring and stage-subscription-read against the real stack: in-memory
// DB seeded through the app's services, real stores, the real cloud client over the gateway mock,
// and the on-device lane through the real completeLocal with only llama.rn scripted. Replaces
// stage-scoring.test.ts, stage-scoring-local.test.ts, headline-exemption-math-stage.test.ts and
// stage-subscription-read.test.ts (and the relevance-v4 half that reaches this module).
import { addFact } from '@/lib/database/services/fact-service';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import {
  getUnscoredSuggestionsWithFacts,
  type ScoringCandidate,
} from '@/lib/database/services/article-suggestion-reads';
import * as subscriptionService from '@/lib/database/services/user-publication-subscription-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { ProcessingMode, type ArticleWithClusters } from '@/lib/generated/graphql-types';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { resetInferenceStats } from '@/lib/mera-protocol-toolkit/core/inference-stats';
import logger from '@/lib/logger';
import {
  computeAndScoreForCandidates,
  getScoringLlmPort,
} from '@/lib/mera-protocol/stage-scoring';
import { runSubscriptionReadStage } from '@/lib/mera-protocol/stage-subscription-read';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  advanceUntilDone,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import { decideCalls, installLlama, llamaCalls } from '@/test/helpers/llama';
import { setAppState } from '@/test/helpers/app-state';
import { resetFileSystem } from '@/test/helpers/fs';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { SUBSCRIPTION_READ_SYSTEM } from '@/lib/news-harness/on-device/subscription-read/prompt';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

// --- world -----------------------------------------------------------------

const mode = (m: 'cloud' | 'on-device') =>
  useMeraProtocolStore.getState().setProcessingMode(m === 'cloud' ? ProcessingMode.Cloud : ProcessingMode.OnDevice);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  resetInferenceStats();
  await disposeModel();
  installOnDeviceLlm();
  useMeraProtocolStore.getState().setModelState('downloaded');
  mode('cloud');
  await signInFixtureAccount();
  useFakeClock(Date.now());
  for (const level of ['warn', 'error', 'captureException'] as const) {
    jest.spyOn(logger, level).mockImplementation(() => undefined as never);
  }
});

afterEach(() => {
  server.events.removeAllListeners();
});

const run = <T>(p: Promise<T>, maxMs = 600_000): Promise<T> => advanceUntilDone(p, maxMs, 100);

// --- seeding ---------------------------------------------------------------

interface SeedOptions {
  title?: string;
  description?: string;
  publication?: string;
  pubDate?: string;
  factless?: boolean;
  headline?: 'CITY' | 'COUNTRY' | 'GLOBAL';
  stableClusterId?: string;
  /** Hydration fields: event_type, entities, geo_tags, category, maxClusterSize. */
  extra?: Record<string, unknown>;
}

let topic: { topicId: string; text: string } | null = null;

/** Unscored rows through the service feed-sync uses; fact-backed unless `factless` or `headline`. */
async function seed(ids: string[], opts: SeedOptions = {}): Promise<void> {
  const linked = !opts.factless && !opts.headline;
  if (linked && !topic) {
    const fact = await addFact('I follow Formula 1 racing');
    const [t] = await createTopics([{ factId: fact.id, text: 'formula 1', weight: 1 }]);
    topic = { topicId: t.id, text: 'formula 1' };
  }
  const fetched = ids.map(
    (id) =>
      ({
        _id: id,
        title: opts.title ?? `Story ${id} saga${id}`,
        title_en: opts.title ?? `Story ${id} saga${id}`,
        description_en: opts.description ?? `Details of story ${id}`,
        publication_name: opts.publication,
        language_code: 'en',
        country_code: null,
        pubDate: opts.pubDate ?? '2026-10-09T08:00:00.000Z',
        clusters: [],
        ...opts.extra,
      }) as unknown as ArticleWithClusters,
  );
  await persistAndLinkV2Suggestions(fetched, new Map(), {
    matchedTopics: new Map(ids.map((id) => [id, linked && topic ? [{ topicId: topic.topicId, text: topic.text }] : []])),
    headlineScope: new Map(opts.headline ? ids.map((id) => [id, opts.headline as string] as [string, string]) : []),
    stableClusterId: new Map(opts.stableClusterId ? ids.map((id) => [id, opts.stableClusterId as string] as [string, string]) : []),
  });
}

async function load(ids: string[]): Promise<ScoringCandidate[]> {
  const rows = await getUnscoredSuggestionsWithFacts();
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

async function seedAndLoad(ids: string[], opts: SeedOptions = {}): Promise<ScoringCandidate[]> {
  await seed(ids, opts);
  return load(ids);
}

beforeEach(() => {
  topic = null;
});

// ===========================================================================
// on-device relevance runs through Kev
// ===========================================================================

describe('on-device relevance - Kev', () => {
  beforeEach(() => mode('on-device'));

  it('in the background the stage throws a busy instead of scoring, so the batch stays unscored', async () => {
    installLlama([]);
    const [c] = await seedAndLoad(['a']);
    setAppState('background');
    try {
      await expect(run(computeAndScoreForCandidates([c]))).rejects.toMatchObject({ code: 'ERR_AFM_BUSY' });
      expect(decideCalls()).toHaveLength(0);
    } finally {
      setAppState('active');
    }
  });

  it('the local port completes the subscription read as plain text on the built-in model: no schema to quote its SKIP', async () => {
    installLlama([]);
    installOnDeviceLlm({ reply: 'SKIP' });

    const out = await run(getScoringLlmPort().complete({ systemPrompt: 's', prompt: 'p', maxTokens: 10, temperature: 0 }));

    expect(out).toBe('SKIP');
    expect(onDeviceLlmCalls()[0]).toMatchObject({ kind: 'respond', instructions: 's', prompt: 'p' });
    expect(llamaCalls()).toHaveLength(0);
  });
});

describe('runSubscriptionReadStage', () => {
  const SIBLING = {
    publication: 'Het Parool',
    title: 'Coalition talks collapse',
    description: 'The coalition failed to agree on nitrogen limits.',
    pubDate: '2026-10-09T07:00:00.000Z',
    stableClusterId: 'cluster-1',
  };
  const ANCHOR = { title: 'Cabinet falls over nitrogen plan', pubDate: '2026-10-09T08:00:00.000Z', stableClusterId: 'cluster-1' };

  const subscribe = () =>
    subscriptionService.upsertSubscription({
      publisherId: 'p1',
      publisherName: 'Het Parool',
      countryCode: 'NLD',
      sourceNames: ['Het Parool'],
    });

  async function seedStory(anchors: string[] = ['anchor']) {
    await seed(['sib'], SIBLING);
    // Newest first is the read order, and the sibling is a candidate too (it just has no sibling of its own).
    jest.setSystemTime(Date.now() + 1_000);
    await seed(anchors, ANCHOR);
  }

  describe('on device: its own prompt and reader', () => {
    const userOf = () => onDeviceLlmCalls()[0].prompt;
    const reads = (reply: string) => {
      installLlama([]);
      installOnDeviceLlm({ reply });
    };

    it('sends the on-device instruction and the outlet\'s fields', async () => {
      reads('Leads with the coalition talks.');
      await subscribe();
      await seedStory();

      await run(runSubscriptionReadStage());

      expect(onDeviceLlmCalls()[0].instructions).toBe(SUBSCRIPTION_READ_SYSTEM);
      expect(userOf()).toContain('The reader is looking at this story: Cabinet falls over nitrogen plan');
      expect(userOf()).toContain('Their subscribed outlet: Het Parool');
      expect(userOf()).toContain('Its headline: Coalition talks collapse');
      expect(userOf()).toContain('Its description: The coalition failed to agree on nitrogen limits.');
      expect(onDeviceLlmCalls()[0].kind).toBe('respond');
    });
  });
});
