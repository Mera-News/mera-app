// lib/mera-protocol/scoring-service against the real stack: in-memory DB, real stores, the real
// cloud client over the gateway mock (E2EE both ways), and the on-device lane through the real
// completeLocal / modelManager / inference queue with only llama.rn scripted. Replaces
// scoring-service.test.ts, scoring-service.more.test.ts and relevance-v4.test.ts.
//
// The cloud scorer calls the BATCH route, whose items carry no call id, so the responder tells a
// relevance call from a reason call by its system prompt and reads each article from the
// `News Title: Story <id>` line.
import { addFact } from '@/lib/database/services/fact-service';
import * as scoringWrites from '@/lib/database/services/article-suggestion-scoring-writes';
import * as suggestionReads from '@/lib/database/services/article-suggestion-reads';
import {
  loadSuggestions,
  getUnscoredSuggestionsWithFacts,
  type ScoringCandidate,
} from '@/lib/database/services/article-suggestion-reads';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import * as stageSubscriptionRead from '@/lib/mera-protocol/stage-subscription-read';
import { addSuppression } from '@/lib/database/services/suppression-service';
import * as topicService from '@/lib/database/services/topic-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { ProcessingMode, type ArticleWithClusters } from '@/lib/generated/graphql-types';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import logger from '@/lib/logger';
import {
  CLOUD_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
  batchScoreAndReason,
  bucketScores,
  buildReasonCallsForSubset,
  buildRelevanceCalls,
  decodeCloudBatchResults,
  decodeResults,
  processAllUnscored,
  rependSkippedNotes,
  retryMissingReasons,
  runFeedVerifierPass,
} from '@/lib/mera-protocol/scoring-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { NOTE_SYSTEM } from '@/lib/news-harness/on-device/notes/prompt';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  advanceUntilDone,
  gatewayCalls,
  http,
  HttpResponse,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
  type GatewayCall,
  type GatewayResponder,
} from '@/test/helpers';
import { decideCalls, installDecide, installLlama, KEV_GPU_FAILED, llamaCalls, llamaLoads, llamaMaxLive } from '@/test/helpers/llama';
import { setAppState } from '@/test/helpers/app-state';
import { resetFileSystem } from '@/test/helpers/fs';
import { installOnDeviceLlm, onDeviceLlmCalls, type OnDeviceLlmCall } from '@/test/helpers/on-device-llm';
import { resetChatModules } from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

const ART = DEFAULT_HARNESS_CONFIG.articlePipeline;
const BATCH_PATH = '/v1/chat/completions/batch';
const REASON_SYSTEMS = new Set([ART.reasonSystemPrompt, ART.headlineReasonSystemPrompt]);

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

/** The unscored rows as the scorer receives them. */
const unscored = (): Promise<ScoringCandidate[]> => getUnscoredSuggestionsWithFacts();

async function seedAndLoad(ids: string[], opts: SeedOptions = {}): Promise<ScoringCandidate[]> {
  await seed(ids, opts);
  const rows = await unscored();
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

const stored = async () => Object.fromEntries((await loadSuggestions()).map((s) => [s._id, s]));

// --- scripted gateway ------------------------------------------------------

interface Script {
  /** Relevance score per article id (default 0.9). */
  scores?: Record<string, number>;
  /** Reason reply per article id; '' is an empty reply. Default: one grounded sentence. */
  notes?: Record<string, string>;
  /** A reason reply that is also a pass-2 rescore. */
  rescores?: Record<string, { k: string; s: number }>;
}

const TITLE = /News Title: Story (\S+) saga/g;
const ids = (call: GatewayCall): string[] =>
  [...(call.messages.find((m) => m.role === 'user')?.content ?? '').matchAll(TITLE)].map((m) => m[1]);
const systemOf = (call: GatewayCall): string => call.messages.find((m) => m.role === 'system')?.content ?? '';

function scripted(script: Script = {}): GatewayResponder {
  return (call) => {
    const found = ids(call);
    if (REASON_SYSTEMS.has(systemOf(call))) {
      const id = found[0];
      if (script.notes && id in script.notes) return script.notes[id];
      const note = `Why story ${id} matters here.`;
      const rescore = script.rescores?.[id];
      return rescore ? JSON.stringify({ ...rescore, reason: note }) : note;
    }
    return JSON.stringify(found.map((id) => script.scores?.[id] ?? 0.9));
  };
}

const gateway = (script: Script = {}) => server.use(...mockGateway(scripted(script)));

/** The batch route's request bodies as sent (content is sealed; max_tokens and the model are not). */
function watchBatches(): () => Promise<{ requests: { model: string; max_tokens?: number; temperature: number }[] }[]> {
  const bodies: Promise<{ requests: { model: string; max_tokens?: number; temperature: number }[] }>[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === BATCH_PATH) bodies.push(request.clone().json());
  });
  return () => Promise.all(bodies);
}

const userOf = (call: GatewayCall) => call.messages.find((m) => m.role === 'user')?.content ?? '';
const fenceCount = (call: GatewayCall) => (userOf(call).match(/<<ARTICLE [a-f0-9]{12}>>/g) ?? []).length;

// --- local lane ------------------------------------------------------------

const localSystemOf = (c: OnDeviceLlmCall) => c.instructions;
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
// decodeCloudBatchResults
// ===========================================================================

const candidate = (id: string): ScoringCandidate => ({
  id,
  titleEn: `title-${id}`,
  descriptionEn: `desc-${id}`,
  countryCode: 'USA',
  userTopicIds: [],
  relatedFacts: [{ id: `f-${id}`, statement: 'a fact' }],
});

const FALLBACK_RELEVANCE = 0.3;

function decodeScores(output: string, ...cands: ScoringCandidate[]) {
  return decodeCloudBatchResults({
    batchResults: [{ id: 'score:0', output }],
    promptsById: new Map(),
    chunkIdToCandidates: new Map([['score:0', cands]]),
  });
}

const decodeReason = (output: string, error?: string): string =>
  decodeCloudBatchResults({
    batchResults: [{ id: 'reason:xyz', output, ...(error ? { error } : {}) }],
    promptsById: new Map(),
    chunkIdToCandidates: new Map(),
  }).reasonMap.get('xyz') ?? '<<missing>>';

describe('decodeCloudBatchResults', () => {
  it('decodes a happy-path score chunk into per-candidate scores', () => {
    const { scoreMap, failedIds } = decodeScores('[0.8, 0.5]', candidate('a'), candidate('b'));
    expect(scoreMap.get('a')).toBe(0.8);
    expect(scoreMap.get('b')).toBe(0.5);
    expect(failedIds.size).toBe(0);
  });

  it('maps a chunk error to FALLBACK_RELEVANCE for every candidate and records failedIds', () => {
    const { scoreMap, failedIds } = decodeCloudBatchResults({
      batchResults: [{ id: 'score:0', output: '', error: 'upstream 500' }],
      promptsById: new Map(),
      chunkIdToCandidates: new Map([['score:0', [candidate('a'), candidate('b')]]]),
    });
    expect(scoreMap.get('a')).toBe(FALLBACK_RELEVANCE);
    expect(scoreMap.get('b')).toBe(FALLBACK_RELEVANCE);
    expect([...failedIds].sort()).toEqual(['a', 'b']);
  });

  it('clamps out-of-range scores into [0, 1.1]', () => {
    const { scoreMap } = decodeScores('[5.0, -2.0]', candidate('a'), candidate('b'));
    expect(scoreMap.get('a')).toBe(1.1);
    expect(scoreMap.get('b')).toBe(0);
  });

  it('pads with fallback when the model returns fewer scores than candidates', () => {
    const { scoreMap } = decodeScores('[0.9]', candidate('a'), candidate('b'));
    expect(scoreMap.get('a')).toBe(0.9);
    expect(scoreMap.get('b')).toBe(FALLBACK_RELEVANCE);
  });

  it('falls back to all-fallback when the score output is unparseable', () => {
    expect(decodeScores('not json at all', candidate('a')).scoreMap.get('a')).toBe(FALLBACK_RELEVANCE);
  });

  it('decodes a reason result keyed by the candidate id', () => {
    expect(decodeReason('This matters because of X.')).toBe('This matters because of X.');
  });

  it('maps a reason error to an empty string for that id', () => {
    expect(decodeReason('', 'timeout')).toBe('');
  });

  it('strips boilerplate / markdown from a reason payload', () => {
    expect(decodeReason('**Why this matters to you:** It **affects** your area.')).toBe('It affects your area.');
  });

  it('exposes decodeResults as an alias of decodeCloudBatchResults', () => {
    expect(decodeResults).toBe(decodeCloudBatchResults);
  });
});

