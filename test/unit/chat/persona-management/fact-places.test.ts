// fact-places — the stored encoding, names in and out (never codes), and the
// matching helpers the location rule and the feedback menu build on.

import {
  blocNamedIn,
  countriesNamedIn,
  describeFactPlaces,
  factLineWithPlaces,
  factPlaces,
  factPlacesBy,
  normalizePlaces,
  parsePlace,
  placeFromNames,
  placesCoverCountry,
  placesSourceHash,
  suggestFactPlaceOptions,
  type ReaderPlace,
} from '@/lib/news-harness/persona-management/fact-places';
import {
  mistakeFromContext,
  parseFeedbackAnswers,
} from '@/lib/news-harness/persona-management/feedback-digest';
import type { Bloc } from '@/lib/mera-harness/core/types';

const fact = (statement: string, metadata?: Record<string, unknown>) => ({ statement, metadata });
const bhopal: ReaderPlace = { countryCode: 'IN', region: 'Madhya Pradesh', city: 'Bhopal', role: 'home' };
const EU_STUB = (b: Bloc) => (b === 'EU' ? ['DE', 'FR', 'NL'] : []);

describe('parse and normalize', () => {
  it('reads every level and rejects malformed values', () => {
    expect(parsePlace('GLOBAL')).toEqual({ level: 'global' });
    expect(parsePlace('EU')).toEqual({ level: 'bloc', bloc: 'EU' });
    expect(parsePlace('UK')).toEqual({ level: 'country', country: 'GB' });
    expect(parsePlace('IN')).toEqual({ level: 'country', country: 'IN' });
    expect(parsePlace('IN|Madhya Pradesh')).toEqual({ level: 'region', country: 'IN', region: 'Madhya Pradesh' });
    expect(parsePlace('IN|Madhya Pradesh|Bhopal')).toMatchObject({ level: 'city', city: 'Bhopal' });
    expect(parsePlace('GB||London')).toEqual({ level: 'city', country: 'GB', city: 'London' });
    for (const bad of ['in', 'XX', 'IND', 'IN|', 'IN||', 'IN|a|b|c', '', 'Narnia']) {
      expect(parsePlace(bad)).toBeNull();
    }
  });

  it('dedupes, drops junk and lets a specific place outrank GLOBAL', () => {
    expect(normalizePlaces(['IN', 'IN', 'junk', 3, 'UK'])).toEqual(['IN', 'GB']);
    expect(normalizePlaces(['GLOBAL', 'IN'])).toEqual(['IN']);
    expect(normalizePlaces(['GLOBAL'])).toEqual(['GLOBAL']);
  });

  it('reads places and places_by off fact metadata', () => {
    const f = fact('x', { places: ['IN', 'bad'], places_by: 'user' });
    expect(factPlaces(f)).toEqual(['IN']);
    expect(factPlacesBy(f)).toBe('user');
    expect(factPlaces(fact('x'))).toEqual([]);
    expect(factPlacesBy(fact('x', { places_by: 'robot' }))).toBeNull();
  });
});

describe('names, never codes', () => {
  it('describes each level in prose', () => {
    expect(describeFactPlaces(fact('a', { places: ['IN|Madhya Pradesh|Bhopal'] }))).toBe('Bhopal, Madhya Pradesh, India');
    expect(describeFactPlaces(fact('a', { places: ['EU'] }))).toBe('the European Union');
    expect(describeFactPlaces(fact('a', { places: ['GLOBAL'] }))).toBe('anywhere in the world');
    expect(describeFactPlaces(fact('a', { places: ['GB||London'] }))).toBe('London, United Kingdom');
    expect(describeFactPlaces(fact('a'))).toBeNull();
  });

  it('builds the prompt line', () => {
    expect(factLineWithPlaces(fact('Pensioner', { places: ['IN'] }))).toBe('Pensioner (news from: India)');
    expect(factLineWithPlaces(fact('Pensioner'))).toBe('Pensioner');
  });

  it('decodes model names to codes and refuses codes and unknowns', () => {
    expect(placeFromNames({ level: 'anywhere' })).toBe('GLOBAL');
    expect(placeFromNames({ level: 'bloc', bloc: 'European Union' })).toBe('EU');
    expect(placeFromNames({ level: 'bloc', bloc: 'United Kingdom' })).toBe('GB');
    expect(placeFromNames({ level: 'country', country: 'India' })).toBe('IN');
    expect(placeFromNames({ level: 'country', country: 'Netherlands' })).toBe('NL');
    expect(placeFromNames({ level: 'region', country: 'India', region: 'Madhya Pradesh' })).toBe('IN|Madhya Pradesh');
    expect(placeFromNames({ level: 'city', country: 'United Kingdom', city: 'London' })).toBe('GB||London');
    expect(placeFromNames({ level: 'country', country: 'IN' })).toBeNull();
    expect(placeFromNames({ level: 'country', country: 'Narnia' })).toBeNull();
    expect(placeFromNames({ level: 'region', country: 'India' })).toBeNull();
    expect(placeFromNames({ level: 'planet', country: 'India' })).toBeNull();
    // A part of a continent is never a subdivision.
    expect(placeFromNames({ level: 'region', country: 'Kenya', region: 'East Africa' })).toBe('Africa');
    expect(placeFromNames({ level: 'bloc', bloc: 'East Africa' })).toBe('Africa');
    expect(placeFromNames({ level: 'bloc', bloc: 'Middle Earth' })).toBeNull();
    expect(placeFromNames({ level: 'region', country: 'Netherlands', region: 'North Holland' })).toBe('NL|North Holland');
  });
});

