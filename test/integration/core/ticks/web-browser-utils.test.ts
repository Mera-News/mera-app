// web-browser-utils: the in-app browser options per platform, the publisher referrer, and the
// website locale segment. Driven against the real app-language store and the real branding
// config; the only fakes are expo-web-browser (a native module) and Platform.OS (an edge).
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import {
  appendReferrer,
  openArticleInAppBrowser,
  openInAppBrowser,
  webLocaleFor,
  withAppLanguage,
} from '@/lib/web-browser-utils';

// The setup's expo-web-browser mock has neither PAGE_SHEET nor the Custom Tabs query.
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve({ type: 'opened' })),
  getCustomTabsSupportingBrowsersAsync: jest.fn(),
  WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet', AUTOMATIC: 'automatic' },
  dismissBrowser: jest.fn(),
}));

// REFERRER_SOURCE is derived from WEBSITE_URL's host (default: mera.news).
const REFERRER = 'utm_source=mera.news&utm_medium=referral';

const mockOpenBrowserAsync = WebBrowser.openBrowserAsync as jest.Mock;
const mockGetCustomTabs = WebBrowser.getCustomTabsSupportingBrowsersAsync as jest.Mock;

const BASE_OPTIONS = {
  presentationStyle: 'pageSheet',
  controlsColor: '#ffffff',
  toolbarColor: '#000000',
};

const ANDROID_TAB_OPTIONS = {
  ...BASE_OPTIONS,
  createTask: false,
  showTitle: true,
  enableBarCollapsing: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOpenBrowserAsync.mockResolvedValue({ type: 'opened' });
  Platform.OS = 'ios';
  useAppLanguageStore.setState({ appLanguage: 'en' });
});

afterAll(() => {
  Platform.OS = 'ios';
});

describe('openInAppBrowser: iOS', () => {
  it('calls openBrowserAsync with base options (no Custom Tabs query)', async () => {
    await openInAppBrowser('https://example.com');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('https://example.com', BASE_OPTIONS);
  });

  it('does NOT query Custom Tabs browsers on iOS', async () => {
    await openInAppBrowser('https://example.com');
    expect(mockGetCustomTabs).not.toHaveBeenCalled();
  });

  it('returns the result from openBrowserAsync', async () => {
    mockOpenBrowserAsync.mockResolvedValueOnce({ type: 'cancel' });
    const result = await openInAppBrowser('https://example.com');
    expect(result).toEqual({ type: 'cancel' });
  });

  it('passes any URL through to openBrowserAsync', async () => {
    const url = 'https://news.example.com/story/42?ref=push';
    await openInAppBrowser(url);
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith(url, expect.any(Object));
  });

  it('uses PAGE_SHEET presentation style', async () => {
    await openInAppBrowser('https://example.com');
    const [, opts] = mockOpenBrowserAsync.mock.calls[0];
    expect(opts.presentationStyle).toBe('pageSheet');
  });

  it('uses white controls and black toolbar', async () => {
    await openInAppBrowser('https://example.com');
    const [, opts] = mockOpenBrowserAsync.mock.calls[0];
    expect(opts.controlsColor).toBe('#ffffff');
    expect(opts.toolbarColor).toBe('#000000');
  });
});

describe('openInAppBrowser: Android', () => {
  beforeEach(() => {
    Platform.OS = 'android';
  });

  it('queries getCustomTabsSupportingBrowsersAsync', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({ browserPackages: [] });
    await openInAppBrowser('https://example.com');
    expect(mockGetCustomTabs).toHaveBeenCalledTimes(1);
  });

  it('falls back to base options when no Custom Tabs browser is available', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({ browserPackages: [] });
    await openInAppBrowser('https://example.com');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('https://example.com', BASE_OPTIONS);
  });

  it('prefers Chrome (com.android.chrome) over other packages', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({
      browserPackages: ['com.opera.browser', 'com.android.chrome', 'com.brave.browser'],
    });
    await openInAppBrowser('https://example.com');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('https://example.com', {
      ...ANDROID_TAB_OPTIONS,
      browserPackage: 'com.android.chrome',
    });
  });

  it('uses first package when no Chrome is available', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({
      browserPackages: ['com.opera.browser', 'com.brave.browser'],
    });
    await openInAppBrowser('https://example.com');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('https://example.com', {
      ...ANDROID_TAB_OPTIONS,
      browserPackage: 'com.opera.browser',
    });
  });

  it('detects Chrome by "chrome" substring in package name', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({
      browserPackages: ['com.samsung.android.app.sbrowser', 'com.google.chrome.beta'],
    });
    await openInAppBrowser('https://example.com');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ browserPackage: 'com.google.chrome.beta' }),
    );
  });

  it('passes createTask: false for in-app feel', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({ browserPackages: ['com.android.chrome'] });
    await openInAppBrowser('https://example.com');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ createTask: false }),
    );
  });

  it('opens the article URL with referrer params through the same Custom Tabs path', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({ browserPackages: ['com.android.chrome'] });
    await openArticleInAppBrowser('https://publisher.com/story');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith(`https://publisher.com/story?${REFERRER}`, {
      ...ANDROID_TAB_OPTIONS,
      browserPackage: 'com.android.chrome',
    });
  });
});

