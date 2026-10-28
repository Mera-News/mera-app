// scoring-engine/location-rule — the deterministic geo catch before any model call.

import {
  screenLocationRule,
  toAlpha2,
  type LocationRuleCandidate,
  type LocationRuleContext,
} from '@/lib/news-harness/scoring-engine/location-rule';
import type { ScoredCandidateInput } from '@/lib/news-harness/scoring-engine/relevance';
import type { Bloc } from '@/lib/mera-harness/core/types';

const EU = ['AT', 'BE', 'DE', 'ES', 'FR', 'IT', 'NL', 'PT', 'RO'];
const countriesInBloc = (b: Bloc): readonly string[] => (b === 'EU' || b === 'Europe' ? EU : []);

const ctx = (over: Partial<LocationRuleContext> = {}): LocationRuleContext => ({
  factPlacesById: new Map([
    ['pension', ['IN']],
    ['water', ['IN|Madhya Pradesh|Bhopal']],
    ['climate', ['GLOBAL']],
    ['eu-law', ['EU']],
    ['unswept', []],
  ]),
  readerCountries: new Set(['IN']),
  trackedTopicIds: new Set(['tracked-1']),
  countriesInBloc,
  ...over,
});

const row = (
  facts: string[],
  over: Partial<ScoredCandidateInput> = {},
): LocationRuleCandidate => ({
  input: {
    id: 'a1',
    titleEn: 'Pension age to rise by two years',
    descriptionEn: 'The government confirmed the change on Tuesday.',
    countryCode: 'ROU',
    matchedTopics: [{ topicId: 't1', text: 'pension reform', effectiveWeight: 0.8 }],
    ...over,
  },
  legacy: { relatedFacts: facts.map((id) => ({ id })) },
});

const caught = (c: LocationRuleCandidate, x: LocationRuleContext = ctx()) =>
  screenLocationRule([c], x).has(c.input.id);

describe('location rule', () => {
  it('catches a Romanian pension story for an India pension fact (the field report)', () => {
    expect(caught(row(['pension']))).toBe(true);
  });

  it('passes the same story from an Indian publication, alpha-3 or alpha-2', () => {
    expect(caught(row(['pension'], { countryCode: 'IND' }))).toBe(false);
    expect(caught(row(['pension'], { countryCode: 'IN' }))).toBe(false);
  });

  it('a city place covers its country', () => {
    expect(caught(row(['water'], { countryCode: 'IND' }))).toBe(false);
    expect(caught(row(['water']))).toBe(true);
  });

  it('does not apply without a publication country, or with GLOBAL', () => {
    expect(caught(row(['pension'], { countryCode: null }))).toBe(false);
    expect(caught(row(['pension'], { countryCode: 'GLOBAL' }))).toBe(false);
  });

  it('a GLOBAL fact exempts the row, even beside a place that would catch it', () => {
    expect(caught(row(['pension', 'climate']))).toBe(false);
  });

  it('unknown places exempt the row (no fallback to the reader countries)', () => {
    expect(caught(row(['unswept']))).toBe(false);
    expect(caught(row(['missing-fact']))).toBe(false);
    expect(caught(row(['pension', 'unswept']))).toBe(false);
  });

  it('no matched fact on a topic row means no signal', () => {
    expect(caught(row([]))).toBe(false);
  });

  it('a bloc place matches its members only', () => {
    expect(caught(row(['eu-law']))).toBe(false); // RO is EU
    expect(caught(row(['eu-law'], { countryCode: 'USA' }))).toBe(true);
  });

  it('exempts a title or description that names the place: country, demonym, city, region', () => {
    expect(caught(row(['pension'], { titleEn: 'What the change means for pensioners in India' }))).toBe(false);
    expect(caught(row(['pension'], { descriptionEn: 'Indian retirees abroad are affected too.' }))).toBe(false);
    expect(caught(row(['water'], { titleEn: 'Bhopal firm wins the tender' }))).toBe(false);
    expect(caught(row(['water'], { titleEn: 'Madhya Pradesh dams are low' }))).toBe(false);
  });

  it('exempts a title naming the bloc that holds a fact country (an EU story for an NL fact)', () => {
    const nl = ctx({ factPlacesById: new Map([['dutch', ['NL']]]), readerCountries: new Set(['NL']) });
    expect(caught(row(['dutch'], { countryCode: 'CHN', titleEn: 'EU expands AI Act' }), nl)).toBe(false);
    expect(caught(row(['dutch'], { countryCode: 'PRT', titleEn: 'European AI now has new obligations' }), nl)).toBe(false);
    expect(caught(row(['dutch'], { countryCode: 'CHN', titleEn: 'Asian AI rules tighten' }), nl)).toBe(true);
  });

  it('exempts a followed-story match', () => {
    const c = row(['pension'], {
      matchedTopics: [{ topicId: 'tracked-1', text: 'Romania pension protests', effectiveWeight: 1 }],
    });
    expect(caught(c)).toBe(false);
  });

  it('exempts a matched topic whose text names the publication country', () => {
    const c = row(['pension'], {
      matchedTopics: [{ topicId: 't9', text: 'Romanian politics', effectiveWeight: 0.6 }],
    });
    expect(caught(c)).toBe(false);
  });

  it('GLOBAL-scope headlines are exempt', () => {
    expect(caught(row([], { headlineScope: 'GLOBAL', matchedTopics: [] }))).toBe(false);
  });

  it('COUNTRY-scope headlines check the reader countries plus their own scope country', () => {
    const h = (over: Partial<ScoredCandidateInput>) =>
      row([], { headlineScope: 'COUNTRY', matchedTopics: [], ...over });
    expect(caught(h({ countryCode: 'IND' }))).toBe(false);
    expect(caught(h({ countryCode: 'ROU', headlineCountryCode: 'ROU' }))).toBe(false);
    expect(caught(h({ countryCode: 'ROU', headlineCountryCode: 'IND' }))).toBe(true);
    expect(caught(h({ countryCode: 'ROU' }), ctx({ readerCountries: new Set() }))).toBe(false);
  });

  it('screens a batch and returns only the caught ids', () => {
    const a = row(['pension']);
    const b = { ...row(['pension'], { countryCode: 'IND' }), input: { ...row(['pension'], { countryCode: 'IND' }).input, id: 'b2' } };
    expect([...screenLocationRule([a, b], ctx())]).toEqual(['a1']);
  });
});

