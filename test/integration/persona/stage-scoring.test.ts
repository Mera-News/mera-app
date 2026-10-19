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
import * as calibrationService from '@/lib/database/services/calibration-service';
import { restoreScoringOverrides } from '@/lib/database/services/calibration-service';
import database from '@/lib/database';
import type FactModel from '@/lib/database/models/Fact';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import { upsertLocation } from '@/lib/database/services/location-service';
import { upsertPreference, upsertScopePreference } from '@/lib/database/services/publication-preference-service';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { addSuppression, getAll as getAllSuppressions, retireSuppression, type AddSuppressionInput } from '@/lib/database/services/suppression-service';
import * as subscriptionService from '@/lib/database/services/user-publication-subscription-service';
import { getSubscribedCoverageForArticle } from '@/lib/database/services/subscribed-sibling-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { ProcessingMode, type ArticleWithClusters } from '@/lib/generated/graphql-types';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { resetInferenceStats } from '@/lib/mera-protocol-toolkit/core/inference-stats';
import logger from '@/lib/logger';
import { KEV_QUESTIONS } from '@/lib/mera-protocol/kev-relevance';
import { buildReasonCallsForSubset, buildRelevanceCalls } from '@/lib/mera-protocol/scoring-service';
import {
  buildStageCandidates,
  computeAndScoreForCandidates,
  computeMathStage,
  effectiveHarnessConfig,
  getScoringLlmPort,
  loadPersonaScoringContext,
} from '@/lib/mera-protocol/stage-scoring';
import { runSubscriptionReadStage } from '@/lib/mera-protocol/stage-subscription-read';
import { ARTICLE_METADATA_PREFIX } from '@/lib/news-harness/article-pipeline/tag-prompt';
import {
  DEFAULT_HARNESS_CONFIG,
  type ArticlePipelineConfig,
} from '@/lib/news-harness/core/config';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
  type GatewayCall,
  type GatewayResponder,
} from '@/test/helpers';
import { decideCalls, installDecide, installLlama, llamaCalls } from '@/test/helpers/llama';
import { resetFileSystem } from '@/test/helpers/fs';
import { resetChatModules } from '@/test/integration/chat/_helpers';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);

jest.setTimeout(30_000);

const ART = DEFAULT_HARNESS_CONFIG.articlePipeline;
const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;
const CHAT_PATH = '/v1/chat/completions';

// --- world -----------------------------------------------------------------

const mode = (m: 'cloud' | 'on-device') =>
  useMeraProtocolStore.getState().setProcessingMode(m === 'cloud' ? ProcessingMode.Cloud : ProcessingMode.OnDevice);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  resetInferenceStats();
  await disposeModel();
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

const suppress = (input: Omit<AddSuppressionInput, 'source'>) => addSuppression({ ...input, source: 'feedback' });

beforeEach(() => {
  topic = null;
});

// --- scripted models -------------------------------------------------------

const userOf = (call: GatewayCall) => call.messages.find((m) => m.role === 'user')?.content ?? '';
const systemOf = (call: GatewayCall) => call.messages.find((m) => m.role === 'system')?.content ?? '';

/** Cloud: a score of `score` for every article fence of a relevance call. */
function scoreAll(score: number): GatewayResponder {
  return (call) => JSON.stringify(Array((userOf(call).match(/<<ARTICLE /g) ?? []).length || 1).fill(score));
}

// ===========================================================================
// on-device relevance runs through Kev
// ===========================================================================