describe('parseBatchRelevanceResponse (via decodeCloudBatchResults)', () => {
  const x = candidate('x');

  it('parses a single-number JSON (legacy format) for expectedCount=1', () => {
    expect(decodeScores('0.75', x).scoreMap.get('x')).toBe(0.75);
  });

  it('does NOT regex-scrape numbers out of prose', () => {
    // A thinking model leaks its reasoning into `content`; scraping it for numbers invented
    // EMERGENCY-tier scores. Prose is a clean decode failure.
    const { scoreMap } = decodeScores('score for a is 0.7 and b is 0.5', candidate('a'), candidate('b'));
    expect(scoreMap.get('a')).toBe(0.3);
    expect(scoreMap.get('b')).toBe(0.3);
  });

  it('still recovers a bare number list that carries no prose', () => {
    const { scoreMap } = decodeScores('0.8, 0.5', candidate('a'), candidate('b'));
    expect(scoreMap.get('a')).toBe(0.8);
    expect(scoreMap.get('b')).toBe(0.5);
  });

  it('falls back to all-fallback when output has no parseable numbers', () => {
    expect(decodeScores('no numbers here at all!', x).scoreMap.get('x')).toBe(0.3);
  });

  it('truncates extra scores when model returns more than expected', () => {
    expect(decodeScores('[0.9, 0.8, 0.7]', candidate('a')).scoreMap.get('a')).toBe(0.9);
  });

  it('parses the tiered {"k","s"} object format', () => {
    const { scoreMap } = decodeScores(
      '[{"k":"domain","s":0.62},{"k":"none","s":0.12},{"k":"interest","s":0.33}]',
      candidate('a'),
      candidate('b'),
      candidate('c'),
    );
    expect([scoreMap.get('a'), scoreMap.get('b'), scoreMap.get('c')]).toEqual([0.62, 0.12, 0.33]);
  });

  it('clamps a tiered score into the band its stake tag declares', () => {
    const { scoreMap } = decodeScores(
      '[{"k":"none","s":0.60},{"k":"family","s":0.20},{"k":"interest","s":0.50}]',
      candidate('a'),
      candidate('b'),
      candidate('c'),
    );
    expect(scoreMap.get('a')).toBe(0.24); // none capped below TANGENTIAL
    expect(scoreMap.get('b')).toBe(0.4); // FEED stake floored into the FEED band
    expect(scoreMap.get('c')).toBe(0.39); // interest capped below FEED
  });

  it('plain-clamps a tiered score with an unknown stake tag', () => {
    expect(decodeScores('[{"k":"whatever","s":1.4}]', candidate('a')).scoreMap.get('a')).toBe(1.1);
  });

  it.each([
    ['[-0.5]', 0],
    ['[2.5]', 1.1],
  ])('clamps %s to %s', (output, expected) => {
    expect(decodeScores(output, x).scoreMap.get('x')).toBe(expected);
  });
});

describe('parseReasonResponse (via decodeCloudBatchResults)', () => {
  it('extracts a plain string from a JSON string response', () => {
    expect(decodeReason('"A plain reason."')).toBe('A plain reason.');
  });

  it('extracts the reason field from a JSON object response', () => {
    expect(decodeReason('{"reason": "Object reason text."}')).toBe('Object reason text.');
  });

  it('returns plain text as-is when not valid JSON', () => {
    expect(decodeReason('Plain text reason.')).toBe('Plain text reason.');
  });

  it('strips [User facts] lines, the Relevance Score header and the Why-this-matters header', () => {
    expect(decodeReason('Great article.\n[User facts] some fact here.')).not.toContain('[User facts]');
    expect(decodeReason('**Relevance Score: 0.8** This matters to you.')).not.toContain('Relevance Score');
    expect(decodeReason('**Why this matters to you:** It affects your work.')).not.toContain('Why this matters');
  });

  it('strips markdown asterisks and hashes, and collapses newlines to single spaces', () => {
    const marked = decodeReason('## The **key** insight is here.');
    expect(marked).not.toContain('**');
    expect(marked).not.toContain('#');
    expect(decodeReason('First line.\nSecond line.')).not.toContain('\n');
  });

  it('truncates output to 200 characters', () => {
    expect(decodeReason('A'.repeat(300)).length).toBeLessThanOrEqual(200);
  });

  it('returns an empty string when the stripped output has no content', () => {
    expect(decodeReason('**Why this matters to you:** [User facts] Relevance Score: 0.5')).toBe('');
  });

  it('strips quotes from a quoted sentence', () => {
    expect(decodeReason('"An article about tech."')).toBe('An article about tech.');
  });
});

// ===========================================================================
// bucketScores and the constants
// ===========================================================================

describe('bucketScores', () => {
  it.each([
    [0.1, 0.1], // below DISCARD_FLOOR: untouched
    [0.39, 0.39],
    [0.4, 0.4], // floor into LOW
    [0.59, 0.4],
    [0.6, 0.6], // MEDIUM boundary
    [0.79, 0.6],
    [0.8, 0.8], // HIGH boundary
    [1.0, 0.8],
    [1.05, 1.1], // EMERGENCY
    [1.1, 1.1],
  ])('buckets %s into %s', (raw, bucket) => {
    const m = new Map([['a', raw]]);
    bucketScores(m);
    expect(m.get('a')).toBe(bucket);
  });

  it('mutates the map in place and handles an empty map', () => {
    const m = new Map<string, number>();
    expect(() => bucketScores(m)).not.toThrow();
    expect(m.size).toBe(0);
  });
});

describe('constants', () => {
  it('REASON_MIN_RAW_SCORE is 0 and CLOUD_SCORE_CHUNK_SIZE is 5', () => {
    expect(REASON_MIN_RAW_SCORE).toBe(0);
    expect(CLOUD_SCORE_CHUNK_SIZE).toBe(5);
  });
});

// ===========================================================================
// buildRelevanceCalls / buildReasonCallsForSubset
// ===========================================================================

