// story-scope generator tests (PURE) — the {label, search} parser's tolerance +
// single-field fallback + throw behavior, and the prompt builder's title
// capping / numbering / blank-dropping.

import {
  buildStoryScopePrompt,
  parseStoryScopeOutput,
  MAX_SCOPE_TITLES,
} from '../index';

/** Fixed injected clock — 2026-03-04. The builder never reads Date.now(), so
 *  every prompt assertion below is deterministic. */
const NOW_MS = Date.UTC(2026, 2, 4, 5, 6, 7);

describe('parseStoryScopeOutput', () => {
  it('parses a clean two-field JSON object', () => {
    expect(
      parseStoryScopeOutput('{"label":"Russia–Ukraine war","search":"russia ukraine war"}'),
    ).toEqual({ label: 'Russia–Ukraine war', search: 'russia ukraine war' });
  });

  it('tolerates a markdown code fence', () => {
    const raw = '```json\n{"label":"Assam floods","search":"assam floods displacement"}\n```';
    expect(parseStoryScopeOutput(raw)).toEqual({
      label: 'Assam floods',
      search: 'assam floods displacement',
    });
  });

  it('tolerates surrounding prose (first top-level object)', () => {
    const raw = 'Sure! Here is the topic:\n{"label":"Election","search":"us election 2026"} — done.';
    expect(parseStoryScopeOutput(raw)).toEqual({
      label: 'Election',
      search: 'us election 2026',
    });
  });

  it('trims whitespace on both fields', () => {
    expect(
      parseStoryScopeOutput('{"label":"  Flood  ","search":"  assam flood  "}'),
    ).toEqual({ label: 'Flood', search: 'assam flood' });
  });

  it('falls back search→label when only label is present', () => {
    expect(parseStoryScopeOutput('{"label":"Wildfires"}')).toEqual({
      label: 'Wildfires',
      search: 'Wildfires',
    });
  });

  it('falls back label→search when only search is present', () => {
    expect(parseStoryScopeOutput('{"search":"california wildfires"}')).toEqual({
      label: 'california wildfires',
      search: 'california wildfires',
    });
  });

  it('throws on empty output', () => {
    expect(() => parseStoryScopeOutput('')).toThrow();
    expect(() => parseStoryScopeOutput('   ')).toThrow();
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseStoryScopeOutput('sorry, I cannot help with that')).toThrow();
  });

  it('throws when the object has neither usable field', () => {
    expect(() => parseStoryScopeOutput('{"label":"","search":"  "}')).toThrow();
    expect(() => parseStoryScopeOutput('{"foo":"bar"}')).toThrow();
  });
});

describe('buildStoryScopePrompt', () => {
  it('numbers each title line and returns the shared system prompt', () => {
    const { system, user } = buildStoryScopePrompt(['First story', 'Second story'], NOW_MS);
    expect(system).toContain('label');
    expect(system).toContain('search');
    expect(user).toContain('1. First story');
    expect(user).toContain('2. Second story');
  });

  it('caps the titles at MAX_SCOPE_TITLES', () => {
    const many = Array.from({ length: MAX_SCOPE_TITLES + 5 }, (_, i) => `Title ${i + 1}`);
    const { user } = buildStoryScopePrompt(many, NOW_MS);
    expect(user).toContain(`${MAX_SCOPE_TITLES}. Title ${MAX_SCOPE_TITLES}`);
    // The (MAX+1)th title must not appear as a numbered line.
    expect(user).not.toContain(`${MAX_SCOPE_TITLES + 1}. Title ${MAX_SCOPE_TITLES + 1}`);
  });

  it('drops blank / whitespace-only titles before numbering', () => {
    const { user } = buildStoryScopePrompt(['   ', 'Real title', '', 'Another'], NOW_MS);
    expect(user).toContain('1. Real title');
    expect(user).toContain('2. Another');
    expect(user).not.toContain('3.');
  });

  it('handles a null/undefined title list without throwing', () => {
    expect(() => buildStoryScopePrompt(undefined as unknown as string[], NOW_MS)).not.toThrow();
  });

  it('renders the injected date as a Today line (UTC) and forbids finished periods', () => {
    const { system, user } = buildStoryScopePrompt(['Hungarian Grand Prix qualifying'], NOW_MS);
    expect(user).toContain('Today: 2026-03-04');
    expect(system).toContain('NEVER name an already-ended year, season or edition');
    expect(system).toContain('UNDATED');
  });

  // Precision rules. These two are load-bearing and pull in OPPOSITE directions
  // from the undated rule above, so they are pinned side by side: a future edit
  // that generalises the scope to keep it "matchable" must not take the place
  // anchor or the capitals with it.
  it('keeps the place anchor in the search for a single localised incident', () => {
    const { system } = buildStoryScopePrompt(['Bridge collapses on Nehru Road'], NOW_MS);
    expect(system).toContain('ONE incident in ONE place');
    expect(system).toContain('venue, street or town name');
    // The place anchor must not be read as re-permitting a dated scope.
    expect(system).toContain('A place is not a date');
  });

  it('mandates sentence case with capitals, and never lowercase, for the search', () => {
    const { system } = buildStoryScopePrompt(['Bhopal rain floods low-lying areas'], NOW_MS);
    // The server's geo gate detects a place by its uppercase first letter, so a
    // lowercase-mandated query is silently un-geo-filterable. Do not "tidy" the
    // prompt back to "a plain lowercase search query".
    expect(system).toContain('KEEP THE CAPITALS');
    expect(system).toContain('recognises a place by its capital letter');
    expect(system).not.toMatch(/plain lowercase|lowercase (search|retrieval) query/);
    // The worked example has to obey its own rule or the model copies the case.
    expect(system).toContain('"search": "Russia Ukraine war"');
  });

  it('is deterministic for a fixed date and varies only with it', () => {
    const titles = ['Hungarian Grand Prix qualifying', 'Verstappen takes pole'];
    expect(buildStoryScopePrompt(titles, NOW_MS).user).toBe(
      buildStoryScopePrompt(titles, NOW_MS).user,
    );
    const later = buildStoryScopePrompt(titles, Date.UTC(2027, 6, 15)).user;
    expect(later).not.toBe(buildStoryScopePrompt(titles, NOW_MS).user);
    expect(later).toContain('Today: 2027-07-15');
  });

  it('degrades to "unknown" rather than throwing on a non-finite date', () => {
    expect(buildStoryScopePrompt(['A title'], Number.NaN).user).toContain('Today: unknown');
  });
});
