
import { addFact } from '@/lib/database/services/fact-service';
import {
  loadSuggestions,
} from '@/lib/database/services/article-suggestion-reads';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { createTopics } from '@/lib/database/services/topic-service';
import { ProcessingMode, type ArticleWithClusters } from '@/lib/generated/graphql-types';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import logger from '@/lib/logger';
import {
  processAllUnscored,
} from '@/lib/mera-protocol/scoring-service';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  advanceUntilDone,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import { installDecide, installLlama, KEV_GPU_FAILED, llamaCalls, llamaLoads, llamaMaxLive } from '@/test/helpers/llama';
import { setAppState } from '@/test/helpers/app-state';
import { resetFileSystem } from '@/test/helpers/fs';
import { installOnDeviceLlm, type OnDeviceLlmCall } from '@/test/helpers/on-device-llm';
import { resetChatModules } from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

// --- world -----------------------------------------------------------------

let seededTopic: { topicId: string; text: string } | null = null;

async function useMode(mode: 'cloud' | 'on-device'): Promise<void> {
  useMeraProtocolStore.getState().setProcessingMode(
    mode === 'cloud' ? ProcessingMode.Cloud : ProcessingMode.OnDevice,
  );
}

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  // The built-in model (Apple Intelligence) writes the on-device notes.
  installOnDeviceLlm();
  await disposeModel();
  seededTopic = null;
  useMeraProtocolStore.getState().setModelState('downloaded');
  await useMode('cloud');
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
  title?: string | null;
  description?: string | null;
  /** No fact link and no headline scope: a row the inline scorer must not score. */
  factless?: boolean;
  headline?: 'CITY' | 'COUNTRY' | 'GLOBAL';
  /** A headline row that also matched one of the person's topics (so it has a linked fact). */
  withFact?: boolean;
  extra?: Record<string, unknown>;
}

/** Fact-backed, unscored rows through the same service feed-sync hydration uses. */
async function seed(ids: string[], opts: SeedOptions = {}): Promise<void> {
  const linked = !opts.factless && (!opts.headline || opts.withFact);
  if (!seededTopic && linked) {
    const fact = await addFact('I follow Formula 1 racing');
    const [topic] = await createTopics([{ factId: fact.id, text: 'formula 1', weight: 1 }]);
    seededTopic = { topicId: topic.id, text: 'formula 1' };
  }
  const topic = seededTopic;
  const fetched = ids.map(
    (id) =>
      ({
        _id: id,
        title: opts.title === undefined ? `Story ${id} saga${id}` : opts.title,
        title_en: opts.title === undefined ? `Story ${id} saga${id}` : opts.title,
        description_en: opts.description === undefined ? `Details of story ${id}` : opts.description,
        language_code: 'en',
        country_code: null,
        pubDate: '2026-10-09T08:00:00.000Z',
        clusters: [],
        ...opts.extra,
      }) as unknown as ArticleWithClusters,
  );
  await persistAndLinkV2Suggestions(fetched, new Map(), {
    matchedTopics: new Map(
      ids.map((id) => [id, !linked || !topic ? [] : [{ topicId: topic.topicId, text: topic.text }]]),
    ),
    headlineScope: new Map(opts.headline ? ids.map((id) => [id, opts.headline as string] as [string, string]) : []),
  });
}

const stored = async () => Object.fromEntries((await loadSuggestions()).map((s) => [s._id, s]));

const localUserOf = (c: OnDeviceLlmCall) => c.prompt;
const LOCAL_TITLE = /News Title: Story (\S+) saga/;

interface LocalScript {
  /** Kev level (0..3) per article id; default 3, the top level. */
  levels?: Record<string, number>;
  notes?: Record<string, string | { error: string }>;
}

/** Everything the on-device models did, in order: 'decide:<id>' (Kev) and 'note:<id>' (the built-in model). */
let events: string[] = [];