describe('buildRelevanceCalls', () => {
  it('returns empty calls and empty maps when all candidates are ineligible', async () => {
    const rows = await seedAndLoad(['x'], { title: null, factless: true });
    const result = await buildRelevanceCalls(rows);
    expect(result.calls).toHaveLength(0);
    expect(result.eligibleCandidates).toHaveLength(0);
    expect(result.promptsById.size).toBe(0);
    expect(result.chunkIdToCandidates.size).toBe(0);
  });

  it('builds one BatchCall per chunk of 5 eligible candidates', async () => {
    const rows = await seedAndLoad(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    const result = await buildRelevanceCalls(rows);
    expect(result.calls.map((c) => c.id)).toEqual(['score:0', 'score:1']);
    expect(result.scoreChunkSize).toBe(5);
    expect(result.eligibleCandidates).toHaveLength(7);
    expect(result.calls.map((c) => (c.prompt.match(/<<ARTICLE /g) ?? []).length)).toEqual([5, 2]);
  });

  it('each call carries the relevance prompt, the 0.1 temperature and the 320 token ceiling', async () => {
    const [row] = await seedAndLoad(['a']);
    const { calls } = await buildRelevanceCalls([row]);
    expect(calls[0]).toMatchObject({
      id: 'score:0',
      system: ART.relevanceSystemPrompt,
      temperature: 0.1,
      maxTokens: 320,
    });
    expect(calls[0].prompt).toContain('News Title: Story a sagaa');
  });

  it('promptsById and chunkIdToCandidates are consistently keyed', async () => {
    const rows = await seedAndLoad(['a', 'b']);
    const result = await buildRelevanceCalls(rows);
    expect(result.promptsById.has('score:0')).toBe(true);
    expect(result.chunkIdToCandidates.get('score:0')!.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('puts the whole fact bank in the user context', async () => {
    const [row] = await seedAndLoad(['x']);
    await addFact('Lives in Amsterdam');
    const { calls } = await buildRelevanceCalls([row]);
    expect(calls[0].prompt).toContain('User Context: [User facts] ');
    expect(calls[0].prompt).toContain('I follow Formula 1 racing');
    expect(calls[0].prompt).toContain('Lives in Amsterdam');
  });

  it('writes an empty user-facts line when the bank is empty', async () => {
    const [row] = await seedAndLoad(['a'], { factless: true, headline: 'GLOBAL' });
    const { calls } = await buildRelevanceCalls([row]);
    expect(calls[0].prompt).toContain('User Context: [User facts] .');
  });
});

describe('buildReasonCallsForSubset', () => {
  it('returns empty calls when no candidate exceeds the threshold', async () => {
    const rows = await seedAndLoad(['a', 'b']);
    const result = await buildReasonCallsForSubset(rows, { a: 0.3, b: 0.2 }, 0.3);
    expect(result.calls).toHaveLength(0);
    expect(result.eligibleCandidates).toHaveLength(0);
  });

  it('includes only candidates whose relevance STRICTLY exceeds the threshold', async () => {
    const rows = await seedAndLoad(['a', 'b', 'c']);
    const result = await buildReasonCallsForSubset(rows, { a: 0.5, b: 0.3, c: 0.31 }, 0.3);
    expect(result.calls.map((c) => c.id).sort()).toEqual(['reason:0', 'reason:1']);
  });

  it('skips ineligible candidates (no title)', async () => {
    const rows = await seedAndLoad(['x'], { title: null, factless: true });
    expect((await buildReasonCallsForSubset(rows, { x: 0.9 }, 0)).calls).toHaveLength(0);
  });

  it('each call has the reason: id, the reason prompt, the 96 token ceiling and temperature 0.2', async () => {
    const [row] = await seedAndLoad(['abc']);
    const { calls } = await buildReasonCallsForSubset([row], { abc: 0.7 }, 0.3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: 'reason:0',
      system: ART.reasonSystemPrompt,
      maxTokens: 96,
      temperature: 0.2,
    });
    expect(calls[0].prompt).toContain('Story abc sagaabc');
  });

  it('has no score chunks, and skips candidates missing from relevanceMap', async () => {
    const rows = await seedAndLoad(['a', 'b']);
    const result = await buildReasonCallsForSubset(rows, { a: 0.8 }, 0.3);
    expect(result.chunkIdToCandidates.size).toBe(0);
    expect(result.calls.map((c) => c.id)).toEqual(['reason:0']);
  });
});

// P8: a pure top headline is factless BY DESIGN. Dropping it from these live builders left its
// batch Unscored with no score write, and every later gate pass re-elected it.
describe('P8 - factless headline admission (the live builders)', () => {
  it('buildRelevanceCalls admits a factless headline row', async () => {
    const [h] = await seedAndLoad(['h1'], { factless: true, headline: 'GLOBAL' });
    const result = await buildRelevanceCalls([h]);
    expect(result.eligibleCandidates.map((c) => c.id)).toEqual(['h1']);
    expect(result.calls.length).toBeGreaterThan(0);
    expect(result.calls[0].system).toBe(ART.headlineRelevanceSystemPrompt);
  });

  it('buildReasonCallsForSubset admits a factless headline row that scored', async () => {
    const [h] = await seedAndLoad(['h1'], { factless: true, headline: 'COUNTRY' });
    const result = await buildReasonCallsForSubset([h], { h1: 0.65 }, 0.3);
    expect(result.calls.map((c) => c.id)).toEqual(['reason:0']);
    expect(result.calls[0].system).toBe(ART.headlineReasonSystemPrompt);
  });

  it('still drops a factless row that is NOT headline-sourced', async () => {
    const [orphan] = await seedAndLoad(['o'], { factless: true });
    expect((await buildRelevanceCalls([orphan])).eligibleCandidates).toHaveLength(0);
    expect((await buildReasonCallsForSubset([orphan], { o: 0.9 }, 0.3)).calls).toHaveLength(0);
  });

  it('still drops a headline row with no English text', async () => {
    const [noText] = await seedAndLoad(['h-empty'], { factless: true, headline: 'GLOBAL', description: null });
    expect((await buildRelevanceCalls([noText])).eligibleCandidates).toHaveLength(0);
    expect((await buildReasonCallsForSubset([noText], { 'h-empty': 0.9 }, 0.3)).calls).toHaveLength(0);
  });
});

// ===========================================================================
// batchScoreAndReason
// ===========================================================================

describe('batchScoreAndReason - ineligible candidates', () => {
  it.each([
    ['no title', { title: null }],
    ['no description', { description: null }],
    ['no related facts', { factless: true }],
  ] as const)('assigns INELIGIBLE_RELEVANCE (0.2) for candidates with %s', async (_label, opts) => {
    const [c] = await seedAndLoad(['a'], opts);
    const { scoreMap, failedIds } = await run(batchScoreAndReason([c]));
    expect(scoreMap.get('a')).toBe(0.2);
    expect(failedIds.size).toBe(0);
  });

  it('returns early with no model call on either lane when every candidate is ineligible', async () => {
    const [c] = await seedAndLoad(['a'], { factless: true });
    await run(batchScoreAndReason([c]));
    expect(gatewayCalls()).toHaveLength(0);
    expect(llamaCalls()).toHaveLength(0);
  });
});

describe('batchScoreAndReason - cloud path', () => {
  it('scores through the gateway, then runs the reason pass for survivors', async () => {
    gateway({ scores: { a: 0.75 } });
    const [c] = await seedAndLoad(['a']);

    const { scoreMap, reasonMap, failedIds } = await run(batchScoreAndReason([c]));

    expect(scoreMap.get('a')).toBe(0.75);
    expect(reasonMap.get('a')).toBe('Why story a matters here.');
    expect(failedIds.size).toBe(0);
    // One relevance call, then one reason call. The stage never carries a reason.
    expect(gatewayCalls('batch').map(systemOf)).toEqual([ART.relevanceSystemPrompt, ART.reasonSystemPrompt]);
  });

  it('sends five articles per relevance prompt, the 320 token ceiling and the small model', async () => {
    gateway();
    const sent = watchBatches();
    const rows = await seedAndLoad(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']);

    await run(batchScoreAndReason(rows));

    const calls = gatewayCalls('batch');
    const relevance = calls.filter((c) => systemOf(c) === ART.relevanceSystemPrompt);
    expect(relevance.map(fenceCount)).toEqual([5, 2]);
    expect(calls.every((c) => c.model === SMALL_MODEL)).toBe(true);
    const bodies = await sent();
    const score = bodies.flatMap((b) => b.requests).filter((_r, i) => i < 2);
    expect(score.map((r) => r.max_tokens)).toEqual([320, 320]);
    expect(score.map((r) => r.temperature)).toEqual([0.1, 0.1]);
  });

  it('puts the person\'s facts and the article fences in the prompt, nothing else about the person', async () => {
    gateway();
    const [c] = await seedAndLoad(['a']);
    await run(batchScoreAndReason([c]));

    const [relevance] = gatewayCalls('batch');
    expect(userOf(relevance)).toContain('User Context: [User facts] I follow Formula 1 racing.');
    expect(userOf(relevance)).toContain('News Title: Story a sagaa');
    expect(userOf(relevance)).toContain('Related User Fact: I follow Formula 1 racing');
  });

  it('skips the reason pass when the stage score is below the reason threshold (0.4)', async () => {
    gateway({ scores: { a: 0.25 } });
    const [c] = await seedAndLoad(['a']);

    const { scoreMap, reasonMap } = await run(batchScoreAndReason([c]));

    expect(scoreMap.get('a')).toBe(0.25);
    expect(reasonMap.has('a')).toBe(false);
    expect(gatewayCalls('batch')).toHaveLength(1);
  });

  it('falls back to FALLBACK_RELEVANCE and marks failedIds when the scoring request fails outright', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'bad' } })));
    const [c] = await seedAndLoad(['a']);

    const { scoreMap, failedIds, reasonMap } = await run(batchScoreAndReason([c]));

    expect(failedIds.has('a')).toBe(true);
    expect(scoreMap.get('a')).toBe(0.3);
    expect(reasonMap.size).toBe(0);
  });

  it('falls back to FALLBACK_RELEVANCE when the persona snapshot cannot be read', async () => {
    gateway();
    const [c] = await seedAndLoad(['a']);
    const spy = jest.spyOn(topicService, 'getActive').mockRejectedValueOnce(new Error('db down'));

    const { scoreMap, failedIds } = await run(batchScoreAndReason([c]));
    spy.mockRestore();

    expect(failedIds.has('a')).toBe(true);
    expect(scoreMap.get('a')).toBe(0.3);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('mixes eligible and ineligible candidates correctly', async () => {
    gateway({ scores: { e: 0.6 } });
    const [eligible] = await seedAndLoad(['e']);
    await seed(['i'], { factless: true });
    const ineligible = (await unscored()).find((r) => r.id === 'i')!;

    const { scoreMap } = await run(batchScoreAndReason([eligible, ineligible]));

    expect(scoreMap.get('e')).toBe(0.6);
    expect(scoreMap.get('i')).toBe(0.2);
    // Only the eligible candidate reaches the model.
    expect(gatewayCalls('batch').map(ids).flat()).toEqual(['e', 'e']);
  });

  it('a hard "not interested" filter drops the row before any model call: no score, not failed', async () => {
    gateway();
    await addSuppression({ pattern: 'sagablk', keywords: ['sagablk'], strength: 1, source: 'feedback' });
    const rows = await seedAndLoad(['ok1', 'blk']);

    const { scoreMap, failedIds, excludedIds, excludedValueById } = await run(batchScoreAndReason(rows));

    expect([...excludedIds]).toEqual(['blk']);
    expect(excludedValueById.get('blk')).toBe('sagablk');
    expect(scoreMap.has('blk')).toBe(false);
    expect(scoreMap.get('ok1')).toBe(0.9);
    expect(failedIds.size).toBe(0);
    expect(gatewayCalls('batch').map(ids).flat()).not.toContain('blk');
  });

  it('a pass-2 rescore replaces the pass-1 score', async () => {
    gateway({ scores: { a: 0.9 }, rescores: { a: { k: 'domain', s: 0.62 } } });
    const [c] = await seedAndLoad(['a']);

    const { scoreMap, reasonMap } = await run(batchScoreAndReason([c]));

    expect(scoreMap.get('a')).toBe(0.62);
    expect(reasonMap.get('a')).toBe('Why story a matters here.');
  });
});

