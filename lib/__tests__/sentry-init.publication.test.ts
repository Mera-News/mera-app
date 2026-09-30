// sentry-init: the publication page scrub. Which publications a reader opens
// is reading history; it must not ride out on a breadcrumb or an event.

const mockSentryInit = jest.fn();
jest.mock('@sentry/react-native', () => ({
  init: mockSentryInit,
  setContext: jest.fn(),
  setTag: jest.fn(),
  feedbackIntegration: jest.fn(() => ({ name: 'FeedbackIntegration' })),
}));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1', nativeBuildVersion: '1' }));
jest.mock('expo-updates', () => ({ updateId: 'u', channel: 'production', runtimeVersion: '1', isEmbeddedLaunch: false }));

type Crumb = { message?: string; category?: string; data?: Record<string, unknown> };
type Config = {
  beforeBreadcrumb: (c: Crumb) => Crumb;
  beforeSend: (e: { breadcrumbs?: Crumb[]; extra?: Record<string, unknown> }) => {
    breadcrumbs?: Crumb[];
    extra?: Record<string, unknown>;
  };
};

let config: Config;
let scrub: (c: Crumb) => Crumb;

beforeAll(() => {
  (global as { __DEV__?: boolean }).__DEV__ = false;
  jest.isolateModules(() => {
    const mod = require('../sentry-init') as typeof import('../sentry-init');
    scrub = mod.scrubPublicationPageCrumb;
  });
  config = mockSentryInit.mock.calls[0][0] as Config;
});

afterAll(() => {
  (global as { __DEV__?: boolean }).__DEV__ = true;
});

describe('publication page scrub', () => {
  it('beforeBreadcrumb drops the PublicationProfile variables, keeping the operation name', () => {
    const out = config.beforeBreadcrumb({
      category: 'graphql',
      data: {
        operationName: 'PublicationProfile',
        variables: { name: 'Times of India', countryCode: 'IND' },
        name: 'Times of India',
        countryCode: 'IND',
        newsPublisherId: 'p1',
      },
    });
    expect(out.data).toEqual({ operationName: 'PublicationProfile' });
  });

  it('strips the page route query string from messages and data, anywhere', () => {
    const out = scrub({
      category: 'navigation',
      message: 'Navigated to /logged-in/publication?name=Le%20Monde&country=FRA',
      data: { to: 'logged-in/publication?publisherId=p1', nested: ['/logged-in/publication?name=X'], url: 'https://lemonde.fr' },
    });
    expect(out.message).toBe('Navigated to /logged-in/publication');
    expect(out.data).toEqual({ to: 'logged-in/publication', nested: ['/logged-in/publication'] });
  });

  it('drops the website link: `url` on a crumb about the page, `homepageUrl` anywhere', () => {
    expect(scrub({ message: 'open /logged-in/publication', data: { url: 'https://lemonde.fr' } }).data).toEqual({});
    expect(scrub({ data: { homepageUrl: 'https://lemonde.fr', ok: 1 } }).data).toEqual({ ok: 1 });
  });

  it('leaves unrelated crumbs alone: exact keys only, sibling routes untouched', () => {
    const crumb = {
      category: 'graphql',
      message: 'GraphQL expected error',
      data: { operationName: 'GetUserPersona', name: 'kept', url: 'https://api', route: '/logged-in/publication-history?x=1' },
    };
    expect(scrub(JSON.parse(JSON.stringify(crumb)))).toEqual(crumb);
  });

  it('beforeSend scrubs breadcrumbs and extra the same way', () => {
    const event = config.beforeSend({
      breadcrumbs: [{ data: { operationName: 'PublicationProfile', variables: { name: 'X' } } }],
      extra: { screen: '/logged-in/publication?name=X', name: 'X' },
    });
    expect(event.breadcrumbs?.[0].data).toEqual({ operationName: 'PublicationProfile' });
    expect(event.extra).toEqual({ screen: '/logged-in/publication' });
  });
});
