// Shared kit for the auth-client seam tests: the real better-auth client against the mock auth backend.
import { invalidateJwtCache } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { _resetJwtSubscriptionGateForTests } from '@/lib/subscription/jwt-subscription-gate';
import { http, HttpResponse, server } from '@/test/helpers';

export interface AuthRequest {
    method: string;
    path: string;
    cookie: string | null;
}

const stops: (() => void)[] = [];
afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
});

/** Module-level memory in auth-client (the JWT cache, the subscription latch) outlives a test: call in beforeEach. */
export function resetAuthModuleState(): void {
    invalidateJwtCache();
    _resetJwtSubscriptionGateForTests();
}

/** Every request MSW receives for the auth service from now on. Stops itself after the test. */
export function recordAuth(): AuthRequest[] {
    const seen: AuthRequest[] = [];
    const listener = ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/api/auth/')) return;
        seen.push({ method: request.method, path: url.pathname.slice('/api/auth'.length), cookie: request.headers.get('cookie') });
    };
    server.events.on('request:start', listener);
    stops.push(() => server.events.removeListener('request:start', listener));
    return seen;
}

/** How many recorded requests hit `path` (e.g. '/token'). */
export const hits = (seen: AuthRequest[], path: string): number => seen.filter((r) => r.path === path).length;

/** Spies on the logger edge: nothing reaches Sentry. */
export function spyLogger() {
    const capture = jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never);
    stops.push(() => capture.mockRestore());
    return { capture };
}

/** `/token` answers 403 SUBSCRIPTION_REQUIRED, the auth service's refusal for an unsubscribed user. */
export const subscriptionRequired = (opts: { once?: boolean } = {}) =>
    http.get(
        '*/api/auth/token',
        () => HttpResponse.json({ code: 'SUBSCRIPTION_REQUIRED', message: 'Active subscription required' }, { status: 403 }),
        opts,
    );

/** `/token` answers 401, an expired or revoked session. */
export const tokenUnauthorized = () =>
    http.get('*/api/auth/token', () => HttpResponse.json({ code: 'UNAUTHORIZED', message: 'Unauthorized' }, { status: 401 }));

/** The two keychain keys the expo client writes, found by suffix so the test does not restate the app slug. */
export function authKeys(dump: Record<string, string>): { cookie?: string; session?: string } {
    const keys = Object.keys(dump);
    return { cookie: keys.find((k) => k.endsWith('_cookie')), session: keys.find((k) => k.endsWith('_session_data')) };
}