describe('text matching', () => {
  it('finds countries by name, alias and demonym, proper nouns only', () => {
    expect(countriesNamedIn('Romanian pensions rise in Bucharest')).toEqual(['RO']);
    expect(countriesNamedIn('New Zealand and the US sign a deal')).toEqual(['NZ', 'US']);
    expect(countriesNamedIn('Holland beats Germany')).toEqual(['NL', 'DE']);
    expect(countriesNamedIn('one of us bought a turkey')).toEqual([]);
  });

  it('finds blocs, longest name first', () => {
    expect(blocNamedIn('European Union tariffs')).toEqual(['EU']);
    expect(blocNamedIn('EU and Asian markets')).toEqual(['EU', 'Asia']);
    expect(blocNamedIn('a new menu')).toEqual([]);
  });
});

describe('sweep bookkeeping and matching', () => {
  it('hashes statement plus residence places, order-independent', () => {
    const work: ReaderPlace = { countryCode: 'NL', region: null, city: 'Amsterdam', role: 'work' };
    const trip: ReaderPlace = { countryCode: 'FR', region: null, city: 'Paris', role: 'travel' };
    const h = placesSourceHash('Pensioner', [bhopal, work]);
    expect(placesSourceHash('Pensioner', [work, bhopal, trip])).toBe(h);
    expect(placesSourceHash('Pensioner', [bhopal])).not.toBe(h);
    expect(placesSourceHash('Retired', [bhopal, work])).not.toBe(h);
  });

  it('covers a country through GLOBAL, the country, a deeper level or a bloc', () => {
    expect(placesCoverCountry([], 'IN', EU_STUB)).toBeNull();
    expect(placesCoverCountry(['GLOBAL'], 'RO', EU_STUB)).toBe(true);
    expect(placesCoverCountry(['IN|Madhya Pradesh|Bhopal'], 'in', EU_STUB)).toBe(true);
    expect(placesCoverCountry(['IN'], 'RO', EU_STUB)).toBe(false);
    expect(placesCoverCountry(['EU'], 'NL', EU_STUB)).toBe(true);
    expect(placesCoverCountry(['EU'], 'US', EU_STUB)).toBe(false);
  });

  it('suggests the reader places at fitting levels, GLOBAL last', () => {
    const cityFact = fact('Water cuts', { places: ['IN|Madhya Pradesh|Bhopal'] });
    expect(suggestFactPlaceOptions(cityFact, [bhopal]).map((o) => [o.place, o.label])).toEqual([
      ['IN|Madhya Pradesh|Bhopal', 'Bhopal'],
      ['IN|Madhya Pradesh', 'Madhya Pradesh'],
      ['IN', 'India'],
      ['GLOBAL', 'Anywhere'],
    ]);
    expect(suggestFactPlaceOptions(fact('Pensioner'), [bhopal]).map((o) => o.place)).toEqual(['IN', 'GLOBAL']);
    expect(suggestFactPlaceOptions(fact('Pensioner'), []).map((o) => o.place)).toEqual(['GLOBAL']);
  });
});

describe('feedback answers', () => {
  const ctx = JSON.stringify({
    fact_id: 'f1',
    country: 'RO',
    language: 'ro',
    publication: 'realitatea.net',
    answers: [
      { leafId: 'less_for_fact', path: ['profile'], cause: 'config' },
      { leafId: 'not_about_fact', path: [], cause: 'system', value: 'f1' },
      { leafId: 'legacy', path: ['x'] },
      { path: [] },
    ],
  });

  it('parses answers; a missing cause counts as config', () => {
    expect(parseFeedbackAnswers(ctx).map((a) => [a.leafId, a.cause])).toEqual([
      ['less_for_fact', 'config'],
      ['not_about_fact', 'system'],
      ['legacy', 'config'],
    ]);
    expect(parseFeedbackAnswers('not json')).toEqual([]);
  });

  it('keeps a system answer as a mistake', () => {
    expect(mistakeFromContext(ctx)).toEqual({
      reason: 'not_about_fact',
      factId: 'f1',
      country: 'RO',
      language: 'ro',
      publication: 'realitatea.net',
    });
    expect(mistakeFromContext(JSON.stringify({ answers: [{ leafId: 'a', path: [], cause: 'config' }] }))).toBeNull();
  });
});
