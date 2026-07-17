// web-browser-utils.ts uses expo-web-browser and Platform.OS from react-native.
// We define mocks via jest.fn() inside the factories, then reference the mock
// objects via module-level jest.spyOn/require after import.

// eslint-disable-next-line no-var
var mockPlatformIOS = { OS: 'ios' };

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  ...mockPlatformIOS,
  default: mockPlatformIOS,
}));

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve({ type: 'opened' })),
  getCustomTabsSupportingBrowsersAsync: jest.fn(),
  WebBrowserPresentationStyle: {
    PAGE_SHEET: 'pageSheet',
    AUTOMATIC: 'automatic',
  },
  dismissBrowser: jest.fn(),
}));

// Isolate from branding.ts (which evaluates Platform.OS at module load — its own
// values are covered by config/__tests__/branding.test.ts).
jest.mock('../config/branding', () => ({ REFERRER_SOURCE: 'mera.news' }));

// web-browser-utils.ts reads useAppLanguageStore.getState() non-reactively.
// The real store module transitively pulls in setting-service → the real
// WatermelonDB (lib/database/index.ts, jsi: true) plus expo-translate-text
// (via translation-service), both of which crash at import time under jest.
// Mock the store directly at its module boundary, matching the convention in
// lib/llm/__tests__/ArticleFeedbackAgent.test.ts and
// lib/database/__tests__/hydrate-stores.test.ts (non-reactive getState() usage).
jest.mock('../stores/app-language-store', () => ({
  useAppLanguageStore: {
    getState: jest.fn(() => ({ appLanguage: 'en' })),
  },
}));

import * as WebBrowser from 'expo-web-browser';
import { appendReferrer, openArticleInAppBrowser, openInAppBrowser } from '../web-browser-utils';

// REFERRER_SOURCE is derived from WEBSITE_URL's host (default: mera.news).
const REFERRER = 'utm_source=mera.news&utm_medium=referral';

const mockOpenBrowserAsync = WebBrowser.openBrowserAsync as jest.Mock;
const mockGetCustomTabs = (WebBrowser as any).getCustomTabsSupportingBrowsersAsync as jest.Mock;

const BASE_OPTIONS = {
  presentationStyle: 'pageSheet',
  controlsColor: '#ffffff',
  toolbarColor: '#000000',
};

describe('openInAppBrowser — iOS (default platform)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenBrowserAsync.mockResolvedValue({ type: 'opened' });
    mockPlatformIOS.OS = 'ios';
  });

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

describe('appendReferrer', () => {
  it('appends UTM params with ? when the URL has no query', () => {
    expect(appendReferrer('https://publisher.com/story')).toBe(
      `https://publisher.com/story?${REFERRER}`
    );
  });

  it('joins with & when the URL already has a query string', () => {
    expect(appendReferrer('https://publisher.com/story?id=42')).toBe(
      `https://publisher.com/story?id=42&${REFERRER}`
    );
  });

  it('inserts params before a #fragment', () => {
    expect(appendReferrer('https://publisher.com/story#section')).toBe(
      `https://publisher.com/story?${REFERRER}#section`
    );
    expect(appendReferrer('https://publisher.com/story?id=42#section')).toBe(
      `https://publisher.com/story?id=42&${REFERRER}#section`
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenBrowserAsync.mockResolvedValue({ type: 'opened' });
    mockPlatformIOS.OS = 'ios';
  });

  it('opens the article URL with the referrer params appended', async () => {
    await openArticleInAppBrowser('https://publisher.com/story');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith(
      `https://publisher.com/story?${REFERRER}`,
      BASE_OPTIONS
    );
  });
});