describe('on-device relevance - Kev', () => {
  beforeEach(() => mode('on-device'));

  it('asks Kev one question per article and makes no completion', async () => {
    installLlama([]);
    installDecide({ scores: { rel: 3 } });
    const cs = await seedAndLoad(['a', 'b']);

    const stage = await run(computeAndScoreForCandidates(cs));

    expect(decideCalls()).toHaveLength(2);
    expect(llamaCalls()).toHaveLength(0);
    // Kev's top level is relevance 1 before the shared penalties.
    expect(stage.rawScoreMap.get('a')).toBeCloseTo(1, 5);
    expect(stage.rawScoreMap.get('b')).toBeCloseTo(1, 5);
  });

  it('sends the decided request: the question, the whole fact bank and a 500-char description', async () => {
    installLlama([]);
    await addFact('Lives in Hoorn');
    const cs = await seedAndLoad(['a'], { description: 'x'.repeat(900) });

    await run(computeAndScoreForCandidates(cs));

    const { request } = decideCalls()[0];
    expect(request.questions).toEqual(KEV_QUESTIONS);
    const state = request.state as { reader: string[]; article: { title: string; description: string } };
    expect(state.reader).toContain('Lives in Hoorn');
    expect(state.article.title).toBe('Story a saga' + 'a');
    expect(state.article.description).toHaveLength(500);
    expect(state.article).not.toHaveProperty('country');
  });

  it('calibrates the level: 0 is far below the 0.4 gate, 2 of 3 lands above it', async () => {
    installLlama([]);
    installDecide((call) => ({ scores: { rel: String(JSON.stringify(call.request.state)).includes('Story low') ? 0 : 2 } }));
    const cs = [...(await seedAndLoad(['low'], { title: 'Story low' })), ...(await seedAndLoad(['mid']))];

    const stage = await run(computeAndScoreForCandidates(cs));

    expect(stage.rawScoreMap.get('low')).toBe(0);
    expect(stage.rawScoreMap.get('mid')).toBeGreaterThan(0.4);
  });

  it('a Kev failure leaves the math score standing and logs the id and error class only', async () => {
    installLlama([]);
    installDecide({ error: 'secret persona text in the message' });
    const [c] = await seedAndLoad(['a']);

    const stage = await run(computeAndScoreForCandidates([c]));

    expect(stage.rawScoreMap.get('a')).toBe(stage.computedScoreMap.get('a'));
    expect(logger.warn).toHaveBeenCalledWith('kev_decide_failed', { id: 'a', error: 'Error' });
  });

  it('is the cloud port in cloud mode', async () => {
    installLlama([]); // sets on-device; the mode under test comes after it
    mode('cloud');
    server.use(...mockGateway(() => '[0.5]'));

    const [res] = await run(getScoringLlmPort().batchComplete([{ id: 'score:0', system: 's', prompt: 'p', maxTokens: 24, temperature: 0.1 }], {}));

    expect(res.output).toBe('[0.5]');
    expect(gatewayCalls('batch')).toHaveLength(1);
    expect(llamaCalls()).toHaveLength(0);
  });

  it('the local port still completes a single prompt as JSON (the subscription read)', async () => {
    installLlama(['{"ok":true}']);

    const out = await run(getScoringLlmPort().complete({ systemPrompt: 's', prompt: 'p', maxTokens: 10, temperature: 0 }));

    expect(out).toBe('{"ok":true}');
    expect(llamaCalls()[0].params.response_format).toEqual({ type: 'json_object' });
  });
});

// ===========================================================================
// loadPersonaScoringContext
// ===========================================================================

