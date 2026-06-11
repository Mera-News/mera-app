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

import * as WebBrowser from 'expo-web-browser';
import { openInAppBrowser } from '../web-browser-utils';

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
