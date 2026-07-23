// story-scope generator tests (PURE) — the {label, search} parser's tolerance +
// single-field fallback + throw behavior, and the prompt builder's title
// capping / numbering / blank-dropping.

import {
  buildStoryScopePrompt,
  parseStoryScopeOutput,
  MAX_SCOPE_TITLES,
} from '../index';

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
    const { system, user } = buildStoryScopePrompt(['First story', 'Second story']);
    expect(system).toContain('label');
    expect(system).toContain('search');
    expect(user).toContain('1. First story');
    expect(user).toContain('2. Second story');
  });

  it('caps the titles at MAX_SCOPE_TITLES', () => {
    const many = Array.from({ length: MAX_SCOPE_TITLES + 5 }, (_, i) => `Title ${i + 1}`);
    const { user } = buildStoryScopePrompt(many);
    expect(user).toContain(`${MAX_SCOPE_TITLES}. Title ${MAX_SCOPE_TITLES}`);
    // The (MAX+1)th title must not appear as a numbered line.
    expect(user).not.toContain(`${MAX_SCOPE_TITLES + 1}. Title ${MAX_SCOPE_TITLES + 1}`);
  });

  it('drops blank / whitespace-only titles before numbering', () => {
    const { user } = buildStoryScopePrompt(['   ', 'Real title', '', 'Another']);
    expect(user).toContain('1. Real title');
    expect(user).toContain('2. Another');
    expect(user).not.toContain('3.');
  });

  it('handles a null/undefined title list without throwing', () => {
    expect(() => buildStoryScopePrompt(undefined as unknown as string[])).not.toThrow();
  });
});
