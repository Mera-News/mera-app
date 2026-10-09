// lib/i18n/index.ts over the real i18next instance, the real bundled locales and the real
// translation-service. Only the native I18nManager is faked: its forceRTL is spied (it persists a
// native flag) and isRTL is set per case.
import { I18nManager } from 'react-native';

import i18n, { applyLanguage, previewLanguage, APP_LANGUAGES } from '@/lib/i18n';

let isRTL = false;
let forceRTL: jest.SpyInstance;

beforeEach(() => {
  isRTL = false;
  Object.defineProperty(I18nManager, 'isRTL', { configurable: true, get: () => isRTL });
  forceRTL = jest.spyOn(I18nManager, 'forceRTL').mockImplementation((val: boolean) => {
    isRTL = val;
  });
});

afterEach(async () => {
  forceRTL.mockRestore();
  await i18n.changeLanguage('en');
});

describe('i18n initialisation', () => {
  it('i18n is initialised (isInitialized is true)', () => {
    expect(i18n.isInitialized).toBe(true);
  });

  it('default language is English', () => {
    expect(i18n.language).toBe('en');
  });

  it('fallback language includes English', () => {
    // i18next stores fallbackLng as an array internally
    const fb = i18n.options.fallbackLng;
    if (Array.isArray(fb)) {
      expect(fb).toContain('en');
    } else {
      expect(fb).toBe('en');
    }
  });

  it('has resources for English', () => {
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(true);
  });

  it('has resources for Arabic', () => {
    expect(i18n.hasResourceBundle('ar', 'translation')).toBe(true);
  });

  it('has resources for French', () => {
    expect(i18n.hasResourceBundle('fr', 'translation')).toBe(true);
  });

  it('has resources for German', () => {
    expect(i18n.hasResourceBundle('de', 'translation')).toBe(true);
  });

  it('has resources for Spanish', () => {
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(true);
  });

  it('has resources for Chinese Hans (zh-Hans)', () => {
    expect(i18n.hasResourceBundle('zh-Hans', 'translation')).toBe(true);
  });

  it('has resources for Portuguese (pt)', () => {
    expect(i18n.hasResourceBundle('pt', 'translation')).toBe(true);
  });

  it('i18n can translate a known key', () => {
    const result = i18n.t('common.cancel');
    expect(result).toBe('Cancel');
  });

  // The share footer is rendered in the language of the shared TITLE, not the
  // UI language (see lib/hooks/useShareArticle.ts). That relies on a per-call
  // `lng` override resolving against the eagerly-bundled resources without
  // changing the active language. Asserted here against the REAL instance —
  // the hook's own test mocks react-i18next, so it cannot prove this.
  it('honours a per-call lng override without changing the active language', () => {
    expect(i18n.language).toBe('en');

    const hi = i18n.t('articleDetail.shareVia', {
      downloadUrl: 'https://mera.news',
      lng: 'hi',
    });
    const en = i18n.t('articleDetail.shareVia', { downloadUrl: 'https://mera.news' });

    expect(hi).toContain('https://mera.news');
    expect(hi).not.toBe(en);
    expect(i18n.language).toBe('en');
  });

  // ...and specifically on the `t` react-i18next hands components, which is a
  // getFixedT closure, NOT i18n.t. If the fixed-t override didn't win, the
  // footer would silently stay in the app language with nothing failing.
  it('honours lng on the fixed t that useTranslation returns', () => {
    // Loosely typed on purpose: the strict TFunction overloads reject a
    // runtime-built { lng } options bag, and this test exercises exactly that
    // runtime behaviour.
    const t = i18n.getFixedT(null, 'translation') as unknown as (
      key: string,
      opts?: Record<string, unknown>,
    ) => string;
    const opts = { downloadUrl: 'https://mera.news' };

    expect(t('articleDetail.shareVia', { ...opts, lng: 'hi' }))
      .toBe(i18n.t('articleDetail.shareVia', { ...opts, lng: 'hi' }));

    // Script-suffixed codes are the only ones resolveUiLocale emits that
    // aren't bare primary subtags — check they resolve, not fall back.
    expect(t('articleDetail.shareVia', { ...opts, lng: 'zh-Hant' }))
      .not.toBe(t('articleDetail.shareVia', opts));
  });

  it('falls back to English for an lng with no bundle (why resolveUiLocale returns null)', () => {
    const odia = i18n.t('common.cancel', { lng: 'or' });
    expect(odia).toBe('Cancel');
  });
});

