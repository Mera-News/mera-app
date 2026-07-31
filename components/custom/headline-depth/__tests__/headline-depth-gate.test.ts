// The ship gate, in the state this actually ships in.
//
// The hazard: production's schema is still
//   `input HeadlineScopeInput { countryCode: String, scope: HeadlineScope! }`
// with no `limit`. An unknown field on an input object fails GraphQL VALIDATION,
// which rejects the whole operation — so one scope carrying `limit` does not
// degrade headlines, it empties the feed. These tests are the guard.
//
// Crucially they seed rows FIRST and then assert nothing comes back out: gating
// only the write path would leave a rollback (true → ship → users store
// overrides → false) still putting `limit` on the wire.

jest.mock('@/lib/config/feature-gates', () => ({
  HEADLINE_DEPTH_UI_ENABLED: false,
}));

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
} from '@/lib/database/services/headline-depth-service';
import { buildRetrievalProfile } from '@/lib/news-harness/scoring-engine/retrieval-profile';
import { chooseHeadlineDepth } from '../headline-depth-model';

const LOCATIONS = [
  { countryCode: 'IN', role: 'home', weight: 1 },
  { countryCode: 'NL', role: 'family', weight: 0.5 },
];

beforeEach(() => {
  mockSettingsStore.clear();
});

describe('HEADLINE_DEPTH_UI_ENABLED = false', () => {
  it('reports no overrides even when rows exist on disk', async () => {
    await chooseHeadlineDepth('IN', 25);
    await chooseHeadlineDepth('GLOBAL', 3);
    // The rows are genuinely there — the gate suppresses the READ, it does not
    // silently delete a reader's settings.
    expect(mockSettingsStore.get(headlineDepthKey('IN'))).toBe('25');
    expect(mockSettingsStore.get(headlineDepthKey('GLOBAL'))).toBe('3');

    await expect(getHeadlineDepths()).resolves.toEqual({});
  });

  it('puts NO `limit` on any scope, so the payload matches prod\'s schema', async () => {
    await chooseHeadlineDepth('IN', 25);
    await chooseHeadlineDepth('NL', 1);
    await chooseHeadlineDepth('GLOBAL', 3);

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
    for (const scope of headlineScopes) {
      expect(scope).not.toHaveProperty('limit');
    }
  });
});
