import { normalizeLegacyHref } from '../legacy-href';

const TABS = '/logged-in/app_container';

describe('normalizeLegacyHref', () => {
  it.each([
    // The four old tabs.
    [`${TABS}/for_you`, { pathname: `${TABS}/feed` }],
    [`${TABS}/around`, { pathname: `${TABS}/world` }],
    [`${TABS}/profile`, { pathname: `${TABS}/you`, page: 'profile' }],
    [`${TABS}/settings`, { pathname: `${TABS}/you`, page: 'settings' }],
    // The six root stubs.
    ['/logged-in/share-stats', { pathname: `${TABS}/library`, page: 'stats' }],
    // The Stats live under History now; an old card id has nowhere to land.
    ['/logged-in/share-stats?card=keep', { pathname: `${TABS}/library`, page: 'stats' }],
    ['/logged-in/saved-suggestions', { pathname: `${TABS}/library`, page: 'saved' }],
    ['/logged-in/visited-publications', { pathname: `${TABS}/library`, page: 'visited' }],
    ['/logged-in/notifications', { pathname: `${TABS}/feed`, page: 'notifications' }],
    ['/logged-in/profile-advanced', { pathname: `${TABS}/you`, page: 'profile' }],
    ['/logged-in/config-panel', { pathname: `${TABS}/you`, page: 'profile' }],
    [
      '/logged-in/fact-feed?factId=f1&statement=Lives%20in%20Berlin&via=section',
      { pathname: `${TABS}/feed/interest`, params: { factId: 'f1', statement: 'Lives in Berlin', via: 'section' } },
    ],
    // The tab-screen stubs.
    ['/logged-in/preferences/display', { pathname: `${TABS}/you/display` }],
    ['/logged-in/preferences/manage-data?restore=1', { pathname: `${TABS}/you/backup`, params: { restore: '1' } }],
    ['/logged-in/preferences/manage-data', { pathname: `${TABS}/you/data` }],
    ['/logged-in/preferences/manage-data?restore=0', { pathname: `${TABS}/you/data` }],
    ['/logged-in/preferences/notifications', { pathname: `${TABS}/you/notifications` }],
    ['/logged-in/preferences/mera-protocol', { pathname: `${TABS}/you/mera-protocol` }],
    ['/logged-in/hygiene-review', { pathname: `${TABS}/you/hygiene-review` }],
    ['/logged-in/locations', { pathname: `${TABS}/you/locations` }],
    ['/logged-in/publication-preferences', { pathname: `${TABS}/you/sources` }],
    ['/logged-in/sources', { pathname: `${TABS}/you/sources` }],
    ['/logged-in/persona-audit', { pathname: `${TABS}/you/activity` }],
    ['/logged-in/facts', { pathname: `${TABS}/you/facts` }],
  ])('%s', (href, target) => {
    expect(normalizeLegacyHref(href)).toEqual(target);
  });

  it('drops params the destination does not read', () => {
    expect(normalizeLegacyHref(`${TABS}/for_you?subTab=factChecks`)).toEqual({ pathname: `${TABS}/feed` });
    expect(normalizeLegacyHref('/logged-in/share-stats?card=reach&x=1')).toEqual({
      pathname: `${TABS}/library`, page: 'stats',
    });
  });

  it.each([
    'meraapp://logged-in/app_container/around',
    'logged-in/app_container/around',
    `${TABS}/around/`,
    `${TABS}/around#top`,
  ])('accepts the deep link form %s', (href) => {
    expect(normalizeLegacyHref(href)).toEqual({ pathname: `${TABS}/world` });
  });

  it.each([`${TABS}/feed`, '/logged-in/article-detail?articleId=a1', '/logged-in/fact-feed-x', '', '/'])(
    'leaves %p alone',
    (href) => {
      expect(normalizeLegacyHref(href)).toBeNull();
    },
  );

  it('drops a malformed escape, not the link', () => {
    expect(normalizeLegacyHref('/logged-in/fact-feed?factId=%E0%A4%A&via=next')).toEqual({
      pathname: `${TABS}/feed/interest`, params: { via: 'next' },
    });
  });
});