describe('loadPersonaScoringContext - persona snapshot seam', () => {
  it('reads topics, locations, preferences, suppressions and OPENS-ONLY story history', async () => {
    const fact = await addFact('Family lives in Bhopal');
    // No service writes a non-default fact weight: the model update is the only way to set one.
    await database.write(async () => {
      await (await database.get<FactModel>('facts').find(fact.id)).update((f) => {
        f.weight = 0.5;
      });
    });
    const [t] = await createTopics([{ factId: fact.id, text: 'bhopal', weight: 0.8 }]);
    await upsertLocation({ city: 'Bhopal', region: 'Madhya Pradesh', countryCode: 'in', role: 'family', weight: 1 });
    await upsertPreference({ publicationName: 'Fav Times', weight: 0.5 });
    await suppress({ pattern: 'celebrity gossip', keywords: ['celebrity gossip'], strength: 0.5 });
    await recordOpen({ articleId: 'opened-article', stableClusterId: 'stable-story-1', surface: 'feed' });

    const { persona, topicWeights } = await loadPersonaScoringContext(1_700_000_000_000);

    // seen = opens only: the article id and its stable cluster id.
    expect(persona.seenStoryIds).toEqual(new Set(['opened-article', 'stable-story-1']));
    // entityInterest is deliberately NOT wired yet (entityComp reads 0).
    expect(persona.entityInterest).toBeUndefined();
    expect(topicWeights.get(t.id)).toEqual({
      effectiveWeight: 0.4, // 0.8 topic x 0.5 fact weight
      highPriority: false,
      locationId: undefined,
    });
    expect(persona.locations[0]).toMatchObject({ city: 'bhopal', countryCode: 'IN' }); // normalised
    expect(persona.pubPrefs.get('fav times')).toBe(0.5);
    expect(persona.softSuppressions).toHaveLength(1);
    expect(persona.softSuppressions[0]).toMatchObject({ keywords: ['celebrity gossip'], strength: 0.5 });
    expect(persona.hardSuppressions).toEqual([]);
  });

  it('drops an expired travel window and keeps the rest', async () => {
    const now = 1_700_000_000_000;
    await upsertLocation({ city: 'Lisbon', countryCode: 'PT', role: 'travel', validUntil: now - 1 });
    await upsertLocation({ city: 'Hoorn', countryCode: 'NL', role: 'home' });

    const { persona } = await loadPersonaScoringContext(now);

    expect(persona.locations.map((l) => l.city)).toEqual(['hoorn']);
  });

  it('clamps a topic weight times a fact weight into [-1, 1], and keeps a topic with no fact at weight x 1', async () => {
    const [t] = await createTopics([{ factId: null, text: 'standalone', weight: 0.7 }]);

    const { topicWeights } = await loadPersonaScoringContext();

    expect(topicWeights.get(t.id)?.effectiveWeight).toBe(0.7);
  });

  it('derives a hard publication filter from a muted source, and ignores a muted country scope', async () => {
    await upsertPreference({ publicationName: 'Gossip Weekly', weight: -1 });
    await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'India', weight: -1 });

    const { persona } = await loadPersonaScoringContext();

    expect(persona.hardSuppressions).toHaveLength(1);
    expect(persona.hardSuppressions![0]).toMatchObject({ kind: 'publication', value: 'gossip weekly', strength: 1 });
    // A scope is a render-time preference: its label never reaches the publication weights either.
    expect(persona.pubPrefs.has('india')).toBe(false);
  });
});

// The one place the "entity can never exclude" rule is enforced for every consumer of the
// snapshot at once (the scoring stage, the E2EE pipeline, and the suppression sweep).
describe('loadPersonaScoringContext - entity filters are never HARD', () => {
  it('files a full-strength ENTITY filter as SOFT', async () => {
    await suppress({ pattern: 'nvidia', strength: 1, kind: 'entity', value: 'nvidia' });

    const { persona } = await loadPersonaScoringContext();

    expect(persona.hardSuppressions).toEqual([]);
    expect(persona.softSuppressions).toHaveLength(1);
    expect(persona.softSuppressions[0]).toMatchObject({ kind: 'entity', value: 'nvidia' });
  });

  it('still files a full-strength PLACE filter as HARD', async () => {
    await suppress({ pattern: 'taipei', strength: 1, kind: 'place', value: 'taipei' });

    const { persona } = await loadPersonaScoringContext();

    expect(persona.softSuppressions).toEqual([]);
    expect(persona.hardSuppressions).toHaveLength(1);
    expect(persona.hardSuppressions![0]).toMatchObject({ kind: 'place' });
  });

  it('a hard KEYWORD filter with no keywords falls back to its human pattern', async () => {
    await suppress({ pattern: '  crypto  ', keywords: [], strength: 1 });

    const { persona } = await loadPersonaScoringContext();

    expect(persona.hardSuppressions![0].keywords).toEqual(['crypto']);
  });
});

// ===========================================================================
// effectiveHarnessConfig - relevance v4 comes from the harness defaults only
// ===========================================================================

