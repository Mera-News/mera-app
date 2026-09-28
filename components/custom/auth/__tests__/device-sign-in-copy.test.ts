// device-sign-in-copy.test.ts: the sign-in copy is keyed on the attestation
// path actually taken, because what is TRUE differs per path. Apple is named
// only for App Attest, Google only for Play Integrity, the dev bypass claims
// no platform check, and only ANDROID_ID survives an uninstall.

jest.mock('@/lib/config/branding', () => ({ FAQ_URL: 'https://mera.news/faq' }));

import {
    NO_EMAIL_FAQ_URL,
    consentNoticeKey,
    deviceSignInCaptionKey,
} from '../device-sign-in-copy';

describe('consentNoticeKey', () => {
    it.each([
        ['app-attest', 'consent.deviceNotice.appAttest'],
        ['play-integrity', 'consent.deviceNotice.playIntegrity'],
        ['play-integrity-uuid', 'consent.deviceNotice.playIntegrity'],
        ['dev-bypass', 'consent.deviceNotice.generic'],
        ['unavailable', null],
    ] as const)('%s -> %s', (path, key) => {
        expect(consentNoticeKey(path)).toBe(key);
    });
});

describe('deviceSignInCaptionKey', () => {
    it.each([
        ['app-attest', 'auth.deviceSignInCaption.uninstall'],
        ['play-integrity', 'auth.deviceSignInCaption.reset'],
        ['play-integrity-uuid', 'auth.deviceSignInCaption.uninstall'],
        ['dev-bypass', 'auth.deviceSignInCaption.uninstall'],
        ['unavailable', null],
    ] as const)('%s -> %s', (path, key) => {
        expect(deviceSignInCaptionKey(path)).toBe(key);
    });
});

it('the FAQ link is unprefixed and carries the no-email anchor', () => {
    // withAppLanguage would insert the app locale (pt-BR, zh-CN, zh-TW), which
    // the site does not route; its proxy picks the locale and keeps the anchor.
    expect(NO_EMAIL_FAQ_URL).toBe('https://mera.news/faq#no-email');
});

it('every key it can return exists in en.json', () => {
    const en = require('../../../../lib/locales/en.json');
    const get = (k: string) => k.split('.').reduce((o: any, p) => o?.[p], en);
    const paths = ['app-attest', 'play-integrity', 'play-integrity-uuid', 'dev-bypass'] as const;
    for (const p of paths) {
        expect(typeof get(consentNoticeKey(p)!)).toBe('string');
        expect(typeof get(deviceSignInCaptionKey(p)!)).toBe('string');
    }
});
