// useShareArticle: builds the one message a share carries (the title the reader sees, the tagged
// link, a "Shared via" footer in the title's language) and hands it to the native share sheet.
// The sheet (react-native Share) and the logger are the edges; the real app-language store, i18n
// bundles, translation-service and URL helpers run.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import { act, renderHook } from '@testing-library/react-native';
import { Share } from 'react-native';
import { REFERRER_SOURCE, WEBSITE_URL } from '@/lib/config/branding';
import { buildShareMessage, resolveShareTitles, useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import i18n from '@/lib/i18n';
import logger from '@/lib/logger';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';

const URL_ = 'https://nos.nl/a1';
const TAGGED = `${URL_}?utm_source=${REFERRER_SOURCE}&utm_medium=share`;
const FOOTER_EN = `Shared via ${WEBSITE_URL}`;
const FOOTER_DE = `Geteilt über ${WEBSITE_URL}`;

let share: jest.SpyInstance;

beforeEach(async () => {
  share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
  await i18n.changeLanguage('en');
  useAppLanguageStore.setState({ appLanguage: 'en' });
});

afterEach(async () => {
  share.mockRestore();
  useAppLanguageStore.setState({ appLanguage: 'en' });
  await i18n.changeLanguage('en');
});

async function tap(params: ShareArticleParams | undefined) {
  const { result } = renderHook(() => useShareArticle(params));
  await act(async () => {
    await result.current();
  });
}

describe('resolveShareTitles', () => {
  it('shares the exact on-screen title when the caller supplies one', () => {
    expect(
      resolveShareTitles({ titleEnglish: 'English', titleOriginal: 'Original', status: 'translatable', displayedTitle: 'Shown' }),
    ).toEqual({ primary: 'Shown' });
  });

  it('picks the original title for a same-language article, English otherwise', () => {
    const base = { titleEnglish: 'English', titleOriginal: 'Original' };
    expect(resolveShareTitles({ ...base, status: 'same-language' })).toEqual({ primary: 'Original' });
    expect(resolveShareTitles({ ...base, status: 'translatable' })).toEqual({ primary: 'English' });
    expect(resolveShareTitles({ ...base, status: 'not-translatable', reason: 'unsupported-language' } as never)).toEqual({ primary: 'English' });
  });

  it('falls back to the other title when the preferred one is missing, and to null', () => {
    expect(resolveShareTitles({ titleEnglish: 'English', titleOriginal: null, status: 'same-language' })).toEqual({ primary: 'English' });
    expect(resolveShareTitles({ titleEnglish: null, titleOriginal: 'Original', status: 'translatable' })).toEqual({ primary: 'Original' });
    expect(resolveShareTitles({ titleEnglish: null, status: 'translatable' })).toEqual({ primary: null });
  });
});

describe('buildShareMessage', () => {
  it('joins title, link and footer with blank lines and skips empty parts', () => {
    expect(buildShareMessage({ primaryTitle: 'T', url: 'https://x.y', footer: 'F' })).toBe('T\n\nhttps://x.y\n\nF');
    expect(buildShareMessage({ primaryTitle: null, url: 'https://x.y', footer: 'F' })).toBe('https://x.y\n\nF');
    expect(buildShareMessage({ primaryTitle: 'T', url: null, footer: 'F' })).toBe('T\n\nF');
  });
});

describe('useShareArticle', () => {
  it('shares the English title, the utm-tagged link and the footer in the app language', async () => {
    await tap({ url: URL_, titleEnglish: 'Dike repair starts', titleOriginal: null });

    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith(
      { message: `Dike repair starts\n\n${TAGGED}\n\n${FOOTER_EN}` },
      { subject: 'Dike repair starts' },
    );
  });

  it('ships only the displayed title, with the footer in that title\'s language', async () => {
    await tap({
      url: URL_,
      titleEnglish: 'Dike repair starts',
      titleOriginal: 'Deichreparatur beginnt',
      displayedTitle: 'Deichreparatur beginnt',
      displayedLanguage: 'de',
    });

    const [{ message }, options] = share.mock.calls[0];
    expect(message).toBe(`Deichreparatur beginnt\n\n${TAGGED}\n\n${FOOTER_DE}`);
    expect(message).not.toContain('Dike repair starts');
    expect(options).toEqual({ subject: 'Deichreparatur beginnt' });
  });

  it('keeps the footer in the app language when the title\'s language has no bundle', async () => {
    useAppLanguageStore.setState({ appLanguage: 'de' });
    await i18n.changeLanguage('de');

    // 'sw' (Swahili) ships no UI strings: the sharer's own language wins over English.
    await tap({ url: URL_, titleEnglish: 'T', displayedTitle: 'Kichwa', displayedLanguage: 'sw' });

    expect(share.mock.calls[0][0].message).toBe(`Kichwa\n\n${TAGGED}\n\n${FOOTER_DE}`);
  });

  it('picks the original title when the article is already in the app language', async () => {
    useAppLanguageStore.setState({ appLanguage: 'de' });
    await i18n.changeLanguage('de');

    await tap({ url: URL_, titleEnglish: 'Dike repair starts', titleOriginal: 'Deichreparatur beginnt', sourceLanguage: 'de' });

    expect(share.mock.calls[0][0].message).toBe(`Deichreparatur beginnt\n\n${TAGGED}\n\n${FOOTER_DE}`);
  });

  it('does not override an existing utm_source on the link', async () => {
    await tap({ url: `${URL_}?utm_source=newsletter`, titleEnglish: 'T' });

    expect(share.mock.calls[0][0].message).toContain(`${URL_}?utm_source=newsletter\n\n`);
    expect(share.mock.calls[0][0].message).not.toContain('utm_medium');
  });

  it.each([
    ['no params', undefined],
    ['no url', { url: null, titleEnglish: 'T' }],
    ['an empty url', { url: '', titleEnglish: 'T' }],
    ['a plaintext http url', { url: 'http://nos.nl/a1', titleEnglish: 'T' }],
    ['a non-url string', { url: 'not a url', titleEnglish: 'T' }],
  ])('shares nothing for %s', async (_name, params) => {
    await tap(params as ShareArticleParams | undefined);
    expect(share).not.toHaveBeenCalled();
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('reports a failed share sheet instead of throwing', async () => {
    const boom = new Error('share failed');
    share.mockRejectedValueOnce(boom);

    await expect(tap({ url: URL_, titleEnglish: 'T' })).resolves.toBeUndefined();

    expect(logger.captureException).toHaveBeenCalledWith(boom, { tags: { hook: 'useShareArticle' } });
  });
});
