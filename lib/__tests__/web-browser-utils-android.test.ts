// Tests for openInAppBrowser on Android.

// eslint-disable-next-line no-var
var mockPlatformAndroid = { OS: 'android' };

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  ...mockPlatformAndroid,
  default: mockPlatformAndroid,
}));

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve({ type: 'opened' })),
  getCustomTabsSupportingBrowsersAsync: jest.fn(),
  WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet', AUTOMATIC: 'automatic' },
  dismissBrowser: jest.fn(),
}));

// Isolate from branding.ts (which evaluates Platform.OS at module load).
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
import { openInAppBrowser } from '../web-browser-utils';

const mockOpenBrowserAsync = WebBrowser.openBrowserAsync as jest.Mock;
const mockGetCustomTabs = (WebBrowser as any).getCustomTabsSupportingBrowsersAsync as jest.Mock;

const BASE_OPTIONS = {
  presentationStyle: 'pageSheet',
  controlsColor: '#ffffff',
  toolbarColor: '#000000',
};

describe('openInAppBrowser — Android', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenBrowserAsync.mockResolvedValue({ type: 'opened' });
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
      ...BASE_OPTIONS,
      browserPackage: 'com.android.chrome',
      createTask: false,
      showTitle: true,
      enableBarCollapsing: true,
    });
  });

  it('uses first package when no Chrome is available', async () => {
    mockGetCustomTabs.mockResolvedValueOnce({
      browserPackages: ['com.opera.browser', 'com.brave.browser'],
    });
    await openInAppBrowser('https://example.com');
    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('https://example.com', {
      ...BASE_OPTIONS,
      browserPackage: 'com.opera.browser',
      createTask: false,
      showTitle: true,
      enableBarCollapsing: true,
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
});
