/**
 * Play Integrity error classification (release fix for MERA-APP-6P): codes
 * that mean this ENVIRONMENT can structurally never attest map to the same
 * quiet path as isSupported() === false. Values verified against the official
 * IntegrityErrorCode reference; play-core embeds the code as the first
 * negative integer in the exception message.
 */

import { isIntegrityUnavailableError } from '../index';

const integrityError = (message: string) =>
    Object.assign(new Error(message), { code: 'ERR_ATTEST_INTEGRITY_FAILED' });

describe('isIntegrityUnavailableError', () => {
    it.each([
        [-1, 'API_NOT_AVAILABLE'],
        [-2, 'PLAY_STORE_NOT_FOUND'],
        [-6, 'PLAY_SERVICES_NOT_FOUND'],
        [-9, 'CANNOT_BIND_TO_SERVICE'],
        [-14, 'PLAY_STORE_VERSION_OUTDATED'],
        [-15, 'PLAY_SERVICES_VERSION_OUTDATED'],
    ])('permanent code %i (%s) -> true', (code) => {
        const e = integrityError(
            `Play Integrity token request failed: Integrity API error (${code}): details.`,
        );
        expect(isIntegrityUnavailableError(e)).toBe(true);
    });

    it.each([
        [-3, 'NETWORK_ERROR'],
        [-8, 'TOO_MANY_REQUESTS'],
        [-12, 'GOOGLE_SERVER_UNAVAILABLE'],
        [-17, 'CLIENT_TRANSIENT_ERROR'],
        [-100, 'INTERNAL_ERROR'],
        [-10, 'NONCE_TOO_SHORT'],
        [-16, 'CLOUD_PROJECT_NUMBER_IS_INVALID'],
    ])('transient/misuse code %i (%s) -> false (stays retryable)', (code) => {
        const e = integrityError(
            `Play Integrity token request failed: Integrity API error (${code}): details.`,
        );
        expect(isIntegrityUnavailableError(e)).toBe(false);
    });

    it('ignores other error codes and codeless messages', () => {
        expect(
            isIntegrityUnavailableError(
                Object.assign(new Error('Integrity API error (-1)'), { code: 'ERR_ATTEST_UNKNOWN' }),
            ),
        ).toBe(false);
        expect(isIntegrityUnavailableError(integrityError('no code in here'))).toBe(false);
        expect(isIntegrityUnavailableError(null)).toBe(false);
    });
});
