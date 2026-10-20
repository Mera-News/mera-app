// device-sign-in-copy.test.ts: the sign-in copy is keyed on the attestation
// path actually taken, because what is TRUE differs per path. Apple is named
// only for App Attest, Google only for Play Integrity, the dev bypass claims
// no platform check, and only ANDROID_ID survives an uninstall.

import path from 'path';
import { consentNoticeKey, deviceFailureKey, phoneUnsupportedKey } from '@/components/custom/auth/device-sign-in-copy';

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

it('every key it can return exists in en.json', () => {
    const en = require(path.resolve(__dirname, '../../../..', 'lib/locales/en.json'));
    const get = (k: string) => k.split('.').reduce((o: any, p) => o?.[p], en);
    const paths = ['app-attest', 'play-integrity', 'play-integrity-uuid', 'dev-bypass'] as const;
    for (const p of paths) {
        expect(typeof get(consentNoticeKey(p)!)).toBe('string');
    }
});

describe('deviceFailureKey', () => {
    it.each([
        ['network', 'auth.phoneCheckTemporary'],
        ['attestation-unavailable', 'auth.phoneCheckTemporary'],
        ['attestation-denied', 'auth.deviceSignInDenied'],
        ['unknown', 'auth.deviceSignInFailed'],
    ] as const)('%s -> %s', (reason, key) => {
        expect(deviceFailureKey(reason)).toBe(key);
    });
});

describe('phoneUnsupportedKey', () => {
    it('names the platform: iPhone on iOS, Google Play everywhere else', () => {
        expect(phoneUnsupportedKey('ios')).toBe('auth.phoneUnsupportedIos');
        expect(phoneUnsupportedKey('android')).toBe('auth.phoneUnsupportedAndroid');
    });
});