describe('batchScoreAndReason - on-device path', () => {
  beforeEach(async () => {
    await useMode('on-device');
  });

  it('scores through Kev, one article per decide, and writes no note inline', async () => {
    installLocal();
    const [c] = await seedAndLoad(['a']);

    const { scoreMap, reasonMap } = await run(batchScoreAndReason([c]));

    expect(scoreMap.get('a')).toBeCloseTo(1, 5);
    expect(reasonMap.size).toBe(0);
    expect(gatewayCalls()).toHaveLength(0);
    expect(decideCalls()).toHaveLength(1);
    expect(llamaCalls()).toHaveLength(0);
  });

  it('a Kev failure marks the row failed, so it is not saved and stays unscored for the next pass', async () => {
    installLocal();
    installDecide({ error: 'native crash' });
    const [c] = await seedAndLoad(['a']);

    const { failedIds } = await run(batchScoreAndReason([c]));

    expect(decideCalls()).toHaveLength(1);
    expect(failedIds.has('a')).toBe(true);
  });

  it('falls back to FALLBACK_RELEVANCE and marks failedIds when the persona snapshot cannot be read', async () => {
    installLocal();
    const [c] = await seedAndLoad(['a']);
    const spy = jest.spyOn(topicService, 'getActive').mockRejectedValueOnce(new Error('local stage failure'));

    const { failedIds, scoreMap } = await run(batchScoreAndReason([c]));
    spy.mockRestore();

    expect(failedIds.has('a')).toBe(true);
    expect(scoreMap.get('a')).toBe(0.3);
    expect(decideCalls()).toHaveLength(0);
  });
});

// ===========================================================================
// runFeedVerifierPass
// ===========================================================================

