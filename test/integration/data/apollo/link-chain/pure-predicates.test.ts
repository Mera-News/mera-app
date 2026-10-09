// The pure parts of lib/apollo-client.ts: the retry predicate and the Retry-After arithmetic.
// They sit in the integration project because importing the client needs its setup; P4 extracts
// them to lib/algorithms/ and these cases move to test/unit with them.
import { parseRetryAfterMs, shouldRetryOperation, throttleWaitMs } from '@/lib/apollo-client';
import { useNetworkStore } from '@/lib/stores/network-store';

describe('shouldRetryOperation', () => {
    beforeEach(() => useNetworkStore.setState({ isConnected: true }));

    it('never retries while offline, whatever the error shape', () => {
        useNetworkStore.setState({ isConnected: false });
        expect(shouldRetryOperation(new Error('network fail'))).toBe(false);
        expect(shouldRetryOperation({ statusCode: 500 })).toBe(false);
        expect(shouldRetryOperation({ response: { status: 503 } })).toBe(false);
        expect(shouldRetryOperation(undefined)).toBe(false);
    });

    it('retries a generic transport error and any 5xx while online', () => {
        expect(shouldRetryOperation(new Error('ECONNRESET'))).toBe(true);
        expect(shouldRetryOperation({ statusCode: 502 })).toBe(true);
        expect(shouldRetryOperation({ response: { status: 500 } })).toBe(true);
    });

    it('never retries a 4xx, 429 included', () => {
        expect(shouldRetryOperation({ statusCode: 400 })).toBe(false);
        expect(shouldRetryOperation({ statusCode: 402 })).toBe(false);
        expect(shouldRetryOperation({ response: { status: 404 } })).toBe(false);
        expect(shouldRetryOperation({ statusCode: 429 })).toBe(false);
        expect(shouldRetryOperation({ statusCode: 499 })).toBe(false);
    });

    it('never retries an error carrying a GraphQL `result`, nor a falsy error', () => {
        expect(shouldRetryOperation({ result: { errors: [] } })).toBe(false);
        expect(shouldRetryOperation(null)).toBe(false);
        expect(shouldRetryOperation(undefined)).toBe(false);
    });
});

describe('parseRetryAfterMs', () => {
    const withHeader = (value: string | null) => ({
        headers: { get: (name: string) => (name === 'retry-after' ? value : null) },
    });

    it('parses delta-seconds, and 0 as an immediate retry rather than absent', () => {
        expect(parseRetryAfterMs(withHeader('5'))).toBe(5000);
        expect(parseRetryAfterMs(withHeader('0'))).toBe(0);
    });

    it('parses an HTTP-date into a forward delta', () => {
        const ms = parseRetryAfterMs(withHeader(new Date(Date.now() + 12_000).toUTCString()));
        expect(ms).toBeGreaterThan(9_000);
        expect(ms).toBeLessThanOrEqual(13_000);
    });

    it('treats a past HTTP-date, an absent header and garbage as no instruction', () => {
        expect(parseRetryAfterMs(withHeader(new Date(Date.now() - 60_000).toUTCString()))).toBeNull();
        expect(parseRetryAfterMs(withHeader(null))).toBeNull();
        expect(parseRetryAfterMs(withHeader('soon'))).toBeNull();
        expect(parseRetryAfterMs(withHeader('-5'))).toBeNull();
        expect(parseRetryAfterMs(withHeader(''))).toBeNull();
    });

    it('returns null without a response, without headers, or when headers.get throws', () => {
        expect(parseRetryAfterMs(undefined)).toBeNull();
        expect(parseRetryAfterMs({})).toBeNull();
        expect(parseRetryAfterMs({ headers: {} })).toBeNull();
        expect(
            parseRetryAfterMs({
                headers: {
                    get: () => {
                        throw new Error('nope');
                    },
                },
            }),
        ).toBeNull();
    });
});

describe('throttleWaitMs', () => {
    it('falls back to exponential backoff when there is no header', () => {
        expect(throttleWaitMs(null, 0)).toBe(500);
        expect(throttleWaitMs(null, 1)).toBe(1000);
        expect(throttleWaitMs(null, 2)).toBe(2000);
    });

    it('never returns less than the server asked for, and adds at most 20 percent', () => {
        for (let i = 0; i < 500; i++) {
            const wait = throttleWaitMs(5000, 0);
            expect(wait).toBeGreaterThanOrEqual(5000);
            expect(wait).toBeLessThanOrEqual(6000);
        }
    });

    it('actually spreads rather than returning a constant', () => {
        const seen = new Set<number>();
        for (let i = 0; i < 200; i++) seen.add(throttleWaitMs(5000, 0));
        expect(seen.size).toBeGreaterThan(50);
    });

    it('caps the wait at 30s so three of them fit inside the 3 minute job timeout', () => {
        for (let i = 0; i < 200; i++) expect(throttleWaitMs(600_000, 0)).toBe(30_000);
        expect(throttleWaitMs(29_000, 0)).toBeLessThanOrEqual(30_000);
    });

    it('prefers the header over the backoff late in the attempt sequence', () => {
        expect(throttleWaitMs(5000, 2)).toBeGreaterThanOrEqual(5000);
    });
});
