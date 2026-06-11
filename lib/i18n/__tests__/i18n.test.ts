// i18n/index.ts imports locales and initialises i18next.

// Mock expo-translate-text used transitively via translation-service
jest.mock('expo-translate-text', () => ({
  onTranslateTask: jest.fn(),
  TranslateTextView: jest.fn(),
}));

jest.mock('@cospired/i18n-iso-languages', () => ({
  registerLocale: jest.fn(),
  getName: jest.fn((code: string) => code),
}));

jest.mock('@cospired/i18n-iso-languages/langs/en.json', () => ({}), { virtual: true });

// Must use var so variable is available when the hoisted factory runs
// eslint-disable-next-line no-var
var mockI18nManagerState = { isRTL: false };
// eslint-disable-next-line no-var
var mockForceRTLFn: jest.Mock;

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  OS: 'ios',
  default: { OS: 'ios' },
}));

jest.mock('react-native', () => {
  // mockForceRTLFn is var so it's accessible here at runtime
  // but we create it lazily to avoid TDZ
  mockForceRTLFn = jest.fn((val: boolean) => { mockI18nManagerState.isRTL = val; });
  return {
    I18nManager: {
      get isRTL() { return mockI18nManagerState.isRTL; },
      forceRTL: mockForceRTLFn,
    },
    Platform: { OS: 'ios' },
  };
});

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://inference.test',
  AUTH_ENDPOINT: 'https://auth.test',
  GRAPHQL_SERVER_ENDPOINT: 'https://api.test',
  DUMP_QUERIES_ENABLED: false,
}));

import i18n, { applyLanguage, APP_LANGUAGES } from '../index';

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
});

describe('applyLanguage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockI18nManagerState.isRTL = false;
    i18n.changeLanguage('en');
  });

  it('changes the i18n language', async () => {
    await applyLanguage('fr');
    expect(i18n.language).toBe('fr');
    await applyLanguage('en'); // restore
  });

  it('does NOT call forceRTL for non-RTL languages', async () => {
    await applyLanguage('fr');
    expect(mockForceRTLFn).not.toHaveBeenCalled();
  });

  it('calls I18nManager.forceRTL(true) when switching to Arabic', async () => {
    mockI18nManagerState.isRTL = false;
    await applyLanguage('ar');
    expect(mockForceRTLFn).toHaveBeenCalledWith(true);
    // Reset
    mockI18nManagerState.isRTL = false;
    await i18n.changeLanguage('en');
  });

  it('calls I18nManager.forceRTL(false) when switching FROM RTL to LTR', async () => {
    mockI18nManagerState.isRTL = true;
    await applyLanguage('en');
    expect(mockForceRTLFn).toHaveBeenCalledWith(false);
    mockI18nManagerState.isRTL = false;
  });

  it('does NOT call forceRTL when RTL state already matches (Arabic, already RTL)', async () => {
    mockI18nManagerState.isRTL = true;
    await applyLanguage('ar');
    expect(mockForceRTLFn).not.toHaveBeenCalled();
    // Cleanup
    mockI18nManagerState.isRTL = false;
    await i18n.changeLanguage('en');
  });

  it('does NOT call forceRTL for LTR when already LTR', async () => {
    mockI18nManagerState.isRTL = false;
    await applyLanguage('de');
    expect(mockForceRTLFn).not.toHaveBeenCalled();
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