// Wave 7b cutover: the verifier is absorbed into the judge and `feedVerifierEnabled` ships OFF, so
// the pass returns before it builds a call. The enabled body is covered below by flipping that
// owner flag for those tests only (config, like R27, not behaviour).
describe('runFeedVerifierPass (app shim - second-pass FEED verifier)', () => {
  const scores = () => new Map([['a', 0.9], ['b', 0.6], ['c', 0.2]]);

  it('ships OFF', () => {
    expect(ART.feedVerifierEnabled).toBe(false);
  });

  it('is a no-op while the verifier flag is off: scores unchanged, no model call', async () => {
    server.use(...mockGateway(() => JSON.stringify([{ v: 'no' }, { v: 'no' }, { v: 'no' }])));
    const rows = await seedAndLoad(['a', 'b', 'c']);
    const map = scores();

    const demoted = await run(runFeedVerifierPass(rows, map));

    expect(demoted).toBe(0);
    expect([...map]).toEqual([...scores()]);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('stays a no-op, and silent, when the gateway would have refused the call', async () => {
    server.use(...mockGateway(() => ({ status: 500, body: { error: 'boom' } })));
    const rows = await seedAndLoad(['a']);
    const map = new Map([['a', 0.9]]);

    expect(await run(runFeedVerifierPass(rows, map))).toBe(0);

    expect(map.get('a')).toBe(0.9);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('no FEED candidates leaves the scores alone and asks no model', async () => {
    const rows = await seedAndLoad(['a']);
    const map = new Map([['a', 0.2]]);

    expect(await run(runFeedVerifierPass(rows, map))).toBe(0);

    expect(map.get('a')).toBe(0.2);
    expect(gatewayCalls()).toHaveLength(0);
  });
});

describe('runFeedVerifierPass - flag enabled', () => {
  let flag: { restore(): void };
  beforeEach(() => {
    flag = jest.replaceProperty(ART, 'feedVerifierEnabled', true);
  });
  afterEach(() => flag.restore());

  const isVerify = (call: GatewayCall) => systemOf(call) === ART.feedVerifierSystemPrompt;
  /** One verdict per article of the verifier call, in order. */
  const verdicts = (byId: Record<string, 'yes' | 'no'>): GatewayResponder => (call) =>
    JSON.stringify(ids(call).map((id) => ({ v: byId[id] ?? 'yes' })));

  it('demotes only the articles the verifier explicitly says no to, and never raises one', async () => {
    server.use(...mockGateway(verdicts({ a: 'no', b: 'yes', c: 'no' })));
    const sent = watchBatches();
    const rows = await seedAndLoad(['a', 'b', 'c']);
    const map = new Map([['a', 0.9], ['b', 0.6], ['c', 0.2]]);

    const demoted = await run(runFeedVerifierPass(rows, map));

    expect(demoted).toBe(1);
    // c is below the discard floor, so it is never audited and keeps its score.
    expect([...map]).toEqual([['a', ART.feedVerifierDemoteScore], ['b', 0.6], ['c', 0.2]]);
    const [call] = gatewayCalls('batch');
    expect(isVerify(call)).toBe(true);
    expect(ids(call)).toEqual(['a', 'b']);
    expect((await sent())[0].requests[0].max_tokens).toBe(ART.feedVerifierMaxTokens);
  });

  it('keeps every article when the verifier reply is malformed', async () => {
    server.use(...mockGateway(() => 'not an array'));
    const rows = await seedAndLoad(['a']);
    const map = new Map([['a', 0.9]]);

    expect(await run(runFeedVerifierPass(rows, map))).toBe(0);

    expect(map.get('a')).toBe(0.9);
    expect(gatewayCalls('batch')).toHaveLength(1);
  });

  it('fail-open: a verifier request that fails leaves every score unchanged', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'boom' } })));
    const rows = await seedAndLoad(['a']);
    const map = new Map([['a', 0.9]]);

    expect(await run(runFeedVerifierPass(rows, map))).toBe(0);

    expect(map.get('a')).toBe(0.9);
    expect(logger.warn).toHaveBeenCalledWith('[runFeedVerifierPass] verifier failed — scores unchanged', expect.any(Object));
  });

  it('asks no model for candidates the verifier cannot judge (no related facts)', async () => {
    server.use(...mockGateway(verdicts({})));
    const rows = await seedAndLoad(['a'], { factless: true });

    expect(await run(runFeedVerifierPass(rows, new Map([['a', 0.9]])))).toBe(0);

    expect(gatewayCalls()).toHaveLength(0);
  });
});

// ===========================================================================
// processAllUnscored
// ===========================================================================

