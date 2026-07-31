// The category gate: which category values may become a STRUCTURED filter.
//
// The values below are real prod `publication-source.category` entries
// (measured 2026-07-29 — see category-specificity.ts for the distribution), not
// invented examples, so this test fails if the stemmer stops folding the family
// it was built for.

import { categoryStem, isDiscriminatingCategory } from '../category-specificity';

describe('categoryStem', () => {
  it('folds the whole observed generic family onto two stems', () => {
    expect(categoryStem('News')).toBe('news');
    expect(categoryStem('  news  ')).toBe('news');
    expect(categoryStem('News (French)')).toBe('news');
    expect(categoryStem('News (English, Pidgin)')).toBe('news');
    expect(categoryStem('News (Portuguese, Cape Verdean Creole)')).toBe('news');
    expect(categoryStem('general_news')).toBe('general news');
    expect(categoryStem('General News')).toBe('general news');
  });

  it('leaves a subject-naming category intact', () => {
    expect(categoryStem('Sports')).toBe('sports');
    expect(categoryStem('Business & Economy')).toBe('business & economy');
    expect(categoryStem('Tech - Auto')).toBe('tech auto');
    // A colon is NOT stripped — the region is what makes this discriminating.
    expect(categoryStem('Regional News: Kolkata')).toBe('regional news: kolkata');
  });

  it('is empty for an absent value', () => {
    expect(categoryStem(null)).toBe('');
    expect(categoryStem(undefined)).toBe('');
    expect(categoryStem('   ')).toBe('');
  });
});

describe('isDiscriminatingCategory', () => {
  // ~74% of the catalogue (2567 of 3475 sources) sits on these.
  it.each([
    'News',
    'news',
    'general_news',
    'General News',
    'News (French)',
    'News (English)',
    'News (Arabic)',
    'News (English, Pidgin)',
    'News (Telugu)',
  ])('rejects the generic value %p', (value) => {
    expect(isDiscriminatingCategory(value)).toBe(false);
  });

  it.each([
    'Sports',
    'Tech',
    'Technology',
    'Business',
    'Science',
    'Cricket',
    'Programming',
    'Entertainment',
    'Regional News: Kolkata',
  ])('accepts the specific value %p', (value) => {
    expect(isDiscriminatingCategory(value)).toBe(true);
  });

  it('rejects an absent or blank value (nothing to match on)', () => {
    expect(isDiscriminatingCategory(null)).toBe(false);
    expect(isDiscriminatingCategory(undefined)).toBe(false);
    expect(isDiscriminatingCategory('  ')).toBe(false);
  });
});
