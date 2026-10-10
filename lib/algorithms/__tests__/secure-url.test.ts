// secure-url — the https-only guard for article URLs (item 16, defence in
// depth). The server already excludes insecure articles from every serving
// path; these cases pin the behaviour for rows ALREADY on the device.

import { isSecureUrl, secureUrlOrNull } from '../secure-url';

describe('isSecureUrl', () => {
    it.each([
        'https://example.com',
        'https://example.com/a/b?c=d#e',
        'HTTPS://EXAMPLE.COM/story',
        'https://sub.domain.example.co.uk/path',
    ])('accepts %s', (url) => {
        expect(isSecureUrl(url)).toBe(true);
    });

    it.each([
        ['plain http', 'http://example.com/story'],
        ['uppercase http', 'HTTP://example.com'],
        ['scheme-relative', '//example.com/story'],
        ['javascript', 'javascript:alert(1)'],
        ['data uri', 'data:text/html,<b>x</b>'],
        ['file', 'file:///etc/passwd'],
        ['app store scheme', 'itms-apps://itunes.apple.com/app/id1'],
        ['bare host', 'example.com/story'],
        ['no host', 'https://'],
        ['host is a path start', 'https:///story'],
        ['empty', ''],
        ['whitespace only', '   '],
    ])('rejects %s', (_label, url) => {
        expect(isSecureUrl(url)).toBe(false);
    });

    it('rejects a URL containing whitespace (corrupt or header-splitting)', () => {
        expect(isSecureUrl('https://example.com/a b')).toBe(false);
        expect(isSecureUrl('https://example.com/a\nSet-Cookie: x')).toBe(false);
    });

    it('tolerates surrounding whitespace on an otherwise valid URL', () => {
        expect(isSecureUrl('  https://example.com/story \n')).toBe(true);
    });

    it.each([null, undefined, 42, {}, []])('rejects the non-string %p', (value) => {
        expect(isSecureUrl(value as never)).toBe(false);
    });
});

describe('secureUrlOrNull', () => {
    it('returns the trimmed URL when secure', () => {
        expect(secureUrlOrNull('  https://example.com/story ')).toBe(
            'https://example.com/story',
        );
    });

    it('returns null for an insecure URL, so callers can render "unavailable"', () => {
        expect(secureUrlOrNull('http://example.com/story')).toBeNull();
    });

    it('returns null for absent input', () => {
        expect(secureUrlOrNull(null)).toBeNull();
        expect(secureUrlOrNull(undefined)).toBeNull();
    });
});
