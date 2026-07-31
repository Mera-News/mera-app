import { sectionTitle, type Translate } from '../section-title';
import type { FactRow } from '@/lib/stores/fact-rows-selector';

// Stub `t`: echoes the key plus any interpolation, so the assertions pin BOTH
// the key used and the values passed to it.
const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}|${JSON.stringify(options)}` : key) as unknown as Translate;

function row(o: Partial<FactRow>): FactRow {
  return {
    factId: o.factId ?? 'sec',
    kind: o.kind,
    countryCode: o.countryCode,
    statement: o.statement ?? '',
    factStatement: null,
    latestAddedMs: 0,
    unreadCount: 0,
    groups: [],
    ...o,
  };
}

describe('sectionTitle', () => {
  it('uses the fact statement for a fact section', () => {
    expect(sectionTitle(t, row({ kind: 'fact', statement: 'Lives in Amsterdam' }))).toBe(
      'Lives in Amsterdam',
    );
  });

  it('treats an absent kind as a fact section (legacy FactRow literals)', () => {
    expect(sectionTitle(t, row({ statement: 'Lives in Amsterdam' }))).toBe('Lives in Amsterdam');
  });

  it('promises the COMPLEMENT for GLOBAL, never a superlative', () => {
    // The server dedups a story to the FIRST scope carrying it and countries go
    // first, so a big domestic story is in the country section and NOT here.
    // "Top global headlines" would promise what this section deliberately omits.
    expect(sectionTitle(t, row({ kind: 'headline-global' }))).toBe('forYou.headlineSectionGlobal');
  });

  it('names the country (no count promised) for a country section', () => {
    expect(sectionTitle(t, row({ kind: 'headline-country', countryCode: 'IN' }))).toBe(
      'forYou.headlineSectionCountry|{"country":"India"}',
    );
  });

  it('resolves the display name from a lower-case code too', () => {
    // `countryNameForAlpha2` is the app's existing authority and returns the
    // aliased name, article included ("The Netherlands") — accepted as-is rather
    // than post-processed, since any de-articling rule would be English-only.
    expect(sectionTitle(t, row({ kind: 'headline-country', countryCode: 'nl' }))).toBe(
      'forYou.headlineSectionCountry|{"country":"The Netherlands"}',
    );
  });

  it('falls back to the raw code when no display name resolves', () => {
    expect(sectionTitle(t, row({ kind: 'headline-country', countryCode: 'ZZ' }))).toBe(
      'forYou.headlineSectionCountry|{"country":"ZZ"}',
    );
  });
});
