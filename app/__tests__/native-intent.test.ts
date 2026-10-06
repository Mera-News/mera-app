jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import { consumePendingPage, resetPendingPage } from '@/components/custom/nav/navigate-to-page';
import { redirectSystemPath } from '../+native-intent';

beforeEach(() => resetPendingPage());

describe('+native-intent', () => {
  it('leaves a current path alone', () => {
    expect(redirectSystemPath({ path: '/logged-in/article-detail?articleId=a1', initial: true })).toBe(
      '/logged-in/article-detail?articleId=a1',
    );
    expect(consumePendingPage('feed')).toBeNull();
  });

  it('sends an old tab to its new tab', () => {
    expect(redirectSystemPath({ path: '/logged-in/app_container/for_you', initial: true })).toBe(
      '/logged-in/app_container/feed',
    );
    expect(redirectSystemPath({ path: '/logged-in/app_container/around', initial: false })).toBe(
      '/logged-in/app_container/world',
    );
  });

  it('opens Settings on the You tab through the pending store, not the URL', () => {
    expect(redirectSystemPath({ path: 'meraapp://logged-in/app_container/settings', initial: true })).toBe(
      '/logged-in/app_container/you',
    );
    expect(consumePendingPage('you')?.page).toBe('settings');
  });

  it('forwards the Stats card as a page param', () => {
    expect(redirectSystemPath({ path: '/logged-in/share-stats?card=keep', initial: true })).toBe(
      '/logged-in/app_container/library',
    );
    expect(consumePendingPage('library')).toMatchObject({ page: 'stats', params: { card: 'keep' } });
  });

  it('keeps One interest params in the URL (a pushed screen, not a page)', () => {
    expect(
      redirectSystemPath({ path: '/logged-in/fact-feed?factId=f1&statement=Lives%20in%20Berlin', initial: true }),
    ).toBe('/logged-in/app_container/feed/interest?factId=f1&statement=Lives+in+Berlin');
  });
});
