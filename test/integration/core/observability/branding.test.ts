// branding.ts reads process.env.EXPO_PUBLIC_* at module load with fallback defaults.
// Use jest.resetModules() + dynamic require to test each branch.

// eslint-disable-next-line no-var
var mockPlatformBranding = { OS: 'ios' };

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  ...mockPlatformBranding,
  default: mockPlatformBranding,
}));

// The integration setup points the three endpoints at loopback. These tests rewrite
// process.env, so put it back after each one.
const ENV_AT_LOAD = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_AT_LOAD)) delete process.env[key];
  }
  Object.assign(process.env, ENV_AT_LOAD);
});

describe('config/branding — default values (iOS)', () => {
  beforeEach(() => {
    jest.resetModules();
    // Clear all EXPO_PUBLIC_* branding vars so defaults kick in
    delete process.env.EXPO_PUBLIC_PRIVACY_URL;
    delete process.env.EXPO_PUBLIC_TERMS_URL;
    delete process.env.EXPO_PUBLIC_CONTENT_POLICY_URL;
    delete process.env.EXPO_PUBLIC_FAQ_URL;
    delete process.env.EXPO_PUBLIC_SUPPORT_EMAIL;
    delete process.env.EXPO_PUBLIC_WEBSITE_URL;
    delete process.env.EXPO_PUBLIC_GITHUB_URL;
    delete process.env.EXPO_PUBLIC_GUIDE_VIDEO_BASE_URL;
    mockPlatformBranding.OS = 'ios';
  });

  it('PRIVACY_URL defaults to https://mera.news/privacy', () => {
    const { PRIVACY_URL } = require('@/lib/config/branding');
    expect(PRIVACY_URL).toBe('https://mera.news/privacy');
  });

  it('TERMS_URL defaults to https://mera.news/terms', () => {
    const { TERMS_URL } = require('@/lib/config/branding');
    expect(TERMS_URL).toBe('https://mera.news/terms');
  });

  it('CONTENT_POLICY_URL defaults to https://mera.news/content-policy', () => {
    const { CONTENT_POLICY_URL } = require('@/lib/config/branding');
    expect(CONTENT_POLICY_URL).toBe('https://mera.news/content-policy');
  });

  it('FAQ_URL defaults to https://mera.news/faq', () => {
    const { FAQ_URL } = require('@/lib/config/branding');
    expect(FAQ_URL).toBe('https://mera.news/faq');
  });

  it('SUPPORT_EMAIL defaults to contact@mera.news', () => {
    const { SUPPORT_EMAIL } = require('@/lib/config/branding');
    expect(SUPPORT_EMAIL).toBe('contact@mera.news');
  });

  it('WEBSITE_URL defaults to https://mera.news', () => {
    const { WEBSITE_URL } = require('@/lib/config/branding');
    expect(WEBSITE_URL).toBe('https://mera.news');
  });

  it('GITHUB_URL defaults to the mera-app repo URL', () => {
    const { GITHUB_URL } = require('@/lib/config/branding');
    expect(GITHUB_URL).toBe('https://github.com/Mera-News/mera-app');
  });

  // Object names are <kind>-<platform>-<app language>.mp4, uploaded for every
  // app language code (zh-Hans, zh-Hant and pt included, not zh-CN or pt-BR).
  it('guideVideoUrl names the kind, the platform and the app language on iOS', () => {
    mockPlatformBranding.OS = 'ios';
    const { guideVideoUrl } = require('@/lib/config/branding');
    expect(guideVideoUrl('translate', 'en')).toBe('https://storage.googleapis.com/mera-news-prod-guides/translate-ios-en.mp4');
    expect(guideVideoUrl('phone-language', 'zh-Hant')).toBe('https://storage.googleapis.com/mera-news-prod-guides/phone-language-ios-zh-Hant.mp4');
  });

  it('guideVideoUrl names android on Android', () => {
    mockPlatformBranding.OS = 'android';
    const { guideVideoUrl } = require('@/lib/config/branding');
    expect(guideVideoUrl('translate', 'pt')).toBe('https://storage.googleapis.com/mera-news-prod-guides/translate-android-pt.mp4');
  });
});

describe('config/branding — env overrides', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_PRIVACY_URL;
    delete process.env.EXPO_PUBLIC_TERMS_URL;
    delete process.env.EXPO_PUBLIC_CONTENT_POLICY_URL;
    delete process.env.EXPO_PUBLIC_FAQ_URL;
    delete process.env.EXPO_PUBLIC_SUPPORT_EMAIL;
    delete process.env.EXPO_PUBLIC_WEBSITE_URL;
    delete process.env.EXPO_PUBLIC_GITHUB_URL;
    delete process.env.EXPO_PUBLIC_GUIDE_VIDEO_BASE_URL;
  });

  it('PRIVACY_URL uses env override when set', () => {
    process.env.EXPO_PUBLIC_PRIVACY_URL = 'https://custom.example/privacy';
    const { PRIVACY_URL } = require('@/lib/config/branding');
    expect(PRIVACY_URL).toBe('https://custom.example/privacy');
  });

  it('TERMS_URL uses env override when set', () => {
    process.env.EXPO_PUBLIC_TERMS_URL = 'https://custom.example/terms';
    const { TERMS_URL } = require('@/lib/config/branding');
    expect(TERMS_URL).toBe('https://custom.example/terms');
  });

  it('FAQ_URL uses env override when set', () => {
    process.env.EXPO_PUBLIC_FAQ_URL = 'https://custom.example/faq';
    const { FAQ_URL } = require('@/lib/config/branding');
    expect(FAQ_URL).toBe('https://custom.example/faq');
  });

  it('SUPPORT_EMAIL uses env override when set', () => {
    process.env.EXPO_PUBLIC_SUPPORT_EMAIL = 'support@custom.example';
    const { SUPPORT_EMAIL } = require('@/lib/config/branding');
    expect(SUPPORT_EMAIL).toBe('support@custom.example');
  });

  it('WEBSITE_URL uses env override when set', () => {
    process.env.EXPO_PUBLIC_WEBSITE_URL = 'https://custom.example';
    const { WEBSITE_URL } = require('@/lib/config/branding');
    expect(WEBSITE_URL).toBe('https://custom.example');
  });

  it('GITHUB_URL uses env override when set', () => {
    process.env.EXPO_PUBLIC_GITHUB_URL = 'https://github.com/custom/fork';
    const { GITHUB_URL } = require('@/lib/config/branding');
    expect(GITHUB_URL).toBe('https://github.com/custom/fork');
  });

  it('guideVideoUrl uses the env base URL override', () => {
    mockPlatformBranding.OS = 'ios';
    process.env.EXPO_PUBLIC_GUIDE_VIDEO_BASE_URL = 'https://custom.example/guides';
    const { guideVideoUrl } = require('@/lib/config/branding');
    expect(guideVideoUrl('translate', 'ar')).toBe('https://custom.example/guides/translate-ios-ar.mp4');
  });
});
