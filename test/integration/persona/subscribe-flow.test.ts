// A publisher's own subscribe page (lib/subscriptions/subscribe-flow.ts): the URL builder, the https guard,
// the restart hold it takes, and the return-from-background prompt trigger. Real web-browser-utils, real
// app-restart and real AppState driver; the edges are the expo-web-browser fake and the logger spy.
// holdRestartAcrossPurchase on its own is pinned by purchase.test.ts.
import * as WebBrowser from 'expo-web-browser';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import logger from '@/lib/logger';
import { buildSubscriptionUrl, MIN_AWAY_MS, onReturnFromBackground, openSubscribePage } from '@/lib/subscriptions/subscribe-flow';
import { setAppState, useFakeClock } from '@/test/helpers';

const openBrowser = WebBrowser.openBrowserAsync as unknown as jest.Mock;

beforeEach(() => {
    // Fake timers for the whole file: openSubscribePage arms a five-minute ceiling it never releases on the way out.
    useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
    __resetAppRestartForTests();
    setAppState('active');
    openBrowser.mockClear();
    jest.spyOn(logger, 'captureMessage').mockImplementation(() => undefined as never);
});

afterEach(() => {
    jest.restoreAllMocks();
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
        expect(openBrowser).toHaveBeenCalledTimes(1);
        const opened = openBrowser.mock.calls[0][0] as string;
        expect(opened).toContain('utm_medium=subscription');
        expect(opened).toContain('utm_source=');
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
        expect(openBrowser).not.toHaveBeenCalled();
        expect(logger.captureMessage).toHaveBeenCalled();
    });

    it('pins a fingerprint so the refusal groups on its text, not its stack', async () => {
        await openSubscribePage('http://example.com/sub');
        const opts = (logger.captureMessage as jest.Mock).mock.calls[0][1];
        expect(opts.fingerprint).toEqual(['subscription-uri-insecure']);
    });

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
        openBrowser.mockRejectedValueOnce(new Error('no browser'));
        await expect(openSubscribePage('https://example.com/sub')).rejects.toThrow('no browser');
        expect(activeHolds()).toEqual([]);
    });
});

describe('onReturnFromBackground', () => {
    it('fires after a real background trip longer than the minimum', () => {
        const onReturn = jest.fn();
        onReturnFromBackground(onReturn);
        setAppState('background');
        jest.advanceTimersByTime(MIN_AWAY_MS + 1);
        setAppState('active');
        expect(onReturn).toHaveBeenCalledTimes(1);
    });

    it('does not fire when the trip was shorter than the minimum', () => {
        const onReturn = jest.fn();
        onReturnFromBackground(onReturn);
        setAppState('background');
        jest.advanceTimersByTime(MIN_AWAY_MS - 1);
        setAppState('active');
        expect(onReturn).not.toHaveBeenCalled();
    });

    // THE trap: iOS reports `inactive` for the app switcher and for a
    // notification banner pulled down over the browser. Neither is a departure,
    // and arming on them would prompt someone who never left.
    it('ignores an inactive transient and never arms on it', () => {
        const onReturn = jest.fn();
        onReturnFromBackground(onReturn);
        setAppState('inactive');
        jest.advanceTimersByTime(MIN_AWAY_MS + 5_000);
        setAppState('active');
        expect(onReturn).not.toHaveBeenCalled();
    });

    it('does not fire on an active event with no preceding background', () => {
        const onReturn = jest.fn();
        onReturnFromBackground(onReturn);
        setAppState('active');
        expect(onReturn).not.toHaveBeenCalled();
    });

    it('fires once per background trip, not on every later foreground', () => {
        const onReturn = jest.fn();
        onReturnFromBackground(onReturn);
        setAppState('background');
        jest.advanceTimersByTime(MIN_AWAY_MS + 1);
        setAppState('active');
        setAppState('active');
        expect(onReturn).toHaveBeenCalledTimes(1);
    });

    it('removes the listener on unsubscribe', () => {
        const onReturn = jest.fn();
        onReturnFromBackground(onReturn)();
        setAppState('background');
        jest.advanceTimersByTime(MIN_AWAY_MS + 1);
        setAppState('active');
        expect(onReturn).not.toHaveBeenCalled();
    });
});
