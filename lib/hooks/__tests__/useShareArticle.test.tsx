// useShareArticle (r6c, B6) — verifies:
//  • the shared URL carries Mera's UTM referrer with utm_medium=share;
//  • when a `displayedTitle` is supplied it is shared verbatim (the exact title
//    variant the reader sees), otherwise the status-based original/English pick
//    is used;
//  • only ONE title ever ships — the variant currently on screen — never the
//    original-language title alongside it;
//  • the "Shared via" footer is rendered in the language of the shared title,
//    falling back to the app language when that language has no locale bundle;
//  • a missing URL is a no-op.
//
// NOTE: `t` is mocked here, so these cases pin the LNG THIS HOOK PASSES, not
// i18next's handling of it. That the real instance honours a per-call `lng`
// override is asserted in lib/i18n/__tests__/i18n.test.ts.

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) =>
            opts ? `${key}::${JSON.stringify(opts)}` : key,
    }),
}));

let mockAppLanguage = 'en';
jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguage: () => mockAppLanguage,
}));

const mockGetArticleTranslatableStatus = jest.fn();
// Stands in for the real resolveUiLocale: a code the app ships strings for maps
// to itself, anything else is null. (The real one is covered in
// lib/__tests__/translation-service.test.ts.)
const UI_LOCALES = ['en', 'de', 'hi', 'pt', 'zh-Hans'];
jest.mock('@/lib/translation-service', () => ({
    getArticleTranslatableStatus: (...args: unknown[]) => mockGetArticleTranslatableStatus(...args),
    resolveUiLocale: (code: string | null | undefined) =>
        (code && UI_LOCALES.includes(code) ? code : null),
}));

// appendReferrer(url, medium) — returns a recognizable wrapped URL so we can
// assert both the medium and that the wrapped URL is what gets shared.
jest.mock('@/lib/web-browser-utils', () => ({
    appendReferrer: (url: string, medium?: string) => `${url}?utm_source=mera.news&utm_medium=${medium ?? 'referral'}`,
}));

jest.mock('@/lib/config/branding', () => ({ WEBSITE_URL: 'https://mera.news' }));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

import { renderHook } from '@testing-library/react-native';
import { Share } from 'react-native';
import {
    buildShareMessage, resolveShareTitles, useShareArticle, type ShareArticleParams,
} from '../useShareArticle';

const ARTICLE_URL = 'https://publisher.example.com/story';
const SHARE_URL = `${ARTICLE_URL}?utm_source=mera.news&utm_medium=share`;

function share(params: ShareArticleParams | undefined) {
    const { result } = renderHook(() => useShareArticle(params));
    return result.current();
}

