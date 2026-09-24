// The article actions every surface shares (••• menu, detail screens): the
// https guard, the History visit record, the failure path, and the Google
// Translate URL. Real translation-service, native module stubbed.

jest.mock('expo-translate-text', () => ({ onTranslateTask: jest.fn() }));
jest.mock('expo-device', () => ({ osVersion: '18.0' }));
const mockCapture = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: (...a: unknown[]) => mockCapture(...a),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        addBreadcrumb: jest.fn(),
    },
}));
const mockRecordVisit = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    recordPublicationVisit: (...a: unknown[]) => mockRecordVisit(...a),
}));
const mockOpenArticle = jest.fn((..._a: unknown[]) => Promise.resolve());
const mockOpenInApp = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/lib/web-browser-utils', () => ({
    openArticleInAppBrowser: (...a: unknown[]) => mockOpenArticle(...a),
    openInAppBrowser: (...a: unknown[]) => mockOpenInApp(...a),
    appendReferrer: (u: string) => `${u}?utm_source=mera.news`,
}));

import { isForeignLanguage, openInGoogleTranslate, openOnSource } from '../article-actions';

const VISIT = {
    publicationName: 'NOS',
    countryCode: 'NL',
    articleId: 'a1',
} as unknown as import('../article-actions').VisitInput;

beforeEach(() => jest.clearAllMocks());

describe('openOnSource', () => {
    it('refuses a plain http URL: opens nothing, records nothing', async () => {
        await expect(openOnSource('http://nos.nl/a', VISIT)).resolves.toBe(false);
        expect(mockOpenArticle).not.toHaveBeenCalled();
        expect(mockRecordVisit).not.toHaveBeenCalled();
    });

    it('opens an https URL and records the publication visit that backs History', async () => {
        await expect(openOnSource('https://nos.nl/a', VISIT)).resolves.toBe(true);
        expect(mockRecordVisit).toHaveBeenCalledWith({ ...VISIT, articleUrl: 'https://nos.nl/a' });
        expect(mockOpenArticle).toHaveBeenCalledWith('https://nos.nl/a');
    });

    it('reports a browser that fails to open: false, and the error reaches Sentry', async () => {
        mockOpenArticle.mockRejectedValueOnce(new Error('no browser'));
        await expect(openOnSource('https://nos.nl/a')).resolves.toBe(false);
        expect(mockCapture).toHaveBeenCalledTimes(1);
    });
});

describe('openInGoogleTranslate', () => {
    it('opens Google Translate on the referrer-wrapped article, into the reader\'s language', async () => {
        await expect(openInGoogleTranslate('https://nos.nl/a', 'en')).resolves.toBe(true);
        const url = mockOpenInApp.mock.calls[0][0] as string;
        expect(url.startsWith('https://translate.google.com/translate?sl=auto&tl=en&u=')).toBe(true);
        expect(decodeURIComponent(url.split('&u=')[1])).toBe('https://nos.nl/a?utm_source=mera.news');
    });

    it('refuses a plain http URL', async () => {
        await expect(openInGoogleTranslate('http://nos.nl/a', 'en')).resolves.toBe(false);
        expect(mockOpenInApp).not.toHaveBeenCalled();
    });

    it('reports a browser that fails to open', async () => {
        mockOpenInApp.mockRejectedValueOnce(new Error('no browser'));
        await expect(openInGoogleTranslate('https://nos.nl/a', 'en')).resolves.toBe(false);
        expect(mockCapture).toHaveBeenCalledTimes(1);
    });
});

describe('isForeignLanguage', () => {
    it('compares primary subtags, and treats an unknown language as foreign', () => {
        expect(isForeignLanguage('en-GB', 'en')).toBe(false);
        expect(isForeignLanguage('nl', 'en')).toBe(true);
        expect(isForeignLanguage(null, 'en')).toBe(true);
    });
});
