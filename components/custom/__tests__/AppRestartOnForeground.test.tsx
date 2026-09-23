// What arms the restart, and what must never arm it.
//
// The component itself is three lines of decision, and all three are the kind
// that fail silently on a device: an over-eager arm restarts users who never
// left (mid-tap, from a notification banner they pulled down), and a route that
// slips off the blocked list wipes a login code on the return that delivered it.
// Neither shows up as an error anywhere, so they are asserted directly here
// rather than implied.

import { render } from '@testing-library/react-native';
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

// Stubbed, and NOT optional: the real module lazy-requires setting-service,
// which imports the SQLite singleton at module scope.
const mockRequestRestart = jest.fn(async (_reason: string) => {});
jest.mock('@/lib/app-restart', () => ({
    requestRestart: (reason: string) => mockRequestRestart(reason),
}));

// The live route, read from lib/nav-state's module mirror rather than a hook.
let mockPathname = '/logged-in/app_container/feed';
jest.mock('@/lib/nav-state', () => ({
    getCurrentPathname: () => mockPathname,
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), captureException: jest.fn() },
}));

import AppRestartOnForeground, {
    RESTART_BLOCKED_ROUTES,
    isRestartBlockedRoute,
} from '../AppRestartOnForeground';

/** The AppState handler the component registered on mount. */
let handler: ((state: AppStateStatus) => void) | null = null;
const remove = jest.fn();

beforeEach(() => {
    jest.clearAllMocks();
    handler = null;
    mockPathname = '/logged-in/app_container/feed';
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, h) => {
        handler = h as (state: AppStateStatus) => void;
        return { remove } as ReturnType<typeof AppState.addEventListener>;
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

/** Mounts the component and returns the render result plus a driver for the
 *  AppState transitions, which is the only input this component has. */
const mount = () => {
    const r = render(<AppRestartOnForeground />);
    const send = (...states: AppStateStatus[]) => {
        for (const state of states) handler?.(state);
    };
    return { ...r, send };
};

describe('arming', () => {
    it('restarts on a true background -> active return', () => {
        const { send } = mount();
        send('background', 'active');
        expect(mockRequestRestart).toHaveBeenCalledWith('foreground');
    });

    // THE ONE THAT MATTERS MOST. iOS reports `inactive` for the app switcher, a
    // notification banner pulled down over the app, and a Control Centre swipe.
    // None of those is a departure, and arming on them restarts a user who never
    // left — mid-tap, with whatever they were doing gone. Asserted directly, not
    // through the transition test below, because `!== 'active'` is the single
    // most likely "simplification" someone applies to this file later.
    it('does NOT restart on an inactive -> active transition', () => {
        const { send } = mount();
        send('inactive', 'active');
        expect(mockRequestRestart).not.toHaveBeenCalled();
    });

    it('does NOT restart on active -> inactive -> active with no background', () => {
        const { send } = mount();
        send('active', 'inactive', 'active');
        expect(mockRequestRestart).not.toHaveBeenCalled();
    });

    // An `inactive` on the way out is the normal iOS sequence
    // (active -> inactive -> background), so it must not disarm what follows.
    it('restarts across the full iOS departure sequence', () => {
        const { send } = mount();
        send('inactive', 'background', 'inactive', 'active');
        expect(mockRequestRestart).toHaveBeenCalledTimes(1);
    });

    // Disarmed on use: the second `active` is not a second return.
    it('arms once per departure', () => {
        const { send } = mount();
        send('background', 'active', 'active');
        expect(mockRequestRestart).toHaveBeenCalledTimes(1);

        send('background', 'active');
        expect(mockRequestRestart).toHaveBeenCalledTimes(2);
    });

    it('does not restart on the mount alone, with no transition at all', () => {
        mount();
        expect(mockRequestRestart).not.toHaveBeenCalled();
    });
});

describe('route blocking', () => {
    // COUNT as well as membership. A `toContain`-only assertion passes whether
    // the list holds five routes or fifty, so neither an addition nor a deletion
    // could fail it — and `/pin-lock` in particular is on this list for a
    // security reason (see pin-store's restart hold), not a convenience one.
    it('blocks exactly these five routes, no more and no fewer', () => {
        expect([...RESTART_BLOCKED_ROUTES]).toEqual([
            '/login',
            '/verify-otp',
            '/pin-setup',
            '/pin-lock',
            '/logged-in/onboarding',
        ]);
        expect(RESTART_BLOCKED_ROUTES).toHaveLength(5);
    });

    it.each([...RESTART_BLOCKED_ROUTES])('does not restart a return on %s', (route) => {
        mockPathname = route;
        const { send } = mount();
        send('background', 'active');
        expect(mockRequestRestart).not.toHaveBeenCalled();
    });

    // Prefix matching, not equality: these routes carry params and children.
    it.each([
        '/verify-otp?email=x',
        '/logged-in/onboarding/step-2',
        '/pin-setup?mode=change',
    ])('does not restart a return on %s', (route) => {
        mockPathname = route;
        const { send } = mount();
        send('background', 'active');
        expect(mockRequestRestart).not.toHaveBeenCalled();
    });

    it.each([
        '/logged-in/app_container/feed',
        '/logged-in/article-detail',
        '/logged-in/profile-advanced',
        '/',
    ])('DOES restart a return on %s', (route) => {
        mockPathname = route;
        const { send } = mount();
        send('background', 'active');
        expect(mockRequestRestart).toHaveBeenCalledWith('foreground');
    });

    // The route is read at RETURN time, not at mount time — the user can have
    // navigated anywhere in between, and on iOS the lock screen in particular is
    // pushed over whatever they were on.
    it('reads the route on the return, not on the mount', () => {
        const { send } = mount();
        mockPathname = '/pin-lock';
        send('background', 'active');
        expect(mockRequestRestart).not.toHaveBeenCalled();
    });

    it('isRestartBlockedRoute matches on prefix and nothing else', () => {
        expect(isRestartBlockedRoute('/login')).toBe(true);
        expect(isRestartBlockedRoute('/logged-in/onboarding')).toBe(true);
        // Not a prefix of any blocked route, and notably not caught by /login.
        expect(isRestartBlockedRoute('/logged-in/app_container/feed')).toBe(false);
        expect(isRestartBlockedRoute('/logged-in/notifications')).toBe(false);
    });
});

describe('lifecycle', () => {
    it('removes the AppState subscription on unmount', () => {
        const r = mount();
        expect(remove).not.toHaveBeenCalled();
        r.unmount();
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('renders nothing', () => {
        const r = mount();
        expect(r.toJSON()).toBeNull();
    });
});
