import { estimateTokens } from '../tokens';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates Latin text at ~4 chars/token', () => {
    // 8 ASCII chars → ceil(8 / 4) = 2
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('rounds up partial Latin tokens', () => {
    // 5 chars → ceil(5 / 4) = 2
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('estimates CJK text at ~1.2 chars/token', () => {
    // 6 CJK chars → ceil(6 / 1.2) = 5
    expect(estimateTokens('你好世界再見')).toBe(5);
  });

  it('handles mixed CJK and Latin scripts additively', () => {
    // 2 CJK → ceil(2 / 1.2) = 2; 5 Latin ("hello") → ceil(5 / 4) = 2; total 4
    expect(estimateTokens('你好hello')).toBe(4);
  });

  it('treats a single CJK char as at least one token', () => {
    expect(estimateTokens('字')).toBe(1);
  });

  it('counts whitespace and punctuation as non-CJK chars', () => {
    // "hi, there!" = 10 chars → ceil(10 / 4) = 3
    expect(estimateTokens('hi, there!')).toBe(3);
  });
});
