import { formatCategories, hostOf, monogramOf, sourceKindOf } from '../publication-format';

describe('hostOf', () => {
    it.each([
        ['https://www.thehindu.com/news/', 'thehindu.com'],
        ['http://timesofindia.indiatimes.com', 'timesofindia.indiatimes.com'],
        ['https://example.com:8443/a?b=c#d', 'example.com'],
        ['//cdn.example.org/x', 'cdn.example.org'],
        ['example.net/path', 'example.net'],
    ])('%s -> %s', (url, host) => {
        expect(hostOf(url)).toBe(host);
    });

    it('is null for nothing usable', () => {
        expect(hostOf(null)).toBeNull();
        expect(hostOf('   ')).toBeNull();
        expect(hostOf('not a url')).toBeNull();
    });
});

describe('monogramOf', () => {
    it('takes the first code point after trimming, upper-cased where the script has case', () => {
        expect(monogramOf('  the hindu')).toBe('T');
        expect(monogramOf('Ведомости')).toBe('В');
        expect(monogramOf('人民日报')).toBe('人');
        expect(monogramOf('الجزيرة')).toBe('ا');
    });

    it('keeps a surrogate pair whole', () => {
        expect(monogramOf('𝕏 news')).toBe('𝕏');
    });

    it('falls back to a question mark for an empty name', () => {
        expect(monogramOf('')).toBe('?');
        expect(monogramOf(null)).toBe('?');
    });
});

describe('sourceKindOf', () => {
    it('badges only government and regulator', () => {
        expect(sourceKindOf('government')).toBe('government');
        expect(sourceKindOf('regulator')).toBe('regulator');
        expect(sourceKindOf('newspaper')).toBeNull();
        expect(sourceKindOf(null)).toBeNull();
    });
});

describe('formatCategories', () => {
    it('humanizes slugs and joins them', () => {
        expect(formatCategories(['general_news', 'politics'])).toBe('General news, Politics');
        expect(formatCategories([])).toBeNull();
        expect(formatCategories(null)).toBeNull();
    });
});