describe('useShareArticle', () => {
    let shareSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        mockAppLanguage = 'en';
        mockGetArticleTranslatableStatus.mockReturnValue('translatable');
        shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    });

    afterEach(() => shareSpy.mockRestore());

    it('shares the URL with utm_medium=share appended', async () => {
        await share({ url: ARTICLE_URL, titleEnglish: 'English title' });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain(SHARE_URL);
        expect(message).not.toContain(`${ARTICLE_URL}\n`);
    });

    it('shares the displayedTitle verbatim when provided, and nothing else', async () => {
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            displayedTitle: 'The exact on-screen title',
        });
        const [{ message }, opts] = shareSpy.mock.calls[0];
        expect(message).toContain('The exact on-screen title');
        expect(opts.subject).toBe('The exact on-screen title');
        expect(message).not.toContain('English title');
        expect(message).not.toContain('Original title');
    });

    it('shares only the English title (no original-language line) when no displayedTitle', async () => {
        mockGetArticleTranslatableStatus.mockReturnValue('translatable');
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain('English title');
        expect(message).not.toContain('Original title');
    });

    it('shares the original title when the article is in the app language', async () => {
        mockGetArticleTranslatableStatus.mockReturnValue('same-language');
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain('Original title');
        expect(message).not.toContain('English title');
        // Only ever appears once.
        expect(message.split('Original title')).toHaveLength(2);
    });

    it('prefers displayedTitle even when the status pick would differ', async () => {
        mockGetArticleTranslatableStatus.mockReturnValue('same-language');
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            displayedTitle: 'Currently shown',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain('Currently shown');
        expect(message).not.toContain('Original title');
        expect(message).not.toContain('English title');
    });

    it('shares just the single title when there is no original title at all', async () => {
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            displayedTitle: 'The exact on-screen title',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain('The exact on-screen title');
        expect(message).not.toContain('English title');
        // No stray second line / label was introduced.
        expect(message.startsWith('The exact on-screen title\n\n')).toBe(true);
    });

    // ── footer language ──────────────────────────────────────────────────────
    // The mocked `t` serialises its options, so the emitted `lng` is visible in
    // the shared message.
    function footerLng(): string | undefined {
        const [{ message }] = shareSpy.mock.calls[0];
        const line = message.split('\n\n').find((l: string) => l.startsWith('articleDetail.shareVia'));
        return line ? JSON.parse(line.split('::')[1]).lng : undefined;
    }

    it('renders the footer in the displayed title\'s language', async () => {
        mockAppLanguage = 'de';
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'मूल शीर्षक',
            sourceLanguage: 'hi',
            displayedTitle: 'मूल शीर्षक',
            displayedLanguage: 'hi',
        });
        expect(footerLng()).toBe('hi');
    });

    it('follows the title back to the app language when the translation is shown', async () => {
        mockAppLanguage = 'de';
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'मूल शीर्षक',
            sourceLanguage: 'hi',
            displayedTitle: 'Deutscher Titel',
            displayedLanguage: 'de',
        });
        expect(footerLng()).toBe('de');
    });

    it('falls back to the app language when the title\'s language has no bundle', async () => {
        mockAppLanguage = 'de';
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'ମୂଳ ଶିରୋନାମା',
            sourceLanguage: 'or',
            displayedTitle: 'ମୂଳ ଶିରୋନାମା',
            displayedLanguage: 'or',
        });
        expect(footerLng()).toBe('de');
    });

    it('falls back to the app language when no displayedLanguage is given (feed cards)', async () => {
        mockAppLanguage = 'de';
        await share({ url: ARTICLE_URL, titleEnglish: 'English title' });
        expect(footerLng()).toBe('de');
    });

    it('is a no-op when the URL is missing', async () => {
        await share({ url: null, titleEnglish: 'English title' });
        expect(shareSpy).not.toHaveBeenCalled();
    });

    // Item 16 — sharing an insecure link pushes it onto somebody else's device,
    // which is strictly worse than opening it on this one. The detail screens
    // already hide the affordance; this is the backstop.
    it.each([
        'http://publisher.example.com/story',
        'javascript:alert(1)',
        'publisher.example.com/story',
    ])('is a no-op for the non-https URL %p', async (url) => {
        await share({ url, titleEnglish: 'English title' });
        expect(shareSpy).not.toHaveBeenCalled();
    });
});

// ── pure helpers ─────────────────────────────────────────────────────────
// Exercised directly (no hook/render machinery) since these carry the actual
// title-precedence and message-assembly logic.
describe('resolveShareTitles', () => {
    it('returns the original title (same-language status)', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            status: 'same-language',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'Original title' });
    });

    it('returns the English title for a translatable article with no displayedTitle', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'English title' });
    });

    it('lets displayedTitle lead over the status-based pick', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            status: 'same-language',
            displayedTitle: 'Currently shown',
        });
        expect(result).toEqual({ primary: 'Currently shown' });
    });

    it('falls back to titleEnglish when same-language status has no titleOriginal', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: null,
            status: 'same-language',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'English title' });
    });

    it('falls back to titleOriginal when a translatable article has no titleEnglish', () => {
        const result = resolveShareTitles({
            titleEnglish: null,
            titleOriginal: 'Original title',
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'Original title' });
    });

    it('resolves to a null primary when every title input is absent', () => {
        const result = resolveShareTitles({
            titleEnglish: null,
            titleOriginal: null,
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: null });
    });
});

describe('buildShareMessage', () => {
    it('joins the title, the URL, and the footer with blank lines', () => {
        const message = buildShareMessage({
            primaryTitle: 'Title',
            url: 'https://example.com',
            footer: 'Shared via https://mera.news',
        });
        expect(message).toBe('Title\n\nhttps://example.com\n\nShared via https://mera.news');
    });

    it('drops the title block entirely when there is no title', () => {
        const message = buildShareMessage({
            primaryTitle: null,
            url: 'https://example.com',
            footer: 'Shared via https://mera.news',
        });
        expect(message).toBe('https://example.com\n\nShared via https://mera.news');
    });

    it('omits a falsy URL or footer without leaving stray blank lines', () => {
        const message = buildShareMessage({
            primaryTitle: 'Title',
            url: null,
            footer: '',
        });
        expect(message).toBe('Title');
    });
});