describe('effectiveHarnessConfig - relevance v4 comes from the harness defaults only', () => {
  it('hands back the DEFAULT_HARNESS_CONFIG REFERENCE when nothing overrides it (no allocation)', async () => {
    expect(await effectiveHarnessConfig()).toBe(DEFAULT_HARNESS_CONFIG);
  });

  it('ships v4 OFF: both tag features are false in the defaults', () => {
    expect(ART.legacyTagPromptEnabled).toBe(false);
    expect(ART.legacyTagReasonGateEnabled).toBe(false);
  });

  it('a stored ON from the removed settings row no longer turns v4 on', async () => {
    // The store has no such field any more; a stale value on the device must change nothing.
    useMeraProtocolStore.setState({ relevanceV4: true } as never);

    const cfg = await effectiveHarnessConfig();

    expect(cfg).toBe(DEFAULT_HARNESS_CONFIG);
    expect(cfg.articlePipeline.legacyTagPromptEnabled).toBe(false);
    expect(cfg.articlePipeline.legacyTagReasonGateEnabled).toBe(false);
  });

  it('layers the calibration overrides on the engine only', async () => {
    await restoreScoringOverrides({ W_TOPIC: 0.1 });

    const cfg = await effectiveHarnessConfig();

    expect(cfg.articlePipeline).toBe(DEFAULT_HARNESS_CONFIG.articlePipeline);
    expect(cfg.scoringEngine.W_TOPIC).toBeCloseTo(ENG.W_TOPIC * 1.1, 6);
  });

  it('FAILS OPEN to DEFAULT_HARNESS_CONFIG when the overrides read throws', async () => {
    const spy = jest.spyOn(calibrationService, 'getScoringOverrides').mockRejectedValueOnce(new Error('db down'));

    const cfg = await effectiveHarnessConfig();
    spy.mockRestore();

    expect(cfg).toBe(DEFAULT_HARNESS_CONFIG);
  });
});

// The live builders take the effective articlePipeline config; v4 is only ever that object's two
// flags, which flip together by OTA. Passing an explicit ON config shows both features engage.
describe('relevance v4 - the live builders', () => {
  const V4_ON: ArticlePipelineConfig = { ...ART, legacyTagPromptEnabled: true, legacyTagReasonGateEnabled: true };
  const tagged = {
    extra: {
      event_type: 'policy_change',
      geo_tags: [{ city: 'Amsterdam', countryCode: 'NLD' }],
      entities: ['European Commission'],
    },
  };

  it('ADD 1 OFF: the prompt carries no metadata block, with the shipped defaults or none passed', async () => {
    const [c] = await seedAndLoad(['a0'], tagged);
    const byDefault = await buildRelevanceCalls([c]);
    const explicit = await buildRelevanceCalls([c], ART);
    expect(byDefault.calls[0].prompt).not.toContain(ARTICLE_METADATA_PREFIX);
    expect(explicit.calls[0].prompt).not.toContain(ARTICLE_METADATA_PREFIX);
  });

  it('ADD 1 ON: the metadata block is injected into the call the app sends', async () => {
    const [c] = await seedAndLoad(['a0'], tagged);
    const bundle = await buildRelevanceCalls([c], V4_ON);
    expect(bundle.calls[0].prompt).toContain(ARTICLE_METADATA_PREFIX);
    expect(bundle.calls[0].prompt).toContain('European Commission');
  });

  it('ADD 2 OFF: every above-threshold row gets a reason call, nothing is demoted', async () => {
    await seed(['g0', 'k0']);
    // `crime` is in the shipped legacyTagReasonGateEventTypes; the gate reads the row's event type.
    await tagEventType('g0', 'crime');
    await tagEventType('k0', 'policy_change');
    const both = await load(['g0', 'k0']);

    const bundle = await buildReasonCallsForSubset(both, { g0: 0.8, k0: 0.8 }, 0.4, false, ART);

    expect(bundle.calls.map((c) => c.id).sort()).toEqual(['reason:0', 'reason:1']);
    expect(bundle.tagGatedDemoteIds ?? []).toEqual([]);
  });

  it('ADD 2 ON: the gated event type loses its call AND is returned for demotion', async () => {
    await seed(['g0', 'k0']);
    await tagEventType('g0', 'crime');
    await tagEventType('k0', 'policy_change');
    const both = await load(['g0', 'k0']);

    const bundle = await buildReasonCallsForSubset(both, { g0: 0.8, k0: 0.8 }, 0.4, false, V4_ON);

    expect(bundle.calls.map((c) => c.id)).toEqual(['reason:0']);
    // Skipping the call WITHOUT demoting would leave the row with no note forever.
    expect(bundle.tagGatedDemoteIds).toEqual(['g0']);
  });

  it('ADD 2 DEFAULTS to the shipped literal when no config is passed', async () => {
    await seed(['g0', 'k0']);
    await tagEventType('g0', 'crime');
    const both = await load(['g0', 'k0']);

    const bundle = await buildReasonCallsForSubset(both, { g0: 0.8, k0: 0.8 }, 0.4);

    expect(bundle.calls).toHaveLength(2);
  });
});

