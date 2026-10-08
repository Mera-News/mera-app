import { cardState, MARK_MAX, MARK_MIN, markSizeFor, type CardStateInput } from '../card-state';

const base: CardStateInput = {
  mode: 'idle',
  noFacts: false,
  offline: false,
  articleCount: 120,
  analysedCount: 40,
  relevantCount: 6,
};

describe('cardState', () => {
  it('says nothing special when every count is there', () => {
    expect(cardState(base)).toBeNull();
  });

  it('names the first zero', () => {
    expect(cardState({ ...base, articleCount: 0, analysedCount: 0, relevantCount: 0 })).toBe('fetched');
    expect(cardState({ ...base, analysedCount: 0, relevantCount: 0 })).toBe('analysed');
    expect(cardState({ ...base, relevantCount: 0 })).toBe('relevant');
  });

  it('never says "couldn\'t analyse" while articles wait to be', () => {
    expect(cardState({ ...base, mode: 'deferred', analysedCount: 0, relevantCount: 0 })).toBeNull();
    expect(cardState({ ...base, mode: 'deferred', relevantCount: 0 })).toBe('relevant');
  });

  it('leads with the daily limit and the error over everything', () => {
    expect(cardState({ ...base, mode: 'limited' })).toBe('limited');
    expect(cardState({ ...base, mode: 'limited', articleCount: 0, offline: true, noFacts: true })).toBe('limited');
    expect(cardState({ ...base, mode: 'error' })).toBe('error');
    expect(cardState({ ...base, mode: 'error', relevantCount: 0, offline: true })).toBe('error');
  });

  it('stays out of runs and the no-facts card', () => {
    expect(cardState({ ...base, mode: 'processing', articleCount: 0 })).toBeNull();
    expect(cardState({ ...base, noFacts: true, articleCount: 0 })).toBeNull();
  });

  it('blames the connection when offline', () => {
    expect(cardState({ ...base, offline: true, articleCount: 0 })).toBe('offline');
    expect(cardState({ ...base, offline: true })).toBeNull();
  });
});

describe('markSizeFor', () => {
  it('fills the sentence block, a few pt shy, in 0.5pt steps', () => {
    expect(markSizeFor(40)).toBe(36);
    expect(markSizeFor(40.3)).toBe(36.5);
  });
  it('never shrinks below the one-line size nor grows past the column', () => {
    expect(markSizeFor(0)).toBe(MARK_MIN);
    expect(markSizeFor(20)).toBe(MARK_MIN);
    expect(markSizeFor(60)).toBe(MARK_MAX);
    expect(markSizeFor(200)).toBe(MARK_MAX);
  });
});
