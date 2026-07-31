// Headline-depth screen model — the ship gate is forced ON here so the
// *enabled* behaviour is exercised. The disabled behaviour (the state this
// actually ships in) is covered in headline-depth-gate.test.ts.

jest.mock('@/lib/config/feature-gates', () => ({
  HEADLINE_DEPTH_UI_ENABLED: true,
}));

// Stub only the KV primitive (it has its own tests) so the round trip below is
// real all the way down through headline-depth-service: key normalization,
// clamping, and delete-on-default all run for real against this store.
const mockSettingsStore = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSettingsByPrefix: jest.fn(async (prefix: string) =>
    Object.fromEntries(
      Array.from(mockSettingsStore.entries()).filter(([k]) => k.startsWith(prefix)),
    ),
  ),
  setSetting: jest.fn(async (key: string, value: string) => {
    mockSettingsStore.set(key, value);
  }),
  deleteSetting: jest.fn(async (key: string) => {
    mockSettingsStore.delete(key);
  }),
}));

import {
  getHeadlineDepths,
  headlineDepthKey,
  setHeadlineDepth,
} from '@/lib/database/services/headline-depth-service';
import {
  buildRetrievalProfile,
  DEFAULT_HEADLINE_LIMIT_PER_SCOPE,
  MAX_HEADLINE_DEPTH,
} from '@/lib/news-harness/scoring-engine/retrieval-profile';
import {
  chooseHeadlineDepth,
  headlineDepthOptions,
  headlineScopeRows,
} from '../headline-depth-model';

const LOCATIONS = [
  { countryCode: 'IN', role: 'home', weight: 1 },
  { countryCode: 'NL', role: 'family', weight: 0.5 },
];

beforeEach(() => {
  mockSettingsStore.clear();
});

// ---------------------------------------------------------------------------
// Scope rows
// ---------------------------------------------------------------------------

describe('headlineScopeRows', () => {
  it('lists the country scopes in weight order, then GLOBAL last', () => {
    expect(headlineScopeRows(LOCATIONS).map((s) => s.key)).toEqual(['IN', 'NL', 'GLOBAL']);
    expect(headlineScopeRows(LOCATIONS).at(-1)?.isGlobal).toBe(true);
  });

  it('inherits the builder role filter — an `interest` location gets no row', () => {
    const rows = headlineScopeRows([{ countryCode: 'JP', role: 'interest', weight: 1 }]);
    expect(rows.map((s) => s.key)).toEqual(['GLOBAL']);
  });

  it('excludes expired travel, matching what the feed sync would send', () => {
    const nowMs = 1_000_000;
    const rows = headlineScopeRows(
      [{ countryCode: 'FR', role: 'travel', weight: 1, validUntilMs: nowMs - 1 }],
      nowMs,
    );
    expect(rows.map((s) => s.key)).toEqual(['GLOBAL']);
  });
});

// ---------------------------------------------------------------------------
// The alpha-2 contract. This is the silent-failure trap: `locations.countryCode`
// is ISO alpha-2 and the builder uppercases it straight into `scope.countryCode`,
// but `lib/country-utils.ts` speaks alpha-3. Storing 'IND' would write a row that
// is never read and produce no error anywhere.
// ---------------------------------------------------------------------------

describe('scope keys are the SAME strings the wire scopes carry', () => {
  it('a depth stored under a scope row key lands on that scope', async () => {
    const [india] = headlineScopeRows(LOCATIONS);
    await chooseHeadlineDepth(india.key, MAX_HEADLINE_DEPTH);

    const { headlineScopes } = buildRetrievalProfile({
      topics: [],
      locations: LOCATIONS,
      headlineDepthByScope: await getHeadlineDepths(),
    });
    expect(headlineScopes[0]).toEqual({
      scope: 'COUNTRY',
      countryCode: 'IN',
      limit: MAX_HEADLINE_DEPTH,
    });
  });

  it('an alpha-3 key would silently do nothing (why the alpha-2 rule exists)', async () => {
    await chooseHeadlineDepth('IND', MAX_HEADLINE_DEPTH);
    const { headlineScopes } = buildRetrievalProfile({
      topics: [],
      locations: LOCATIONS,
      headlineDepthByScope: await getHeadlineDepths(),
    });
    expect(headlineScopes[0]).toEqual({ scope: 'COUNTRY', countryCode: 'IN' });
  });
});