async function tagEventType(id: string, eventType: string): Promise<void> {
  const row = await database.get<ArticleSuggestionModel>('article_suggestions').find(id);
  await database.write(async () => {
    await row.update((r) => {
      r.eventType = eventType;
    });
  });
}

// ===========================================================================
// buildStageCandidates - the engine sees the server tags
// ===========================================================================

// buildStageCandidates is the ONE place a persisted row becomes an engine input. It used to blank
// geoTags / entities / eventType, which left the event_type / entity / place "not interested"
// filters the feedback surface creates unable to match anything.
describe('buildStageCandidates - the engine sees the server tags', () => {
  const tagged = {
    extra: {
      event_type: 'crime',
      entities: ['european commission'],
      geo_tags: [{ city: 'brussels', countryCode: 'BEL' }],
    },
    title: 'Commission opens antitrust case',
    description: 'Brussels probe',
  };

  it('passes geoTags / entities / eventType through unblanked', async () => {
    const [c] = await seedAndLoad(['a0'], tagged);

    const [stage] = buildStageCandidates([c], new Map());

    expect(stage.input.eventType).toBe('crime');
    expect(stage.input.entities).toEqual(['european commission']);
    expect(stage.input.geoTags).toEqual([{ city: 'brussels', region: undefined, countryCode: 'BEL' }]);
    expect(stage.legacy).toBe(c);
  });

  it("a user's event_type filter now screens the row out", async () => {
    await suppress({ pattern: 'crime', strength: 1, kind: 'event_type', value: 'crime' });
    const [c] = await seedAndLoad(['a0'], tagged);

    const res = await computeMathStage([c]);

    expect([...res.excludedIds]).toEqual(['a0']);
    expect(res.stage).toEqual([]);
  });

  it('a row with no persisted metadata still builds an input and routes to the backstop', () => {
    const bare: ScoringCandidate = {
      id: 'bare',
      titleEn: 'T',
      descriptionEn: 'D',
      countryCode: 'NLD',
      userTopicIds: [],
      relatedFacts: [],
    };

    const [stage] = buildStageCandidates([bare], new Map());

    expect(stage.input).toMatchObject({ id: 'bare', geoTags: [], entities: [], eventType: null, headlineScope: null });
  });
});

// ===========================================================================
// computeMathStage - the E2EE pipeline's own hard screen (call site 2 of 3)
// ===========================================================================

describe('computeMathStage - hard screen', () => {
  // This path never enters computeAndScore, so it is a SEPARATE convergence point for the same
  // matcher: miss it and the exemption holds inline but not on the deferred-judge path, which is
  // the path production runs.
  const GPU = {
    title: 'Nvidia unveils a new GPU',
    description: 'The chipmaker announced it in Taipei.',
    publication: 'The Verge',
    extra: { event_type: 'business', category: 'technology', maxClusterSize: 40 },
  };
  const NOW_MS = Date.parse('2026-10-09T09:00:00.000Z');
  const RENDER_GATE = 0.3;

  beforeEach(async () => {
    await suppress({ pattern: 'nvidia', keywords: ['nvidia'], strength: 1 });
  });

  it('drops the normal row and keeps the headline row in the scored stage', async () => {
    await seed(['normal'], GPU);
    await seed(['head'], { ...GPU, headline: 'GLOBAL' });

    const res = await computeMathStage(await load(['normal', 'head']), NOW_MS);

    expect([...res.excludedIds]).toEqual(['normal']);
    expect(res.excludedValueById.get('normal')).toBe('nvidia');
    expect(res.stage.map((c) => c.input.id)).toEqual(['head']);
  });

  it('reports the kept row so the caller can label it, and scores it demoted', async () => {
    await seed(['head'], { ...GPU, headline: 'GLOBAL' });

    const res = await computeMathStage(await load(['head']), NOW_MS);

    expect(res.exemptedValueById.get('head')).toBe('nvidia');
    expect(res.componentsMap.get('head')!.hardFilterExempt).toBe(true);
    const score = res.computedScoreMap.get('head')!;
    expect(score).toBeGreaterThan(RENDER_GATE);
    // Demoted to the bare floor: the unfiltered row would also earn the pop lift.
    expect(score).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR, 10);
  });

  it('leaves the headline untouched when it matches no hard filter', async () => {
    await seed(['head'], { ...GPU, title: 'AMD ships a GPU', description: 'In Austin.', headline: 'GLOBAL' });

    const res = await computeMathStage(await load(['head']), NOW_MS);

    expect(res.exemptedValueById.size).toBe(0);
    expect(res.computedScoreMap.get('head')!).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR + ENG.HEADLINE_POP_LIFT, 10);
  });

  it('changes nothing when the user has no hard filters', async () => {
    for (const s of await getAllSuppressions()) await retireSuppression(s.id);
    await seed(['normal'], GPU);
    await seed(['head'], { ...GPU, headline: 'GLOBAL' });

    const res = await computeMathStage(await load(['normal', 'head']), NOW_MS);

    expect(res.excludedIds.size).toBe(0);
    expect(res.exemptedValueById.size).toBe(0);
    expect(res.stage).toHaveLength(2);
  });
});

