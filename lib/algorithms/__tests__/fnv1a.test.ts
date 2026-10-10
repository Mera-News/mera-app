import { fnv1a32 } from '../fnv1a';

// Golden vectors: recorded from the pre-extraction copies (section-color hashString,
// translation-cache-service hashSourceText, scheduler/jitter hash01,
// chat-tools/fact-choice-resolution fnv1a, facts-draft-service factsFingerprint).
// Stored keys depend on these outputs, so they must never change.
// [input, hash, hashSourceText suffix-less hex + len36, hash01, padded hex]
const VECTORS: [string, number, string, number, string][] = [
  ['', 2166136261, '811c9dc50', 0.5043428998906165, '811c9dc5'],
  ['a', 3826002220, 'e40c292c1', 0.8908105595037341, 'e40c292c'],
  ['The quick brown fox jumps over the lazy dog', 76545936, '48fff9017', 0.01782223954796791, '048fff90'],
  ['é', 1812687940, '6c0b6c441', 0.422049299813807, '6c0b6c44'],
  ['\u{1F600}', 3409036472, 'cb31c4b82', 0.7937281560152769, 'cb31c4b8'],
  ['mera'.repeat(2500), 866975141, '33acfda57ps', 0.20185838011093438, '33acfda5'],
  ['652f1c2e9b1e8a0012345678', 3269674543, 'c2e3462fo', 0.761280428385362, 'c2e3462f'],
  ['Parlament stimmt über Haushalt ab', 3289002817, 'c40a3341x', 0.7657806428615004, 'c40a3341'],
];

describe('fnv1a32', () => {
  it.each(VECTORS)('matches every old copy for %j', (input, n, hexLen36, unit, padded) => {
    const h = fnv1a32(input);
    expect(h).toBe(n);
    expect(`${h.toString(16)}${input.length.toString(36)}`).toBe(hexLen36);
    expect(h / 0x1_0000_0000).toBe(unit);
    expect(h.toString(16).padStart(8, '0')).toBe(padded);
    expect(h.toString(16)).toBe(padded.replace(/^0+(?=.)/, ''));
  });
});
