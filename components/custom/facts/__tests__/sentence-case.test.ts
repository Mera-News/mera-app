import { sentenceCase } from '../sentence-case';

describe('sentenceCase', () => {
  it('raises only the first letter and never lowers an acronym', () => {
    expect(sentenceCase('interested in privacy-preserving AI')).toBe('Interested in privacy-preserving AI');
    expect(sentenceCase('follows the EU Digital Markets Act (DMA)')).toBe('Follows the EU Digital Markets Act (DMA)');
  });
  it('skips leading punctuation and leaves digits alone', () => {
    expect(sentenceCase('"quiet" news')).toBe('"Quiet" news');
    expect(sentenceCase('5G rollout')).toBe('5G rollout');
  });
  it('is a no-op for scripts without case and for empty text', () => {
    expect(sentenceCase('ข่าว')).toBe('ข่าว');
    expect(sentenceCase('')).toBe('');
  });
});
