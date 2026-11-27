import { formatCategories, homepageUrlOf, hostOf, monogramHueOf, monogramOf, readingScoreBand, readingScoreInk, sourceKindOf } from '@/components/custom/publication-page/publication-format';

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

describe('homepageUrlOf', () => {
    it('upgrades an http homepage to https', () => {
        expect(homepageUrlOf('http://x.cz/')).toBe('https://x.cz/');
        expect(homepageUrlOf('  HTTP://denik.cz/  ')).toBe('https://denik.cz/');
    });

    it('keeps an https homepage as it is', () => {
        expect(homepageUrlOf('https://www.thehindu.com/')).toBe('https://www.thehindu.com/');
    });

    it('hides anything that is not a web link', () => {
        expect(homepageUrlOf('javascript:alert(1)')).toBeNull();
        expect(homepageUrlOf('not a url')).toBeNull();
        expect(homepageUrlOf('ftp://x.cz/')).toBeNull();
        expect(homepageUrlOf('')).toBeNull();
        expect(homepageUrlOf(null)).toBeNull();
    });
});

describe('monogramHueOf', () => {
    it('is stable for a name, ignoring case and outer spaces', () => {
        expect(monogramHueOf('The Hindu')).toBe(monogramHueOf('  the hindu '));
    });

    it('is a whole degree in 0..359, for every script and for nothing', () => {
        for (const name of ['The Hindu', 'Ведомости', '人民日报', 'الجزيرة', '', null]) {
            const hue = monogramHueOf(name);
            expect(Number.isInteger(hue)).toBe(true);
            expect(hue).toBeGreaterThanOrEqual(0);
            expect(hue).toBeLessThan(360);
        }
    });

    it('tells apart outlets that share a first letter', () => {
        const hues = new Set(['The Hindu', 'The Guardian', 'The Times of Bengal', 'The Print'].map(monogramHueOf));
        expect(hues.size).toBeGreaterThan(1);
    });
});

describe('readingScoreBand', () => {
    it.each([
        [100, 'top'], [90, 'top'], [89, 'good'], [75, 'good'], [74, 'fair'], [50, 'fair'], [49, 'low'], [0, 'low'],
    ] as const)('%d -> %s', (score, band) => {
        expect(readingScoreBand(score)).toBe(band);
    });
});

describe('readingScoreInk', () => {
    it('is the site colour for the mode, never swapped', () => {
        expect(readingScoreInk(92, 'dark')).toBe('#34D399');
        expect(readingScoreInk(92, 'light')).toBe('#059669');
        expect(readingScoreInk(40, 'dark')).toBe('#F97316');
        expect(readingScoreInk(40, 'light')).toBe('#C2410C');
    });
});
