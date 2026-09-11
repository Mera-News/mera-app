// `appendReferrer` is deliberately NOT stubbed: it is the shared builder this
// feature routes through, so a stub here would test the stub. Keeping it real
// means loading `web-browser-utils`, whose only heavy import is
// `app-language-store` — that reaches translation-service (the
// `ExpoTranslateText` native module) and setting-service (which constructs the
// SQLite adapter at import time). Cutting that single import is enough;
// `appendReferrer` never touches it, only `withAppLanguage` does.
jest.mock('@/lib/stores/app-language-store', () => ({
  useAppLanguageStore: { getState: () => ({ appLanguage: 'en' }) },
}));
jest.mock('@/lib/web-browser-utils', () => ({
  ...jest.requireActual('@/lib/web-browser-utils'),
  openInAppBrowser: jest.fn(async () => ({ type: 'opened' })),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureMessage: jest.fn(), captureException: jest.fn() },
}));

import { AppState, type AppStateStatus } from 'react-native';

import logger from '@/lib/logger';
import { openInAppBrowser } from '@/lib/web-browser-utils';

import {
  buildSubscriptionUrl,
  MIN_AWAY_MS,
  onReturnFromBackground,
  openSubscribePage,
} from '../subscribe-flow';

beforeEach(() => jest.clearAllMocks());

describe('buildSubscriptionUrl', () => {
  it('appends the subscription medium', () => {
    const url = buildSubscriptionUrl('https://assinaturas.dnoticias.pt/');
    expect(url).toContain('utm_medium=subscription');
    expect(url).toContain('utm_source=');
  });

  it('preserves an existing query string instead of replacing it', () => {
    const url = buildSubscriptionUrl('https://example.com/sub?plan=year');
    expect(url).toContain('plan=year');
    expect(url).toContain('&utm_medium=subscription');
  });

  it('keeps the fragment at the end', () => {
    const url = buildSubscriptionUrl('https://example.com/sub#pricing');
    expect(url.endsWith('#pricing')).toBe(true);
    expect(url).toContain('utm_medium=subscription');
  });

  // Never clobber a publisher's own campaign tracking.
  it('leaves a URL that already carries a utm_source untouched', () => {
    const original = 'https://example.com/sub?utm_source=theirs';
    expect(buildSubscriptionUrl(original)).toBe(original);
  });

  it('never double-appends', () => {
    const once = buildSubscriptionUrl('https://example.com/sub');
    expect(buildSubscriptionUrl(once)).toBe(once);
  });
});

describe('openSubscribePage', () => {
  it('opens an https URL with the referrer attached', async () => {
    await expect(openSubscribePage('https://example.com/sub')).resolves.toBe(true);
    expect(openInAppBrowser).toHaveBeenCalledTimes(1);
    expect((openInAppBrowser as jest.Mock).mock.calls[0][0]).toContain('utm_medium=subscription');
  });

  // The guard lives at this call site because openInAppBrowser is deliberately
  // unguarded for the force-update store schemes.
  it.each([
    ['http', 'http://example.com/sub'],
    ['javascript', 'javascript:alert(1)'],
    ['scheme-relative', '//example.com/sub'],
    ['empty', ''],
  ])('refuses a %s URL and opens nothing', async (_label, url) => {
    await expect(openSubscribePage(url)).resolves.toBe(false);
    expect(openInAppBrowser).not.toHaveBeenCalled();
    expect(logger.captureMessage).toHaveBeenCalled();
  });

  it('pins a fingerprint so the refusal groups on its text, not its stack', async () => {
    await openSubscribePage('http://example.com/sub');
    const opts = (logger.captureMessage as jest.Mock).mock.calls[0][1];
    expect(opts.fingerprint).toEqual(['subscription-uri-insecure']);
  });
});

describe('onReturnFromBackground', () => {
  let handler: (s: AppStateStatus) => void;
  const remove = jest.fn();

  beforeEach(() => {
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_e, h: (s: AppStateStatus) => void) => {
        handler = h;
        return { remove } as never;
      });
  });

  it('fires after a real background trip longer than the minimum', () => {
    const onReturn = jest.fn();
    const now = jest.spyOn(Date, 'now');
    onReturnFromBackground(onReturn);

    now.mockReturnValue(0);
    handler('background');
    now.mockReturnValue(MIN_AWAY_MS + 1);
    handler('active');

    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the trip was shorter than the minimum', () => {
    const onReturn = jest.fn();
    const now = jest.spyOn(Date, 'now');
    onReturnFromBackground(onReturn);

    now.mockReturnValue(0);
    handler('background');
    now.mockReturnValue(MIN_AWAY_MS - 1);
    handler('active');

    expect(onReturn).not.toHaveBeenCalled();
  });

  // THE trap: iOS reports `inactive` for the app switcher and for a
  // notification banner pulled down over the browser. Neither is a departure,
  // and arming on them would prompt someone who never left.
  it('ignores an inactive transient and never arms on it', () => {
    const onReturn = jest.fn();
    const now = jest.spyOn(Date, 'now');
    onReturnFromBackground(onReturn);

    now.mockReturnValue(0);
    handler('inactive');
    now.mockReturnValue(MIN_AWAY_MS + 5_000);
    handler('active');

    expect(onReturn).not.toHaveBeenCalled();
  });

  it('does not fire on an active event with no preceding background', () => {
    const onReturn = jest.fn();
    onReturnFromBackground(onReturn);
    handler('active');
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('fires once per background trip, not on every later foreground', () => {
    const onReturn = jest.fn();
    const now = jest.spyOn(Date, 'now');
    onReturnFromBackground(onReturn);

    now.mockReturnValue(0);
    handler('background');
    now.mockReturnValue(MIN_AWAY_MS + 1);
    handler('active');
    handler('active');

    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('removes the listener on unsubscribe', () => {
    onReturnFromBackground(jest.fn())();
    expect(remove).toHaveBeenCalled();
  });
});