// ---------------------------------------------------------------------------
// Options ladder
// ---------------------------------------------------------------------------

describe('headlineDepthOptions', () => {
  it('never offers 0 — an empty section with no explanation (PU-24)', () => {
    for (const d of [1, 2, 5, 10, 20, 25]) {
      expect(headlineDepthOptions(d).every((n) => n > 0)).toBe(true);
    }
  });

  it('is ascending, deduped, and never exceeds the server maximum', () => {
    for (const d of [1, 2, 5, 10, 20, 25]) {
      const opts = headlineDepthOptions(d);
      expect(opts).toEqual([...opts].sort((a, b) => a - b));
      expect(new Set(opts).size).toBe(opts.length);
      expect(Math.max(...opts)).toBeLessThanOrEqual(MAX_HEADLINE_DEPTH);
    }
  });

  it('always contains the shipped default, so "back to normal" is always tappable', () => {
    expect(headlineDepthOptions()).toContain(DEFAULT_HEADLINE_LIMIT_PER_SCOPE);
    expect(headlineDepthOptions(20)).toContain(20);
  });
});

// ---------------------------------------------------------------------------
// Round trip through the real service
// ---------------------------------------------------------------------------

describe('chooseHeadlineDepth', () => {
  it('round-trips a chosen depth back out of storage', async () => {
    await chooseHeadlineDepth('GLOBAL', 25);
    await expect(getHeadlineDepths()).resolves.toEqual({ GLOBAL: 25 });
  });

  it('normalizes a lower-cased scope key to one canonical row', async () => {
    await chooseHeadlineDepth('in', 25);
    expect(mockSettingsStore.has(headlineDepthKey('IN'))).toBe(true);
    await expect(getHeadlineDepths()).resolves.toEqual({ IN: 25 });
  });

  it('clamps above the server maximum instead of storing a 400', async () => {
    await chooseHeadlineDepth('GLOBAL', 999);
    await expect(getHeadlineDepths()).resolves.toEqual({ GLOBAL: MAX_HEADLINE_DEPTH });
  });

  it('clamps below zero', async () => {
    await chooseHeadlineDepth('GLOBAL', -7);
    await expect(getHeadlineDepths()).resolves.toEqual({ GLOBAL: 0 });
  });

  it('DELETES the row when the default is chosen rather than pinning the value', async () => {
    await chooseHeadlineDepth('GLOBAL', 25);
    expect(mockSettingsStore.size).toBe(1);

    await chooseHeadlineDepth('GLOBAL', DEFAULT_HEADLINE_LIMIT_PER_SCOPE);
    expect(mockSettingsStore.size).toBe(0);
    await expect(getHeadlineDepths()).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The prod-safety invariant: a depth equal to the request default must put NO
// `limit` on the wire, because prod's schema has no such field yet.
// ---------------------------------------------------------------------------

describe('a depth equal to the default never reaches the wire', () => {
  it('emits a payload byte-identical to the pre-per-scope-depth one', async () => {
    // Force the row to exist at exactly the default value — chooseHeadlineDepth
    // deletes it, so write through the service directly to prove the SECOND
    // line of defence (depthFor's equality check) also holds on its own.
    await setHeadlineDepth('IN', DEFAULT_HEADLINE_LIMIT_PER_SCOPE);
    await setHeadlineDepth('GLOBAL', DEFAULT_HEADLINE_LIMIT_PER_SCOPE);

    const { headlineScopes } = buildRetrievalProfile({
      topics: [],
      locations: LOCATIONS,
      headlineDepthByScope: await getHeadlineDepths(),
    });
    expect(headlineScopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'IN' },
      { scope: 'COUNTRY', countryCode: 'NL' },
      { scope: 'GLOBAL' },
    ]);
  });
});