describe('toAlpha2', () => {
  it('converts alpha-3, keeps alpha-2, rejects GLOBAL and junk', () => {
    expect(toAlpha2('ROU')).toBe('RO');
    expect(toAlpha2('xkk')).toBe('XK');
    expect(toAlpha2('IN')).toBe('IN');
    expect(toAlpha2('GLOBAL')).toBeNull();
    expect(toAlpha2('ZZ')).toBeNull();
    expect(toAlpha2(null)).toBeNull();
  });
});

// ── The stage: a caught row reaches no model ───────────────────────────────

import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import type { LlmPort } from '@/lib/news-harness/core/ports';
import type { ScoringCandidate } from '@/lib/news-harness/core/types';
import { computeAndScore, type StageCandidate } from '@/lib/news-harness/scoring-engine/run-stage';
import type { PersonaScoringContext } from '@/lib/news-harness/scoring-engine/persona-context';

describe('computeAndScore with the location rule', () => {
  const legacy = (id: string, countryCode: string): ScoringCandidate => ({
    id,
    titleEn: 'Pension age to rise by two years',
    descriptionEn: 'The government confirmed the change on Tuesday.',
    countryCode,
    userTopicIds: ['t1'],
    relatedFacts: [{ id: 'pension', statement: 'Pensioner in India' }],
  });
  const stageRow = (id: string, countryCode: string): StageCandidate => ({
    input: {
      id,
      titleEn: 'Pension age to rise by two years',
      descriptionEn: 'The government confirmed the change on Tuesday.',
      countryCode,
      matchedTopics: [{ topicId: 't1', text: 'pension reform', effectiveWeight: 0.8 }],
    },
    legacy: legacy(id, countryCode),
  });
  const llm: LlmPort = {
    batchComplete: async () => {
      throw new Error('not used');
    },
    complete: async () => {
      throw new Error('not used');
    },
  };
  const base: PersonaScoringContext = { locations: [], pubPrefs: new Map(), softSuppressions: [] };

  it('scores a caught row 0, marks it and never hands it to the scorer', async () => {
    const seen: string[] = [];
    const scorer = async (cands: ScoringCandidate[]) => {
      seen.push(...cands.map((c) => c.id));
      return new Map(cands.map((c) => [c.id, 0.9]));
    };
    const r = await computeAndScore(
      [stageRow('ro', 'ROU'), stageRow('in', 'IND')],
      { ...base, location: ctx() },
      llm,
      DEFAULT_HARNESS_CONFIG,
      { relevanceScorer: scorer },
    );
    expect(seen).toEqual(['in']);
    expect([...r.locationCaughtIds]).toEqual(['ro']);
    expect(r.rawScoreMap.get('ro')).toBe(0);
    expect(r.componentsMap.get('ro')?.locationCaught).toBe(true);
    expect(r.componentsMap.get('in')?.locationCaught).toBeUndefined();
    expect(r.rawScoreMap.get('in')).toBe(0.9);
  });

  it('without a location context nothing is caught (eval, harness-local)', async () => {
    const scorer = async (cands: ScoringCandidate[]) => new Map(cands.map((c) => [c.id, 0.9]));
    const r = await computeAndScore([stageRow('ro', 'ROU')], base, llm, DEFAULT_HARNESS_CONFIG, {
      relevanceScorer: scorer,
    });
    expect(r.locationCaughtIds.size).toBe(0);
    expect(r.rawScoreMap.get('ro')).toBe(0.9);
  });
});