describe('processAllUnscored', () => {
  it('returns 0 immediately when there are no unscored suggestions', async () => {
    gateway();
    const onProgress = jest.fn();
    expect(await run(processAllUnscored(onProgress))).toBe(0);
    expect(onProgress).toHaveBeenCalledWith(0, 0);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('reports (0, total) first and (processed, total) last, and writes the scores and reasons back', async () => {
    gateway({ scores: { a: 0.5, b: 0.7 } });
    await seed(['a', 'b']);
    const onProgress = jest.fn();

    expect(await run(processAllUnscored(onProgress))).toBe(2);

    expect(onProgress.mock.calls[0]).toEqual([0, 2]);
    expect(onProgress.mock.calls.at(-1)).toEqual([2, 2]);
    const rows = await stored();
    // Raw 0.5 buckets to LOW (0.4), raw 0.7 to MEDIUM (0.6); the raw score is kept for ordering.
    expect([rows.a.relevance, rows.b.relevance]).toEqual([0.4, 0.6]);
    expect([rows.a.rawScore, rows.b.rawScore]).toEqual([0.5, 0.7]);
    expect(rows.a.reason).toBe('Why story a matters here.');
    expect(rows.b.reason).toBe('Why story b matters here.');
    expect(rows.a.status).toBe('complete');
  });

  it('calls onBatchComplete with the succeeded updates', async () => {
    gateway({ scores: { a: 0.7 } });
    await seed(['a']);
    const onBatchComplete = jest.fn();

    await run(processAllUnscored(undefined, 20, onBatchComplete));

    expect(onBatchComplete).toHaveBeenCalledWith([{ id: 'a', relevance: 0.6, reason: 'Why story a matters here.' }]);
  });

  it('does not call onBatchComplete when every candidate fails, and leaves the rows unscored for the next cycle', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'bad' } })));
    await seed(['a']);
    const onBatchComplete = jest.fn();

    expect(await run(processAllUnscored(undefined, 20, onBatchComplete))).toBe(0);

    expect(onBatchComplete).not.toHaveBeenCalled();
    expect((await stored()).a.status).toBe('unscored');
    expect(logger.warn).toHaveBeenCalledWith(
      '[processAllUnscored] entire batch failed — stopping to retry next cycle',
      expect.objectContaining({ failedCount: 1 }),
    );
  });

  it('returns totalProcessed across multiple batches', async () => {
    gateway({ scores: { a: 0.7, b: 0.6 } });
    await seed(['a', 'b']);

    expect(await run(processAllUnscored(undefined, 1))).toBe(2);

    expect(gatewayCalls('batch').filter((c) => systemOf(c) === ART.relevanceSystemPrompt)).toHaveLength(2);
    const rows = await stored();
    expect([rows.a.status, rows.b.status]).toEqual(['complete', 'complete']);
  });

  it('logs and skips a row whose result cannot be saved, and stops when nothing in the batch succeeded', async () => {
    gateway({ scores: { a: 0.7 } });
    await seed(['a']);
    const save = jest.spyOn(scoringWrites, 'saveScoringResult').mockRejectedValueOnce(new Error('db write error'));
    const onBatchComplete = jest.fn();

    const processed = await run(processAllUnscored(undefined, 20, onBatchComplete));
    save.mockRestore();

    expect(processed).toBe(0);
    expect(onBatchComplete).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      '[processAllUnscored] saveScoringResult failed',
      expect.any(Error),
      { id: 'a' },
    );
  });

  it('reports the failure to Sentry, and still returns the count, when the reason sweep after the loop throws', async () => {
    gateway({ scores: { a: 0.7 } });
    await seed(['a']);
    const sweep = jest.spyOn(suggestionReads, 'getScoredSuggestionsWithoutReasons').mockRejectedValueOnce(new Error('db error'));

    const processed = await run(processAllUnscored());
    sweep.mockRestore();

    expect(processed).toBe(1);
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-service', method: 'processAllUnscored.retry' },
    });
  });

  it('reports the failure to Sentry, and still returns the count, when the subscription-read stage throws', async () => {
    gateway({ scores: { a: 0.7 } });
    await seed(['a']);
    const stage = jest.spyOn(stageSubscriptionRead, 'runSubscriptionReadStage').mockRejectedValueOnce(new Error('db'));

    const processed = await run(processAllUnscored());
    expect(stage).toHaveBeenCalledTimes(1);
    stage.mockRestore();

    expect(processed).toBe(1);
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-service', method: 'processAllUnscored.subscriptionRead' },
    });
  });
});

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

  it('a Kev error about one article leaves that row unscored and ranks the others', async () => {
    installLocal();
    queue();
    installDecide((call) => {
      const id = /Story (\w+) saga/.exec(JSON.stringify(call.request.state))?.[1] ?? '';
      return id === 'b' ? { error: 'failed to evaluate the decision prompt (error 1)' } : { scores: { rel: 3 } };
    });
    await seed(['a', 'b', 'c']);

    expect(await run(processAllUnscored())).toBe(2);

    const rows = await stored();
    expect(rows.b.status).toBe('unscored');
    expect(rows.a.rawScore).toBeCloseTo(1, 5);
    expect(rows.c.rawScore).toBeCloseTo(1, 5);
  });

  // Copies share a story key and nothing else (titles disjoint, no clusters).
  it('Kev reads one copy per story and the others inherit its score and its note', async () => {
    installLocal();
    queue();
    await seed(['a', 'b', 'c'], { extra: { story_key: 'K' } });

    expect(await run(processAllUnscored())).toBe(1);

    expect(events.filter((e) => e.startsWith('decide:'))).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('note:'))).toHaveLength(1);
    const rows = Object.values(await stored());
    expect(new Set(rows.map((r) => `${r.status}|${r.relevance}|${r.reason}`)).size).toBe(1);
    expect(rows[0].status).toBe('complete');
  });

  it('a copy Kev fails on is not elected again in the pass: a sibling is read instead', async () => {
    installLocal();
    queue();
    let failedId: string | null = null;
    installDecide((call) => {
      const id = /Story (\w+) saga/.exec(JSON.stringify(call.request.state))?.[1] ?? '';
      events.push(`decide:${id}`);
      failedId ??= id;
      return id === failedId ? { error: 'failed to evaluate the decision prompt (error 1)' } : { scores: { rel: 3 } };
    });
    await seed(['a', 'b', 'c'], { extra: { story_key: 'K' } });

    await run(processAllUnscored());

    const decided = events.filter((e) => e.startsWith('decide:'));
    expect(decided).toHaveLength(2);
    expect(decided[1]).not.toBe(`decide:${failedId}`);
    const rows = await stored();
    expect(rows[failedId!].status).toBe('unscored');
    expect(Object.values(rows).filter((r) => r.status === 'complete')).toHaveLength(2);
  });

  it('never elects a copy Kev cannot read; a readable copy of the story is read instead', async () => {
    installLocal();
    queue();
    await seed(['s'], { extra: { story_key: 'K' } });
    // Newest, so election would prefer it; no fact and no headline scope.
    await seed(['r'], { factless: true, extra: { story_key: 'K', pubDate: '2026-10-09T09:00:00.000Z' } });

    await run(processAllUnscored());

    expect(events.filter((e) => e.startsWith('decide:'))).toEqual(['decide:s']);
    expect((await stored()).s.rawScore).toBeCloseTo(1, 5);
  });

  // Kev down for a whole pass (it answered none of the batch) is not one bad article: on the
  // owner's phone a whole run kept its math scores, all LOW, and the Sectioned view went empty.
  it('Kev failing on every article of a batch leaves the batch unscored, never on the math score, and the next pass ranks them', async () => {
    installLocal();
    queue();
    installDecide({ error: 'native crash' });
    await seed(['a', 'b', 'c']);

    expect(await run(processAllUnscored())).toBe(0);
    for (const row of Object.values(await stored())) {
      expect(row.status).toBe('unscored');
      expect(row.rawScore ?? null).toBeNull();
    }

    installLocal();
    expect(await run(processAllUnscored())).toBe(3);
    for (const row of Object.values(await stored())) expect(row.rawScore).toBeCloseTo(1, 5);
  });

  // llama.rn errors can echo the prompt (the article and the reader's facts). Each per-article
  // warn is scrubbed; the outage error that leaves scoreWithKev must not carry the raw text up
  // to batchScoreAndReason's warn, which is a Sentry breadcrumb.
  it('a Kev outage logs no article text: the error that leaves the scorer is not the raw llama.rn message', async () => {
    installLocal();
    queue();
    installDecide((call) => {
      const title = /Story \w+ saga\w+/.exec(JSON.stringify(call.request.state))?.[0] ?? '';
      return { error: `bad state near ${title}` };
    });
    await seed(['a', 'b', 'c']);

    expect(await run(processAllUnscored())).toBe(0);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toMatch(/saga/);
  });

  // Every article over n_ctx (a dense non-Latin fact bank) fails with llama_decode's 1 on every
  // pass: that is about the prompts, not a Kev outage, so the rows keep their math scores
  // rather than staying unscored forever.
  it('Kev overflowing its context on every article of a batch leaves them all unscored, never on math scores', async () => {
    installLocal();
    queue();
    installDecide({ error: 'failed to evaluate the decision prompt (error 1)' });
    await seed(['a', 'b', 'c']);

    expect(await run(processAllUnscored())).toBe(0);
    for (const row of Object.values(await stored())) {
      expect(row.status).toBe('unscored');
    }
  });

  it('saves a row below the 0.4 gate as reasonSkipped and writes it no note', async () => {
    installLocal({ levels: { a: 0, b: 3 } });
    queue();
    await seed(['a', 'b']);

    await run(processAllUnscored());

    const rows = await stored();
    expect(rows.a.relevance).toBeLessThan(0.4);
    expect(rows.a.reason ?? '').toBe('');
    expect(rows.a.status).not.toBe('reason_pending');
    expect(events).not.toContain('note:a');
    expect(rows.b.reason).toBe('Local note on story b.');
  });

  it('never pauses the queue for the pass, so a new fact\'s topics are not held behind ranking and notes', async () => {
    installLocal();
    const { pause, resume } = queue();
    await seed(['a']);

    await run(processAllUnscored());

    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('leaves a chat turn\'s pause to that turn', async () => {
    installLocal();
    const { pause, resume } = queue('paused');
    await seed(['a']);

    await run(processAllUnscored());

    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('runs the notes sweep when nothing was unscored', async () => {
    installLocal();
    queue();
    await seedOwed(['a']);

    expect(await run(processAllUnscored())).toBe(0);

    expect((await stored()).a.reason).toBe('Local note on story a.');
  });
});

// The on-device lane catches a failed reason call per candidate and keeps the score. The cloud
// lane sends ONE batch for every survivor and does not catch a request that fails outright, so a
// reason outage throws away a relevance pass that had already succeeded.
describe('processAllUnscored - the reason request fails outright', () => {
  /** Relevance answers, every reason request is refused. */
  function reasonsRefused(): void {
    server.use(
      ...mockGateway((call) =>
        REASON_SYSTEMS.has(systemOf(call)) ? { status: 400, body: { error: 'bad' } } : JSON.stringify(ids(call).map(() => 0.7)),
      ),
    );
  }

  test('keeps the relevance score and leaves the row owed a note', async () => {
    reasonsRefused();
    await seed(['a']);

    expect(await run(processAllUnscored())).toBe(1);

    const row = (await stored()).a;
    expect([row.status, row.relevance]).toEqual(['reason_pending', 0.6]);
  });
});

// A headline-sourced row that lands in the LOW band or below is terminal (`excluded`), never a
// saved suggestion. Non-headline rows are NEVER culled.
describe('processAllUnscored - top-headline cull', () => {
  const headline = (ids: string[], opts: SeedOptions = {}) => seed(ids, { headline: 'COUNTRY', withFact: true, ...opts });

  it('marks a LOW-band headline terminally excluded instead of saving it', async () => {
    gateway({ scores: { h: 0.4 } });
    await headline(['h']);
    const onBatchComplete = jest.fn();

    const processed = await run(processAllUnscored(undefined, 20, onBatchComplete));

    expect(processed).toBe(1);
    const row = (await stored()).h;
    expect([row.status, row.relevance, row.reason]).toEqual(['excluded', 0, '']);
    // No reason tokens spent on a row that is about to be excluded.
    expect(gatewayCalls('batch').filter((c) => REASON_SYSTEMS.has(systemOf(c)))).toHaveLength(0);
    // Counted as handled, and emitted like a discarded row so the store refreshes.
    expect(onBatchComplete).toHaveBeenCalledWith([{ id: 'h', relevance: 0, reason: null }]);
  });

  it('culls a headline scoring below the discard floor too', async () => {
    gateway({ scores: { h: 0.2 } });
    await headline(['h']);

    expect(await run(processAllUnscored())).toBe(1);
    expect((await stored()).h.status).toBe('excluded');
  });

  // The inline stage scores every row with the standard relevance prompt; only the reason pass
  // (and the E2EE builders, which production runs) pick the headline variant.
  it('saves a MEDIUM-band headline normally, with the headline reason prompt', async () => {
    gateway({ scores: { h: 0.6 } });
    await headline(['h']);

    expect(await run(processAllUnscored())).toBe(1);

    const row = (await stored()).h;
    expect([row.status, row.relevance, row.rawScore, row.reason]).toEqual(['complete', 0.6, 0.6, 'Why story h matters here.']);
    expect(gatewayCalls('batch').map(systemOf)).toEqual([ART.relevanceSystemPrompt, ART.headlineReasonSystemPrompt]);
  });

  it('never culls a non-headline row at the same LOW score', async () => {
    gateway({ scores: { a: 0.4 } });
    await seed(['a']);

    expect(await run(processAllUnscored())).toBe(1);

    const row = (await stored()).a;
    expect([row.status, row.relevance, row.rawScore]).toEqual(['complete', 0.4, 0.4]);
  });

  it('leaves a headline whose scoring FAILED retryable, never excluded', async () => {
    // A failed stage hands the row FALLBACK_RELEVANCE (0.3), which sits in the culled band, but a
    // transient failure is not a verdict.
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'bad' } })));
    await headline(['h']);

    expect(await run(processAllUnscored())).toBe(0);
    expect((await stored()).h.status).toBe('unscored');
  });

  it('leaves a factless (ineligible) headline unculled: it was never scored', async () => {
    gateway();
    await seed(['h'], { headline: 'COUNTRY' });

    expect(await run(processAllUnscored())).toBe(1);

    // INELIGIBLE_RELEVANCE (0.2) is below the discard floor, so it persists unbucketed.
    const row = (await stored()).h;
    expect(row.relevance).toBe(0.2);
    expect(row.status).not.toBe('excluded');
  });

  it('culls only the headline half of a mixed batch', async () => {
    gateway({ scores: { h: 0.4, a: 0.4 } });
    await headline(['h']);
    await seed(['a']);

    expect(await run(processAllUnscored())).toBe(2);

    const rows = await stored();
    expect([rows.h.status, rows.a.status]).toEqual(['excluded', 'complete']);
  });
});

