import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import { resolveGeoMatch, type ArticleGeoTag } from '../geo';
import type { PersonaLocationSnapshot } from '../persona-context';

const cfg = DEFAULT_HARNESS_CONFIG.scoringEngine;

const chhindwara: PersonaLocationSnapshot = {
  id: 'loc-chhindwara',
  city: 'chhindwara',
  region: 'madhya pradesh',
  countryCode: 'IN',
  role: 'family',
  weight: 1.0,
};
const bhopal: PersonaLocationSnapshot = {
  id: 'loc-bhopal',
  city: 'bhopal',
  region: 'madhya pradesh',
  countryCode: 'IN',
  role: 'family',
  weight: 1.0,
};
const amsterdam: PersonaLocationSnapshot = {
  id: 'loc-amsterdam',
  city: 'amsterdam',
  region: 'noord-holland',
  countryCode: 'NL',
  role: 'home',
  weight: 1.0,
};

const tag = (t: Partial<ArticleGeoTag> & { countryCode: string }): ArticleGeoTag => t;

describe('resolveGeoMatch — alignment tiers', () => {
  it('CITY: article city matches a persona city', () => {
    const r = resolveGeoMatch([tag({ city: 'amsterdam', region: 'noord-holland', countryCode: 'NL' })], [amsterdam], cfg);
    expect(r.alignment).toBe('CITY');
    expect(r.geoScore).toBeCloseTo(cfg.GEO_CITY * amsterdam.weight, 6);
    expect(r.matchedLocationId).toBe('loc-amsterdam');
    expect(r.wrongLocationFlag).toBe(0);
  });

  it('REGION: same region, different/absent city', () => {
    const r = resolveGeoMatch([tag({ region: 'madhya pradesh', countryCode: 'IN' })], [chhindwara], cfg);
    expect(r.alignment).toBe('REGION');
    expect(r.geoScore).toBeCloseTo(cfg.GEO_REGION * chhindwara.weight, 6);
  });

  it('COUNTRY: only the country matches', () => {
    const r = resolveGeoMatch([tag({ city: 'rotterdam', region: 'zuid-holland', countryCode: 'NL' })], [amsterdam], cfg);
    expect(r.alignment).toBe('COUNTRY');
    expect(r.geoScore).toBeCloseTo(cfg.GEO_COUNTRY * amsterdam.weight, 6);
  });

  it('NONE: different country → no alignment, zero score', () => {
    const r = resolveGeoMatch([tag({ city: 'birmingham', countryCode: 'GB' })], [bhopal], cfg);
    expect(r.alignment).toBe('NONE');
    expect(r.geoScore).toBe(0);
    expect(r.wrongLocationFlag).toBe(0);
  });

  it('empty tags → NONE / 0', () => {
    const r = resolveGeoMatch([], [amsterdam], cfg);
    expect(r.alignment).toBe('NONE');
    expect(r.geoScore).toBe(0);
  });
});

describe('resolveGeoMatch — wrong-location', () => {
  const anchoredChhindwara = new Set(['loc-chhindwara']);

  it('Dindori vs Chhindwara: sibling city in same region → wrong-location fires', () => {
    const r = resolveGeoMatch(
      [tag({ city: 'dindori', region: 'madhya pradesh', countryCode: 'IN' })],
      [chhindwara, bhopal],
      cfg,
      anchoredChhindwara,
    );
    expect(r.alignment).toBe('REGION'); // still region-positive
    expect(r.wrongLocationFlag).toBe(1);
  });

  it('MP-wide weather (region tag, no city) → REGION, NOT wrong-location', () => {
    const r = resolveGeoMatch(
      [tag({ region: 'madhya pradesh', countryCode: 'IN' })],
      [chhindwara],
      cfg,
      anchoredChhindwara,
    );
    expect(r.alignment).toBe('REGION');
    expect(r.wrongLocationFlag).toBe(0);
  });

  it('no anchored topic → never wrong-location even for a sibling city', () => {
    const r = resolveGeoMatch(
      [tag({ city: 'dindori', region: 'madhya pradesh', countryCode: 'IN' })],
      [chhindwara],
      cfg,
      new Set(),
    );
    expect(r.wrongLocationFlag).toBe(0);
  });

  it('article about a FOLLOWED city is never wrong-location (CITY guard rescues it)', () => {
    // Chhindwara article, but the matched anchored topic was Bhopal-anchored.
    const r = resolveGeoMatch(
      [tag({ city: 'chhindwara', region: 'madhya pradesh', countryCode: 'IN' })],
      [chhindwara, bhopal],
      cfg,
      new Set(['loc-bhopal']),
    );
    expect(r.alignment).toBe('CITY');
    expect(r.wrongLocationFlag).toBe(0);
  });

  it('cross-country match never fires wrong-location (Bhopal-topic → Birmingham GB)', () => {
    const r = resolveGeoMatch(
      [tag({ city: 'birmingham', countryCode: 'GB' })],
      [bhopal],
      cfg,
      new Set(['loc-bhopal']),
    );
    expect(r.alignment).toBe('NONE');
    expect(r.wrongLocationFlag).toBe(0);
  });
});

describe('resolveGeoMatch — supranational PLACE codes', () => {
  // The server's geo_tags.countryCode widened from ISO alpha-2-only to also
  // allow curated supranational codes ("MIDDLE_EAST", "EU", "GLOBAL", …). This
  // module matches by plain equality against the persona's own alpha-2
  // countryCode, so a supranational tag can never equal one — it must resolve
  // NONE/0 rather than crash or produce a spurious match.

  it('a supranational-only tag resolves NONE / 0, no crash', () => {
    const r = resolveGeoMatch([tag({ countryCode: 'MIDDLE_EAST' })], [amsterdam], cfg);
    expect(r.alignment).toBe('NONE');
    expect(r.geoScore).toBe(0);
    expect(r.wrongLocationFlag).toBe(0);
  });

  it('EU — exactly two characters, same length as every real ISO alpha-2 code — never matches a real country', () => {
    // A length-based shortcut ("only alpha-2 codes are 2 chars") would
    // misclassify EU as a country. countryEq must decide by value, not length:
    // 'EU' !== 'NL' regardless of both being two characters.
    const r = resolveGeoMatch([tag({ countryCode: 'EU' })], [amsterdam], cfg);
    expect(r.alignment).toBe('NONE');
    expect(r.geoScore).toBe(0);
  });

  it('a mixed tag list still aligns on the real ISO tag alongside a supranational one', () => {
    const r = resolveGeoMatch(
      [
        tag({ countryCode: 'EUROPE' }),
        tag({ city: 'amsterdam', region: 'noord-holland', countryCode: 'NL' }),
      ],
      [amsterdam],
      cfg,
    );
    expect(r.alignment).toBe('CITY');
    expect(r.matchedLocationId).toBe('loc-amsterdam');
  });

  it('a supranational tag never trips the wrong-location flag (it names no sibling city)', () => {
    const r = resolveGeoMatch(
      [tag({ countryCode: 'MIDDLE_EAST' })],
      [chhindwara],
      cfg,
      new Set(['loc-chhindwara']),
    );
    expect(r.wrongLocationFlag).toBe(0);
  });
});
