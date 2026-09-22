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
// `captureMessage` / `captureException` are what this file's own paths use.
// The other three are here because the suite now imports the REAL
// `@/lib/app-restart` (so `activeHolds()` can be asserted against rather than a
// stub of it), and that module logs through `info` / `debug` / `addBreadcrumb`.
// A partial logger mock is `undefined is not a function` at the first call, far
// from the mock that caused it.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureMessage: jest.fn(),
    captureException: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import { AppState, type AppStateStatus } from 'react-native';

import logger from '@/lib/logger';
import { openInAppBrowser } from '@/lib/web-browser-utils';

import { activeHolds, __resetAppRestartForTests } from '@/lib/app-restart';

import {
  buildSubscriptionUrl,
  holdRestartAcrossPurchase,
  MIN_AWAY_MS,
  onReturnFromBackground,
  openSubscribePage,
  PURCHASE_HOLD_AFTER_RETURN_MS,
  PURCHASE_HOLD_CEILING_MS,
} from '../subscribe-flow';

// FAKE TIMERS FOR THE WHOLE FILE, including the describes that predate the
// hold. `openSubscribePage` now arms `PURCHASE_HOLD_CEILING_MS`, five real
// minutes, and does not release it on the way out by design — so under real
// timers every https case leaves a live handle and jest hangs after the run
// with "Jest did not exit one second after the test run has completed".
// `jest.useRealTimers()` in the matching afterEach discards the pending ones.
// The `Date.now` spies below still win: a spy overrides the faked clock.
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  __resetAppRestartForTests();
});

afterEach(() => {
  jest.useRealTimers();
});

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

// The money-path hold. What is pinned here is not "a hold is taken" but the
// two ways it ends, because a hold that never releases silently disables the
// restart feature for the rest of the session and nothing surfaces it.
describe('holdRestartAcrossPurchase', () => {
  let handler: (s: AppStateStatus) => void;
  const remove = jest.fn();

  beforeEach(() => {
    handler = () => {};
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_e, h: (s: AppStateStatus) => void) => {
        handler = h;
        return { remove } as never;
      });
  });

  it('holds under the label it was given, immediately', () => {
    holdRestartAcrossPurchase('purchase');
    expect(activeHolds()).toEqual(['purchase']);
  });

  it('releases 20 seconds after a true return, not on the return itself', () => {
    holdRestartAcrossPurchase('purchase');

    handler('background');
    handler('active');
    // The restart fires ON this transition. The hold has to outlive it, or the
    // "Did you subscribe to X?" prompt never renders.
    jest.advanceTimersByTime(PURCHASE_HOLD_AFTER_RETURN_MS - 1);
    expect(activeHolds()).toEqual(['purchase']);

    jest.advanceTimersByTime(1);
    expect(activeHolds()).toEqual([]);
  });

  // iOS presents both the paywall and SFSafariViewController in-process, so
  // AppState can stay `active` for the whole checkout and the return event
  // this schedules on may never arrive. The ceiling is armed at t=0 for
  // exactly that case; if it were armed on the return it would be armed by an
  // event that never happens, and the hold would leak for the session.
  it('releases at the ceiling even when the app never backgrounds at all', () => {
    holdRestartAcrossPurchase('purchase');

    jest.advanceTimersByTime(PURCHASE_HOLD_CEILING_MS - 1);
    expect(activeHolds()).toEqual(['purchase']);

    jest.advanceTimersByTime(1);
    expect(activeHolds()).toEqual([]);
  });

  it('re-arms the window on a second trip away', () => {
    holdRestartAcrossPurchase('purchase');

    handler('background');
    handler('active');
    jest.advanceTimersByTime(PURCHASE_HOLD_AFTER_RETURN_MS - 1_000);

    // Off to the bank's app and back.
    handler('background');
    handler('active');
    jest.advanceTimersByTime(PURCHASE_HOLD_AFTER_RETURN_MS - 1);
    expect(activeHolds()).toEqual(['purchase']);

    jest.advanceTimersByTime(1);
    expect(activeHolds()).toEqual([]);
  });

  // Same trap `onReturnFromBackground` guards: iOS reports `inactive` for the
  // app switcher and a pulled-down notification banner, neither a departure.
  it('does not schedule a release on an inactive transient', () => {
    holdRestartAcrossPurchase('purchase');

    handler('inactive');
    handler('active');
    jest.advanceTimersByTime(PURCHASE_HOLD_AFTER_RETURN_MS * 2);

    expect(activeHolds()).toEqual(['purchase']);
  });

  it('removes its AppState listener when it releases, so a checkout leaks nothing', () => {
    const release = holdRestartAcrossPurchase('purchase');
    release();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(activeHolds()).toEqual([]);
  });

  it('is idempotent: a second release neither throws nor drops someone else’s hold', () => {
    const first = holdRestartAcrossPurchase('purchase');
    const second = holdRestartAcrossPurchase('purchase');

    first();
    first();
    expect(activeHolds()).toEqual(['purchase']);

    second();
    expect(activeHolds()).toEqual([]);
  });

  it('a released hold is never resurrected by a later return', () => {
    const release = holdRestartAcrossPurchase('purchase');
    release();

    handler('background');
    handler('active');
    jest.advanceTimersByTime(PURCHASE_HOLD_CEILING_MS);

    expect(activeHolds()).toEqual([]);
  });

  describe('openSubscribePage', () => {
    it('holds the restart off before the browser opens', async () => {
      await openSubscribePage('https://example.com/sub');
      // NOT released on the way out: the user has not left yet.
      expect(activeHolds()).toEqual(['purchase']);
    });

    it('takes no hold when it refuses the URI', async () => {
      await openSubscribePage('http://example.com/sub');
      expect(activeHolds()).toEqual([]);
    });

    it('releases immediately when the browser itself throws', async () => {
      (openInAppBrowser as jest.Mock).mockRejectedValueOnce(new Error('no browser'));
      await expect(openSubscribePage('https://example.com/sub')).rejects.toThrow('no browser');
      expect(activeHolds()).toEqual([]);
    });
  });
});
