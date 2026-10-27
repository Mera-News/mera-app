import { relatedHeadingCount } from '@/components/custom/news-detail/related-count';

const facets = (c: number, l: number) =>
  ({
    countries: [{ code: 'NLD', count: c - 1 }, { code: 'DEU', count: 1 }],
    languages: [{ code: 'en', count: l }],
  }) as never;
const base = { local: 2, served: 3, hasNextPage: true, error: false, loading: false, facets: facets(12, 10), facetsExcludeKey: 'a b', excludeKey: 'a b' };

describe('relatedHeadingCount', () => {
  it('adds the larger facet sum to the local rows while more pages remain', () => {
    expect(relatedHeadingCount(base)).toBe(2 + 12);
  });
  it('hides while the facets were fetched under another exclusion set', () => {
    expect(relatedHeadingCount({ ...base, excludeKey: 'a b c' })).toBeNull();
  });
  it('at the end of the list counts the rows served, not the facet total', () => {
    expect(relatedHeadingCount({ ...base, hasNextPage: false, served: 9 })).toBe(2 + 9);
  });
  it('hides on error, while loading, and at zero', () => {
    expect(relatedHeadingCount({ ...base, error: true })).toBeNull();
    expect(relatedHeadingCount({ ...base, loading: true })).toBeNull();
    expect(relatedHeadingCount({ ...base, local: 0, facets: facets(0, 0) as never, hasNextPage: false, served: 0, facetsExcludeKey: 'a b' })).toBeNull();
  });
});
