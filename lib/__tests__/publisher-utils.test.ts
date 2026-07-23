import { extractDomain } from '@/lib/publisher-utils';

describe('extractDomain', () => {
    it('strips protocol, www, and common TLD', () => {
        expect(extractDomain('https://www.bbc.com/news/article')).toBe('bbc');
    });

    it('returns the input unchanged when it is not a URL', () => {
        expect(extractDomain('not a url')).toBe('not a url');
    });
});
