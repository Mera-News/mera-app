import { cleanProse, replaceClauseDashes } from '../prose';

describe('clause dashes', () => {
  it('replaces the measured failure shape with a comma', () => {
    // Verbatim from the agent corpus, where 25% of prose rows carried a dash
    // despite the router's explicit ban.
    expect(cleanProse('Confused by the statement — you said Berlin earlier.'))
      .toBe('Confused by the statement, you said Berlin earlier.');
  });

  it('handles em, en and horizontal bar', () => {
    for (const d of ['—', '–', '―']) {
      expect(cleanProse(`Got it${d}where next?`)).toBe('Got it, where next?');
    }
  });

  it('LEAVES DIGIT RANGES alone, whitespace included', () => {
    expect(cleanProse('Lived there 2014–2016.')).toBe('Lived there 2014–2016.');
    expect(cleanProse('About 10–15% of the time.')).toBe('About 10–15% of the time.');
    expect(replaceClauseDashes('2014 – 2016')).toBe('2014 – 2016');
  });

  it('never corrupts a HYPHEN, which is a word joiner and not in the class', () => {
    expect(cleanProse('You moved to Nieuw-West, on-device processing stays off.'))
      .toBe('You moved to Nieuw-West, on-device processing stays off.');
  });

  it('DROPS a leading or trailing dash rather than emitting a stray comma', () => {
    expect(cleanProse('— Got it.')).toBe('Got it.');
    expect(cleanProse('Got it —')).toBe('Got it');
  });

  it('never concatenates the two sides', () => {
    expect(replaceClauseDashes('a—b')).toBe('a, b');
  });

  it('collapses the double space the replacement would otherwise leave', () => {
    expect(cleanProse('Got it  —  where next?')).toBe('Got it, where next?');
  });

  it('is a no-op on clean prose and on empty input', () => {
    expect(cleanProse('Got it, where next?')).toBe('Got it, where next?');
    expect(cleanProse('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The router prompt must not MODEL the character it bans.
// ---------------------------------------------------------------------------
describe('the router prompt practises what it preaches', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildRouterPrompt } = require('../router-prompt');

  const surfaces = ['ONBOARDING', 'CONFIG'] as const;

  it.each(surfaces)('%s: no em or en dash outside the ban clause itself', (surface) => {
    const prompt: string = buildRouterPrompt({ surface, languageName: 'Dutch' });
    // The PUNCTUATION rule has to contain the characters in order to name them
    // and to show the counter-example, so it is the one exempt block. Strip it
    // and nothing else may carry one.
    const withoutBan = prompt
      .split('\n')
      .filter((l) => !/PUNCTUATION|The dash slips in most often|✗|✓/.test(l))
      .join('\n');
    const found = withoutBan.match(/[—–―]/g) ?? [];
    expect(found).toEqual([]);
  });

  it('the ban clause itself is still intact, so the strip above is not hiding a deletion', () => {
    const prompt: string = buildRouterPrompt({ surface: 'CONFIG' });
    expect(prompt).toContain('Never use an em dash');
    expect(prompt).toMatch(/[—]/); // the rule still demonstrates the character
  });
});