describe('applyLanguage', () => {
  beforeEach(() => {
    isRTL = false;
    i18n.changeLanguage('en');
  });

  it('changes the i18n language', async () => {
    await applyLanguage('fr');
    expect(i18n.language).toBe('fr');
    await applyLanguage('en'); // restore
  });

  it('does NOT call forceRTL for non-RTL languages', async () => {
    await applyLanguage('fr');
    expect(forceRTL).not.toHaveBeenCalled();
  });

  it('calls I18nManager.forceRTL(true) when switching to Arabic', async () => {
    isRTL = false;
    await applyLanguage('ar');
    expect(forceRTL).toHaveBeenCalledWith(true);
    // Reset
    isRTL = false;
    await i18n.changeLanguage('en');
  });

  it('calls I18nManager.forceRTL(false) when switching FROM RTL to LTR', async () => {
    isRTL = true;
    await applyLanguage('en');
    expect(forceRTL).toHaveBeenCalledWith(false);
    isRTL = false;
  });

  it('does NOT call forceRTL when RTL state already matches (Arabic, already RTL)', async () => {
    isRTL = true;
    await applyLanguage('ar');
    expect(forceRTL).not.toHaveBeenCalled();
    // Cleanup
    isRTL = false;
    await i18n.changeLanguage('en');
  });

  it('does NOT call forceRTL for LTR when already LTR', async () => {
    isRTL = false;
    await applyLanguage('de');
    expect(forceRTL).not.toHaveBeenCalled();
  });
});

// The provisional half of a language switch: strings only, no RTL, no
// persistence. See lib/hooks/use-language-switch.ts.
describe('previewLanguage', () => {
  beforeEach(() => {
    isRTL = false;
    i18n.changeLanguage('en');
  });

  afterEach(() => {
    isRTL = false;
    i18n.changeLanguage('en');
  });

  it('lands SYNCHRONOUSLY — no await, no tick', () => {
    previewLanguage('de');

    // Load-bearing, not incidental. The switch machine reverts the language
    // and then immediately builds the failure alert; if this were async the
    // alert would come out in the language the user just backed out of —
    // precisely the bug the whole change exists to fix. Safe only because
    // every locale is bundled statically in `resources`, with no async
    // backend loader.
    expect(i18n.language).toBe('de');
  });

  it('does NOT touch the RTL flag, even for Arabic', () => {
    previewLanguage('ar');

    // `forceRTL` is a PERSISTED native flag that needs a reload to take
    // effect. Flipping it for a switch that may still fail, time out or be
    // cancelled risks the app being killed with the flag saved and the
    // language not — an RTL layout wrapped around LTR strings on next
    // launch. RTL belongs to `applyLanguage`, on the commit path only.
    expect(forceRTL).not.toHaveBeenCalled();
    expect(i18n.language).toBe('ar');
  });
});

describe('APP_LANGUAGES re-export', () => {
  it('is an array', () => {
    expect(Array.isArray(APP_LANGUAGES)).toBe(true);
  });

  it('is non-empty', () => {
    expect(APP_LANGUAGES.length).toBeGreaterThan(0);
  });

  it('each entry has a code property', () => {
    // APP_LANGUAGES is an array of objects with {code, name, native}
    const first = APP_LANGUAGES[0] as any;
    expect(typeof first.code).toBe('string');
  });

  it('contains an entry with code "en"', () => {
    const enEntry = APP_LANGUAGES.find((l: any) => l.code === 'en');
    expect(enEntry).toBeDefined();
  });

  it('contains Arabic (ar) as a supported language', () => {
    const arEntry = APP_LANGUAGES.find((l: any) => l.code === 'ar');
    expect(arEntry).toBeDefined();
  });
});
