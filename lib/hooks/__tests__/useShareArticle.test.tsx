// useShareArticle (r6c) — verifies:
//  • the shared URL carries Mera's UTM referrer with utm_medium=share;
//  • when a `displayedTitle` is supplied it is shared verbatim (the exact title
//    variant the reader sees), otherwise the status-based original/English pick
//    is used;
//  • whenever the resolved (primary) title differs from `titleOriginal`, the
//    original-language title rides along as a second line — the fix for a
//    translated headline shipping next to an untranslated-language link with
//    nothing to connect the two; when they're the same string (an English
//    article, or the reader was already viewing the original) the payload
//    stays exactly as it was: a single title line;
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

    it('shares the displayedTitle verbatim when provided, plus the original title since they differ', async () => {
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
        // Original-language title rides along on the very next line since it
        // differs from what the reader was actually looking at.
        expect(message).toContain('The exact on-screen title\nOriginal title');
    });

    it('includes the original title alongside the English fallback when no displayedTitle (the QA-reported bug)', async () => {
        // This is the exact shape QA captured: a feed card (no displayedTitle)
        // for a non-English article shares only the English title, paired with
        // a link that lands on the untranslated original page.
        mockGetArticleTranslatableStatus.mockReturnValue('translatable');
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain('English title');
        expect(message).toContain('Original title');
        // Reader's title leads; original-language title is the very next line.
        expect(message).toContain('English title\nOriginal title');
    });

    it('does not duplicate the title when the article is in the app language (titles identical)', async () => {
        mockGetArticleTranslatableStatus.mockReturnValue('same-language');
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain('Original title');
        expect(message).not.toContain('English title');
        // Only ever appears once — no duplicated title line.
        expect(message.split('Original title')).toHaveLength(2);
    });

    it('prefers displayedTitle even when the status pick would differ, and still appends the original', async () => {
        mockGetArticleTranslatableStatus.mockReturnValue('same-language');
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            displayedTitle: 'Currently shown',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message).toContain('Currently shown');
        expect(message).toContain('Currently shown\nOriginal title');
    });

    it('does not duplicate the title when displayedTitle equals the original (reader already viewing it)', async () => {
        await share({
            url: ARTICLE_URL,
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            displayedTitle: 'Original title',
        });
        const [{ message }] = shareSpy.mock.calls[0];
        expect(message.split('Original title')).toHaveLength(2);
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
});

// ── pure helpers ─────────────────────────────────────────────────────────
// Exercised directly (no hook/render machinery) since these carry the actual
// title-precedence and message-assembly logic.
describe('resolveShareTitles', () => {
    it('returns only a primary title when titles are identical (same-language status)', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            status: 'same-language',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'Original title', secondary: null });
    });

    it('returns both when the translatable-status pick differs from the original', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'English title', secondary: 'Original title' });
    });

    it('lets displayedTitle lead, with the original as secondary when it differs', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            status: 'same-language',
            displayedTitle: 'Currently shown',
        });
        expect(result).toEqual({ primary: 'Currently shown', secondary: 'Original title' });
    });

    it('drops the secondary when displayedTitle equals the original title', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: 'Original title',
            status: 'translatable',
            displayedTitle: 'Original title',
        });
        expect(result).toEqual({ primary: 'Original title', secondary: null });
    });

    it('has no secondary when there is no original title at all', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: null,
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'English title', secondary: null });
    });

    it('has no secondary when titleOriginal is an empty/whitespace string', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: '   ',
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'English title', secondary: null });
    });

    it('falls back to titleEnglish when same-language status has no titleOriginal', () => {
        const result = resolveShareTitles({
            titleEnglish: 'English title',
            titleOriginal: null,
            status: 'same-language',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'English title', secondary: null });
    });

    it('falls back to titleOriginal when a translatable article has no titleEnglish', () => {
        const result = resolveShareTitles({
            titleEnglish: null,
            titleOriginal: 'Original title',
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: 'Original title', secondary: null });
    });

    it('resolves to a null primary (and no secondary) when every title input is absent', () => {
        const result = resolveShareTitles({
            titleEnglish: null,
            titleOriginal: null,
            status: 'translatable',
            displayedTitle: null,
        });
        expect(result).toEqual({ primary: null, secondary: null });
    });
});

describe('buildShareMessage', () => {
    it('joins a single title, the URL, and the footer with blank lines', () => {
        const message = buildShareMessage({
            primaryTitle: 'Title',
            secondaryTitle: null,
            url: 'https://example.com',
            footer: 'Shared via https://mera.news',
        });
        expect(message).toBe('Title\n\nhttps://example.com\n\nShared via https://mera.news');
    });

    it('puts the secondary title directly under the primary, still one blank-line-separated block', () => {
        const message = buildShareMessage({
            primaryTitle: 'Translated title',
            secondaryTitle: 'Original title',
            url: 'https://example.com',
            footer: 'Shared via https://mera.news',
        });
        expect(message).toBe(
            'Translated title\nOriginal title\n\nhttps://example.com\n\nShared via https://mera.news',
        );
    });

    it('falls back to the secondary alone when there is no primary', () => {
        const message = buildShareMessage({
            primaryTitle: null,
            secondaryTitle: 'Original title',
            url: 'https://example.com',
            footer: 'Shared via https://mera.news',
        });
        expect(message).toBe('Original title\n\nhttps://example.com\n\nShared via https://mera.news');
    });

    it('drops the title block entirely when neither title is present', () => {
        const message = buildShareMessage({
            primaryTitle: null,
            secondaryTitle: null,
            url: 'https://example.com',
            footer: 'Shared via https://mera.news',
        });
        expect(message).toBe('https://example.com\n\nShared via https://mera.news');
    });

    it('omits a falsy URL or footer without leaving stray blank lines', () => {
        const message = buildShareMessage({
            primaryTitle: 'Title',
            secondaryTitle: null,
            url: null,
            footer: '',
        });
        expect(message).toBe('Title');
    });
});