// The tags the engine now sees also feed the math score, which stands when a model call fails,
// and the soft "shown less" penalty. Pinned as a property rather than left as a surprise.
describe('computeMathStage - tag-based filters and the tag-sensitive fail-open score', () => {
  const TAGS = {
    extra: {
      event_type: 'crime',
      entities: ['european commission'],
      geo_tags: [{ city: 'brussels', countryCode: 'BEL' }],
    },
    title: 'Commission opens antitrust case',
    description: 'Brussels probe',
  };

  it('the SOFT penalty is non-zero for a tag-only filter set; the entity share is reported separately', async () => {
    await suppress({ pattern: 'crime', strength: 0.5, kind: 'event_type', value: 'crime' });
    await suppress({ pattern: 'ec', strength: 0.5, kind: 'entity', value: 'european commission' });
    await suppress({ pattern: 'brussels', strength: 0.5, kind: 'place', value: 'brussels' });
    const [c] = await seedAndLoad(['a0'], TAGS);

    const res = await computeMathStage([c]);

    const comps = res.componentsMap.get('a0')!;
    expect(res.excludedIds.size).toBe(0);
    expect(comps.suppressPenalty).toBeCloseTo(2 * ENG.P_SUP * 0.5, 10);
    expect(comps.entityPenalty).toBeCloseTo(ENG.P_SUP * 0.5, 10);
  });

  it('the HARD screen drops a row on a tag-based filter alone (event type and place)', async () => {
    await suppress({ pattern: 'brussels', strength: 1, kind: 'place', value: 'brussels' });
    const [c] = await seedAndLoad(['a0'], TAGS);

    const res = await computeMathStage([c]);

    expect([...res.excludedIds]).toEqual(['a0']);
  });

  it('an untagged article is matched only on its TEXT: a tag filter does not match it', async () => {
    await suppress({ pattern: 'crime', strength: 1, kind: 'event_type', value: 'crime' });
    await suppress({ pattern: 'brussels', strength: 1, kind: 'place', value: 'brussels' });
    const [c] = await seedAndLoad(['u0'], { title: 'A quiet day in Utrecht', description: 'Nothing happened' });

    const res = await computeMathStage([c]);

    expect(res.excludedIds.size).toBe(0);
  });

  it('a tagged article scores higher than the same article untagged when the tag matches a place the person lives', async () => {
    await upsertLocation({ city: 'Brussels', countryCode: 'BEL', role: 'home', weight: 1 });
    const base = { title: 'Something in Brussels', description: 'A policy change' };
    await seed(['tagged'], { ...base, extra: { geo_tags: [{ city: 'brussels', countryCode: 'BEL' }] } });
    await seed(['plain'], base);

    const res = await computeMathStage(await load(['tagged', 'plain']));

    expect(res.componentsMap.get('tagged')!.geoComp).toBeGreaterThan(0);
    expect(res.computedScoreMap.get('tagged')!).toBeGreaterThan(res.computedScoreMap.get('plain')!);
  });

  it('eventComp and entityComp stay 0 without persona interest in them', async () => {
    const [c] = await seedAndLoad(['a0'], { ...TAGS, extra: { event_type: 'policy_change', entities: ['european commission'] } });

    const res = await computeMathStage([c]);

    expect(res.componentsMap.get('a0')!.entityComp).toBe(0);
  });

  it('the v4 flags do not change what a filter matches: suppression comes from the engine config', async () => {
    await suppress({ pattern: 'crime', strength: 0.5, kind: 'event_type', value: 'crime' });
    const [c] = await seedAndLoad(['a0'], TAGS);

    const before = (await computeMathStage([c])).componentsMap.get('a0')!.suppressPenalty;
    const V4_ON = { ...ART, legacyTagPromptEnabled: true, legacyTagReasonGateEnabled: true };
    expect(V4_ON.legacyTagPromptEnabled).toBe(true);
    const after = (await computeMathStage([c])).componentsMap.get('a0')!.suppressPenalty;

    expect(after).toBe(before);
  });
});