// ===========================================================================
// retryMissingReasons
// ===========================================================================

/** Scored rows still owed a note: what a failed first reason attempt leaves behind. */
async function seedOwed(ids: string[], opts: SeedOptions = {}, relevance = 0.7): Promise<void> {
  await seed(ids, opts);
  for (const id of ids) await saveScoringResult(id, { relevance, reason: '', reasonSkipped: false });
}

describe('retryMissingReasons - cloud path', () => {
  it('returns 0 immediately when there are no scored suggestions without reasons', async () => {
    gateway();
    expect(await run(retryMissingReasons())).toBe(0);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('sends one reason call per owed row and stores the note', async () => {
    gateway();
    await seedOwed(['a']);

    expect(await run(retryMissingReasons())).toBe(1);

    const row = (await stored()).a;
    expect([row.status, row.reason]).toEqual(['complete', 'Why story a matters here.']);
    const [call] = gatewayCalls('batch');
    expect(systemOf(call)).toBe(ART.reasonSystemPrompt);
    // The shared reason builder leads with the score; the local one leads with the fact bank.
    expect(userOf(call).startsWith('Relevance Score: 0.7')).toBe(true);
  });

  it('skips candidates missing a title', async () => {
    gateway();
    await seedOwed(['a'], { title: null, factless: true });

    expect(await run(retryMissingReasons())).toBe(0);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('logs a warning but continues when one reason result carries an error', async () => {
    await seedOwed(['a']);
    server.use(http.post(`*${BATCH_PATH}`, () => HttpResponse.json({ results: [{ index: 0, error: { message: 'upstream error' } }] })));

    expect(await run(retryMissingReasons())).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('[retryMissingReasons] cloud reason failed', { id: 'a', error: 'upstream error' });
  });

  it('breaks the loop when every reply is empty, rather than asking the same rows forever', async () => {
    gateway({ notes: { a: '' } });
    await seedOwed(['a']);

    expect(await run(retryMissingReasons())).toBe(0);

    expect(gatewayCalls('batch')).toHaveLength(1);
    expect((await stored()).a.status).toBe('reason_pending');
  });

  it('reports the failure and breaks the loop when the reason request fails outright', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'bad' } })));
    await seedOwed(['a']);

    expect(await run(retryMissingReasons())).toBe(0);

    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-service', method: 'retryMissingReasons' },
    });
  });

  it('logs the error and leaves the row for the next sync when the note cannot be saved', async () => {
    gateway();
    await seedOwed(['a']);
    const save = jest.spyOn(scoringWrites, 'saveReason').mockRejectedValueOnce(new Error('save failed'));

    // The failed write leaves the row owed. It is asked about once per call, so the next sync recovers it.
    expect(await run(retryMissingReasons())).toBe(0);
    save.mockRestore();
    expect(await run(retryMissingReasons())).toBe(1);

    expect(logger.error).toHaveBeenCalledWith('[retryMissingReasons] saveReason failed', expect.any(Error), { id: 'a' });
  });

  it('writes the sentence and the pass-2 score together when the reply carries both', async () => {
    gateway({ rescores: { a: { k: 'domain', s: 0.62 } } });
    await seedOwed(['a']);

    expect(await run(retryMissingReasons())).toBe(1);

    const row = (await stored()).a;
    expect([row.relevance, row.status, row.reason]).toEqual([0.6, 'complete', 'Why story a matters here.']);
  });
});