/** On-device models: Kev answers a level per article, the built-in model writes a note. */
function installLocal(script: LocalScript = {}): void {
  events = [];
  // llama.rn holds Kev only: a completion on it would fail the test.
  installLlama(() => ({ tokens: [], error: 'llama.rn completion on Kev' }));
  installOnDeviceLlm({
    reply: (call) => {
      const id = LOCAL_TITLE.exec(localUserOf(call))?.[1] ?? '';
      events.push(`note:${id}`);
      const note = script.notes?.[id] ?? `Local note on story ${id}.`;
      return typeof note === 'string' ? note : { error: 'ERR_AFM_CONTEXT' };
    },
  });
  installDecide((call) => {
    const id = /Story (\w+) saga/.exec(JSON.stringify(call.request.state))?.[1] ?? '';
    events.push(`decide:${id}`);
    return { scores: { rel: script.levels?.[id] ?? 3 } };
  });
}

// ===========================================================================
// processAllUnscored
// ===========================================================================

describe('processAllUnscored - on-device pass', () => {
  beforeEach(async () => {
    await useMode('on-device');
  });

  const queue = (state: 'running' | 'paused' | 'stopped' = 'running') => {
    jest.spyOn(inferenceQueue, 'getState').mockReturnValue(state);
    const pause = jest.spyOn(inferenceQueue, 'pause').mockImplementation(async () => {
      events.push('pause');
    });
    const resume = jest.spyOn(inferenceQueue, 'resume').mockImplementation(() => {
      events.push('resume');
    });
    return { pause, resume };
  };

  afterEach(() => jest.restoreAllMocks());

  it('decides every article before the first note; llama.rn loads Kev once and nothing else', async () => {
    installLocal();
    queue();
    await seed(['a', 'b', 'c']);

    expect(await run(processAllUnscored(undefined, 2))).toBe(3);

    const firstNote = events.findIndex((e) => e.startsWith('note:'));
    const lastDecide = events.map((e) => e.startsWith('decide:')).lastIndexOf(true);
    expect(lastDecide).toBeGreaterThanOrEqual(2);
    expect(lastDecide).toBeLessThan(firstNote);
    expect(events.filter((e) => e.startsWith('note:'))).toHaveLength(3);
    expect(llamaLoads()).toEqual([RELEVANCE_MODEL.modelId]);
    expect(llamaMaxLive()).toBe(1);
    expect(llamaCalls()).toHaveLength(0);
    const rows = await stored();
    expect(rows.a.reason).toBe('Local note on story a.');
  });

  // The app goes to the background during the second decide: iOS refuses the GPU work. That call
  // either returns unwritten output (ggml-metal notices only on the next call) or fails with -3.
  it.each([
    ['returns', { scores: { rel: 3 } }],
    ['fails', { error: KEV_GPU_FAILED }],
  ] as const)('the app leaving the screen while Kev ranks (the call %s) leaves the rest unscored, never on the math score, and the next pass ranks them', async (_how, answer) => {
    installLocal();
    queue();
    let decides = 0;
    installDecide(() => {
      if (++decides !== 2) return { scores: { rel: 3 } };
      setAppState('background');
      return answer;
    });
    await seed(['a', 'b', 'c']);
    const statuses = async () => Object.values(await stored()).map((r) => r.status);

    try {
      expect(await run(processAllUnscored(undefined, 1))).toBe(1);
      expect((await statuses()).filter((st) => st === 'unscored')).toHaveLength(2);
      for (const row of Object.values(await stored())) {
        if (row.status === 'unscored') expect(row.rawScore ?? null).toBeNull();
      }

      // Back on screen: the next pass loads a fresh Kev and ranks both on Kev's score.
      setAppState('active');
      installLocal();
      expect(await run(processAllUnscored(undefined, 1))).toBe(2);
      for (const row of Object.values(await stored())) expect(row.rawScore).toBeCloseTo(1, 5);
    } finally {
      setAppState('active');
    }
  });
});