describe('computeAndScoreForCandidates', () => {
  it('skipLlm lets every math score stand and makes no model call', async () => {
    server.use(...mockGateway(scoreAll(0.9)));
    const [c] = await seedAndLoad(['a']);

    const stage = await run(computeAndScoreForCandidates([c], { skipLlm: true }));

    expect(stage.rawScoreMap.get('a')).toBe(stage.computedScoreMap.get('a'));
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('screens a hard-filtered row out before the model, and scores the rest through the gateway', async () => {
    server.use(...mockGateway(scoreAll(0.9)));
    await suppress({ pattern: 'sagablk', keywords: ['sagablk'], strength: 1 });
    const rows = await seedAndLoad(['ok1', 'blk']);

    const stage = await run(computeAndScoreForCandidates(rows));

    expect([...stage.excludedIds]).toEqual(['blk']);
    expect(stage.rawScoreMap.get('ok1')).toBe(0.9);
    expect(stage.rawScoreMap.has('blk')).toBe(false);
    expect((userOf(gatewayCalls('batch')[0]).match(/<<ARTICLE /g) ?? []).length).toBe(1);
  });

  it('a soft filter lowers the model score by the same penalty the math carries', async () => {
    server.use(...mockGateway(scoreAll(0.9)));
    await suppress({ pattern: 'saga', keywords: ['sagaa'], strength: 0.5 });
    const [c] = await seedAndLoad(['a']);

    const stage = await run(computeAndScoreForCandidates([c]));

    expect(stage.rawScoreMap.get('a')).toBeCloseTo(0.9 - ENG.P_SUP * 0.5, 6);
  });
});

// ===========================================================================
// runSubscriptionReadStage
// ===========================================================================

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

  /** Chat replies in order; one raw body per chat call is captured. */
  function chatReplies(...replies: ReturnType<GatewayResponder>[]): { bodies: Promise<{ temperature: number }>[] } {
    const bodies: Promise<{ temperature: number }>[] = [];
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === CHAT_PATH) bodies.push(request.clone().json());
    });
    let i = 0;
    server.use(...mockGateway(() => replies[Math.min(i++, replies.length - 1)]));
    return { bodies };
  }

  const stamp = async (id: string) => {
    const row = await database.get<ArticleSuggestionModel>('article_suggestions').find(id);
    return { at: row.subscriptionReadAt, read: row.subscriptionRead };
  };

  async function seedStory(anchors: string[] = ['anchor']) {
    await seed(['sib'], SIBLING);
    // Newest first is the read order, and the sibling is a candidate too (it just has no sibling of its own).
    jest.setSystemTime(Date.now() + 1_000);
    await seed(anchors, ANCHOR);
  }

  // The overwhelmingly common case. It must cost nothing.
  it('exits immediately and asks no model when nothing is subscribed', async () => {
    chatReplies('A read.');
    await seedStory();

    expect(await run(runSubscriptionReadStage())).toBe(0);

    expect(gatewayCalls()).toHaveLength(0);
    expect((await stamp('anchor')).at).toBeNull();
  });

  it('writes a read for a row with a subscribed sibling', async () => {
    chatReplies('Focuses on the coalition talks rather than the farmers.');
    await subscribe();
    await seedStory();

    expect(await run(runSubscriptionReadStage())).toBe(1);

    expect((await getSubscribedCoverageForArticle('anchor'))?.read).toBe('Focuses on the coalition talks rather than the farmers.');
    expect((await stamp('anchor')).at).not.toBeNull();
  });

  it('does nothing for a row with no subscribed sibling', async () => {
    chatReplies('A read.');
    await subscribe();
    await seed(['anchor'], { ...ANCHOR, stableClusterId: 'lonely' });
    await seed(['sib'], SIBLING);

    expect(await run(runSubscriptionReadStage())).toBe(0);

    expect(gatewayCalls()).toHaveLength(0);
    expect((await stamp('anchor')).at).toBeNull();
  });

  // A SKIP is a real answer and must be stamped, or the row is re-asked on every sync for the
  // rest of its 48 hours.
  it.each([
    ['SKIP', 'a SKIP'],
    ['   ', 'an empty model response'],
  ])('stamps %j (%s) so the row is never re-asked, but counts no read', async (reply) => {
    chatReplies(reply);
    await subscribe();
    await seedStory();

    expect(await run(runSubscriptionReadStage())).toBe(0);

    const first = await stamp('anchor');
    expect(first.at).not.toBeNull();
    expect(first.read).toBe('');
    await run(runSubscriptionReadStage());
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('skips rows that already carry a read timestamp', async () => {
    chatReplies('A read.');
    await subscribe();
    await seedStory();
    await run(runSubscriptionReadStage());

    expect(await run(runSubscriptionReadStage())).toBe(0);
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('honours the per-run cap', async () => {
    chatReplies('A read.');
    await subscribe();
    await seedStory(['a', 'b', 'c']);

    expect(await run(runSubscriptionReadStage(2))).toBe(2);
    expect(gatewayCalls('chat')).toHaveLength(2);
  });

  // One bad row must not cost the whole pass.
  it('continues past a row whose model call throws', async () => {
    chatReplies({ status: 400, body: { error: 'boom' } }, 'A read.');
    await subscribe();
    await seedStory(['a', 'b']);

    expect(await run(runSubscriptionReadStage())).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith('[subscription-read] one row failed, continuing', expect.any(Object));
  });

  // This runs on the sync path. It must never throw upward.
  it('returns 0 rather than throwing when the whole stage fails', async () => {
    const spy = jest.spyOn(subscriptionService, 'getSubscribedSourceNameSet').mockRejectedValueOnce(new Error('db gone'));

    await expect(run(runSubscriptionReadStage())).resolves.toBe(0);
    spy.mockRestore();

    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'stage-subscription-read', method: 'runSubscriptionReadStage' },
    });
  });

  it('reads on the on-device model when the person runs on device, with no gateway call', async () => {
    mode('on-device');
    installLlama(['Leads with the coalition talks.']);
    await subscribe();
    await seedStory();

    expect(await run(runSubscriptionReadStage())).toBe(1);

    expect(gatewayCalls()).toHaveLength(0);
    expect(llamaCalls()).toHaveLength(1);
    expect((await stamp('anchor')).read).toBe('Leads with the coalition talks.');
  });

  describe('the prompt', () => {
    let call: GatewayCall;
    let body: { temperature: number };

    beforeEach(async () => {
      const { bodies } = chatReplies('A read.');
      await subscribe();
      await seedStory();
      await run(runSubscriptionReadStage());
      call = gatewayCalls('chat')[0];
      body = await bodies[0];
    });

    // The single most important property of this stage: the body is paywalled, we never fetch it,
    // and nothing may imply otherwise.
    it('tells the model it has NOT been given the full article', () => {
      expect(systemOf(call)).toContain('You have NOT been given the full article');
      expect(systemOf(call)).toContain('Never claim or imply you read the full article');
    });

    it('offers SKIP as the answer for thin input', () => {
      expect(systemOf(call)).toContain('SKIP');
    });

    it('sends only the headline, description and existing enrichment', () => {
      expect(userOf(call)).toContain('The reader is looking at this story: Cabinet falls over nitrogen plan');
      expect(userOf(call)).toContain('Its headline: Coalition talks collapse');
      expect(userOf(call)).toContain('Its description: The coalition failed to agree on nitrogen limits.');
      expect(userOf(call)).toContain('Their subscribed outlet: Het Parool');
    });

    it('runs at temperature 0 so the same inputs give the same read', () => {
      expect(body.temperature).toBe(0);
    });
  });
});