describe('Skip notes on this phone (D42)', () => {
  beforeEach(async () => {
    await useMode('on-device');
  });

  afterEach(() => {
    useMeraProtocolStore.getState().setSkipNotes(false);
    jest.restoreAllMocks();
  });

  it('off (the default): the same pass writes a note for every row at or above the gate, as before', async () => {
    installLocal({ levels: { a: 3, b: 0 } });
    jest.spyOn(inferenceQueue, 'getState').mockReturnValue('stopped');
    await seed(['a', 'b']);

    expect(await run(processAllUnscored())).toBe(2);

    const rows = await stored();
    expect([rows.a.status, rows.a.reason]).toEqual(['complete', 'Local note on story a.']);
    expect(events.filter((e) => e.startsWith('note:'))).toEqual(['note:a']);
  });

  it('on: one pass, Kev only and no note call; every row complete with its relevance and no note, above the gate too', async () => {
    useMeraProtocolStore.getState().setSkipNotes(true);
    installLocal({ levels: { a: 3, b: 0 } });
    jest.spyOn(inferenceQueue, 'getState').mockReturnValue('stopped');
    await seed(['a', 'b']);

    expect(await run(processAllUnscored())).toBe(2);

    const rows = await stored();
    expect(rows.a.relevance).toBeGreaterThanOrEqual(0.4);
    // `complete`, never `reason_skipped`: the feed shows a complete row, with its chip.
    expect([rows.a.status, rows.a.reason ?? '']).toEqual(['complete', '']);
    expect(rows.b.status).toBe('complete');
    expect(events.filter((e) => e.startsWith('note:'))).toEqual([]);
    expect(onDeviceLlmCalls()).toEqual([]);
    expect(decideCalls()).toHaveLength(2);
  });

  it('on: the sweep finalises rows still owed a note and writes none', async () => {
    installLocal();
    await seedOwed(['a', 'b'], {}, 0.8);
    useMeraProtocolStore.getState().setSkipNotes(true);

    expect(await run(retryMissingReasons())).toBe(0);

    const rows = await stored();
    expect([rows.a.status, rows.b.status]).toEqual(['complete', 'complete']);
    expect(onDeviceLlmCalls()).toHaveLength(0);
  });

  it('turned on mid-sweep: the sweep stops at the next row and leaves the rest owed', async () => {
    installLocal();
    await seedOwed(['top'], {}, 1);
    await seedOwed(['next'], {}, 0.6);
    const save = scoringWrites.saveReason;
    jest.spyOn(scoringWrites, 'saveReason').mockImplementation(async (id, reason) => {
      await save(id, reason);
      useMeraProtocolStore.getState().setSkipNotes(true);
    });

    expect(await run(retryMissingReasons())).toBe(1);

    expect(events).toEqual(['note:top']);
    expect((await stored()).next.status).toBe('reason_pending');
  });

  it('off again: rows at or above the gate finalised without a note are owed one, and the sweep writes them', async () => {
    installLocal();
    await seed(['high', 'low', 'noted']);
    await saveScoringResult('high', { relevance: 0.8, reason: '', reasonSkipped: true });
    await saveScoringResult('low', { relevance: 0.3, reason: '', reasonSkipped: true });
    await saveScoringResult('noted', { relevance: 0.8, reason: 'Already explained, saga noted.', reasonSkipped: false });

    expect(await rependSkippedNotes()).toBe(1);

    let rows = await stored();
    expect(rows.high.status).toBe('reason_pending');
    expect(rows.low.status).toBe('complete');
    expect(rows.noted.status).toBe('complete');

    expect(await run(retryMissingReasons())).toBe(1);
    rows = await stored();
    expect([rows.high.status, rows.high.reason]).toEqual(['complete', 'Local note on story high.']);
  });
});

describe('retryMissingReasons - on-device path', () => {
  beforeEach(async () => {
    await useMode('on-device');
  });

  it('asks the local model for each owed row and stores the note, built with the on-device note prompt', async () => {
    installLocal();
    await seedOwed(['a']);

    expect(await run(retryMissingReasons())).toBe(1);

    expect((await stored()).a.reason).toBe('Local note on story a.');
    expect(gatewayCalls()).toHaveLength(0);
    const calls = onDeviceLlmCalls();
    expect(calls.map(localSystemOf)).toEqual([NOTE_SYSTEM]);
    // The local builder leads with the fact bank so llama.cpp can reuse it across the sweep.
    expect(localUserOf(calls[0]).startsWith('User Context: ')).toBe(true);
  });

  it('fetches every owed row at once and writes the most relevant first', async () => {
    installLocal();
    await seedOwed(['low'], {}, 0.4);
    await seedOwed(['top'], {}, 1);
    await seedOwed(['mid'], {}, 0.6);

    expect(await run(retryMissingReasons(1))).toBe(3);

    expect(events).toEqual(['note:top', 'note:mid', 'note:low']);
  });

  it('writes one note per story and copies it onto the story\'s other copies', async () => {
    installLocal();
    await seedOwed(['a', 'b'], { extra: { story_key: 'K' } });

    expect(await run(retryMissingReasons())).toBe(2);

    expect(events).toEqual(['note:a']);
    const rows = await stored();
    expect([rows.b.status, rows.b.reason]).toEqual(['complete', 'Local note on story a.']);
  });

  it('finalizes a row owed a note below the 0.4 gate instead of writing it one', async () => {
    installLocal();
    await seedOwed(['stale'], {}, 0.3);
    await seedOwed(['kept'], {}, 0.6);

    expect(await run(retryMissingReasons())).toBe(1);

    expect(events).toEqual(['note:kept']);
    const rows = await stored();
    expect(rows.stale.status).not.toBe('reason_pending');
    expect(rows.stale.reason ?? '').toBe('');
  });

  it('skips candidates that cannot be scored (no related facts, not a headline)', async () => {
    installLocal();
    await seedOwed(['a'], { factless: true });

    expect(await run(retryMissingReasons())).toBe(0);
    expect(onDeviceLlmCalls()).toHaveLength(0);
  });

  it('logs a warning but continues when local reason generation throws', async () => {
    installLocal({ notes: { a: { error: 'local error' } } });
    await seedOwed(['a']);

    expect(await run(retryMissingReasons())).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('[writeNotesOnDevice] note failed', expect.objectContaining({ id: 'a' }));
  });

  describe('on the built-in model', () => {
    it('stops the sweep on busy and leaves every remaining row reason_pending', async () => {
      installOnDeviceLlm({ reply: ({ prompt }) => (prompt.includes('Story top saga') ? 'Local note on story top.' : { error: 'ERR_AFM_BUSY' }) });
      await seedOwed(['top'], {}, 1);
      await seedOwed(['mid'], {}, 0.8);
      await seedOwed(['low'], {}, 0.6);

      await run(retryMissingReasons());

      // top answered, mid was busy, low was never asked.
      expect(onDeviceLlmCalls()).toHaveLength(2);
      const rows = await stored();
      expect(rows.mid.status).toBe('reason_pending');
      expect(rows.low.status).toBe('reason_pending');
      expect(logger.warn).not.toHaveBeenCalledWith('[writeNotesOnDevice] note failed', expect.anything());
    });
  });
});

// A note that shares nothing with the article is dropped by saveReason and the row stays owed.
// retryMissingReasons only stops on an EMPTY reply, so a model that keeps answering with an
// ungrounded note is asked about the same row over and over.
describe('retryMissingReasons - an ungrounded note', () => {
  const UNGROUNDED = 'Volcanic eruptions threaten Iceland tourism.';

  /** An ungrounded reply, and a refusal after `limit` asks so the loop in the app can end. */
  function ungroundedUntil(limit: number): () => number {
    let asked = 0;
    server.use(
      ...mockGateway(() => {
        asked += 1;
        return asked > limit ? { status: 400, body: { error: 'stop' } } : UNGROUNDED;
      }),
    );
    return () => asked;
  }

  test('asks about an owed row once per sweep, then leaves it for the next sync', async () => {
    const asked = ungroundedUntil(4);
    await seedOwed(['a']);

    await run(retryMissingReasons());

    expect(asked()).toBe(1);
  });
});