describe('appendReferrer', () => {
  it('appends UTM params with ? when the URL has no query', () => {
    expect(appendReferrer('https://publisher.com/story')).toBe(`https://publisher.com/story?${REFERRER}`);
  });

  it('joins with & when the URL already has a query string', () => {
    expect(appendReferrer('https://publisher.com/story?id=42')).toBe(
      `https://publisher.com/story?id=42&${REFERRER}`,
    );
  });

  it('inserts params before a #fragment', () => {
    expect(appendReferrer('https://publisher.com/story#section')).toBe(
      `https://publisher.com/story?${REFERRER}#section`,
    );
    expect(appendReferrer('https://publisher.com/story?id=42#section')).toBe(
      `https://publisher.com/story?id=42&${REFERRER}#section`,
    );
  });

  it('leaves a URL that already carries a utm_source untouched', () => {
    const url = 'https://publisher.com/story?utm_source=twitter';
    expect(appendReferrer(url)).toBe(url);
  });

  it('returns empty/falsy input unchanged', () => {
    expect(appendReferrer('')).toBe('');
    expect(appendReferrer(undefined as unknown as string)).toBe(undefined);
  });
});

describe('openArticleInAppBrowser', () => {
  it('opens the article URL with the referrer params appended', async () => {
    await openArticleInAppBrowser('https://publisher.com/story');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith(`https://publisher.com/story?${REFERRER}`, BASE_OPTIONS);
  });

  // Defence in depth. The server already excludes insecure articles from every serving
  // path; this covers rows already on the device.
  it.each(['http://publisher.com/story', 'javascript:alert(1)', 'publisher.com/story', ''])(
    'refuses to open the non-https article URL %p',
    async (url) => {
      await expect(openArticleInAppBrowser(url)).rejects.toThrow(/non-https/i);
      expect(mockOpenBrowserAsync).not.toHaveBeenCalled();
    },
  );

  it('leaves openInAppBrowser itself unguarded: the update gate needs store schemes', async () => {
    // A blanket https-only rule here would silently break force-update, which feeds this
    // a server-supplied `itms-apps://` URL.
    await openInAppBrowser('itms-apps://itunes.apple.com/app/id1');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('itms-apps://itunes.apple.com/app/id1', BASE_OPTIONS);
  });
});

describe('withAppLanguage', () => {
  const setLang = (appLanguage: string) => useAppLanguageStore.setState({ appLanguage });

  it.each([
    ['pt-BR', 'pt'],
    ['zh-CN', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'],
  ])('maps the app code %s to the website code %s (the app code 404s there)', (app, web) => {
    setLang(app);
    expect(withAppLanguage('https://mera.news/privacy')).toBe(`https://mera.news/${web}/privacy`);
  });

  it('passes every other app code through unchanged', () => {
    for (const code of ['en', 'ar', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'ru', 'th', 'tr', 'uk', 'vi']) {
      expect(webLocaleFor(code)).toBe(code);
    }
    setLang('de');
    expect(withAppLanguage('https://mera.news/terms')).toBe('https://mera.news/de/terms');
  });

  it('keeps a #fragment after the path', () => {
    setLang('zh-TW');
    expect(withAppLanguage('https://mera.news/faq#no-email')).toBe('https://mera.news/zh-Hant/faq#no-email');
  });

  it('leaves a URL that already carries a website locale alone', () => {
    setLang('pt-BR');
    expect(withAppLanguage('https://mera.news/pt/privacy')).toBe('https://mera.news/pt/privacy');
  });
});
