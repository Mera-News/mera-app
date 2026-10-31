// lib/i18n/index.ts over the real i18next instance, the real bundled locales and the real
// translation-service. Only the native I18nManager is faked: allowRTL and forceRTL are spied (each
// persists a native flag) and isRTL is set per case. As on device, isRTL is FROZEN for the process:
// a forceRTL write never changes it, it only takes effect at the next launch.
import { I18nManager } from 'react-native';

import i18n, { applyLanguage, previewLanguage, needsRtlRestart, APP_LANGUAGES } from '@/lib/i18n';

let isRTL = false;
let forceRTL: jest.SpyInstance;
let allowRTL: jest.SpyInstance;

beforeEach(() => {
  isRTL = false;
  Object.defineProperty(I18nManager, 'isRTL', { configurable: true, get: () => isRTL });
  forceRTL = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => {});
  allowRTL = jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => {});
});

afterEach(async () => {
  forceRTL.mockRestore();
  allowRTL.mockRestore();
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

  it('writes both RTL flags off for an LTR language', async () => {
    await applyLanguage('fr');
    expect(allowRTL).toHaveBeenLastCalledWith(false);
    expect(forceRTL).toHaveBeenLastCalledWith(false);
  });

  it('writes both RTL flags on for Arabic', async () => {
    await applyLanguage('ar');
    expect(allowRTL).toHaveBeenLastCalledWith(true);
    expect(forceRTL).toHaveBeenLastCalledWith(true);
  });

  it('en -> ar -> en in one LTR-started process leaves the flags off (isRTL stays frozen at false)', async () => {
    await applyLanguage('ar');
    await applyLanguage('en');
    expect(forceRTL).toHaveBeenLastCalledWith(false);
    expect(allowRTL).toHaveBeenLastCalledWith(false);
  });

  it('ar -> en in an RTL-started process writes the flags off', async () => {
    isRTL = true;
    await applyLanguage('en');
    expect(forceRTL).toHaveBeenLastCalledWith(false);
    expect(allowRTL).toHaveBeenLastCalledWith(false);
  });

  it('rewrites the flags even when the running layout already matches (a phone set to Arabic, app in Arabic)', async () => {
    isRTL = true;
    await applyLanguage('ar');
    expect(forceRTL).toHaveBeenLastCalledWith(true);
  });
});

describe('needsRtlRestart', () => {
  it('compares against the layout the process started with, not the previous language', () => {
    isRTL = false;
    expect(needsRtlRestart('ar')).toBe(true);
    expect(needsRtlRestart('en')).toBe(false); // en -> ar (Later) -> en: nothing to restart for
    isRTL = true;
    expect(needsRtlRestart('en')).toBe(true);
    expect(needsRtlRestart('ar')).toBe(false);
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
