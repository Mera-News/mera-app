// sendOTP through the real better-auth client against the mock auth backend.
import i18next from 'i18next';
import { sendOTP } from '@/lib/auth-client';
import { FIXTURE_ACCOUNT, HttpResponse, http, initI18nEn, server } from '@/test/helpers';
import { getLastOtpEmail } from '@/test/mock-backend/auth';

const SEND = '*/api/auth/email-otp/send-verification-otp';

beforeAll(initI18nEn);

it('returns { success: true } and the server was asked for a code for that email', async () => {
    expect(await sendOTP(FIXTURE_ACCOUNT.email)).toEqual({ success: true });
    expect(getLastOtpEmail()).toBe(FIXTURE_ACCOUNT.email);
});

it('returns the server message when the server refuses', async () => {
    server.use(
        http.post(SEND, () => HttpResponse.json({ code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' }, { status: 429 })),
    );
    expect(await sendOTP('user@example.com')).toEqual({ success: false, error: 'Too many attempts' });
});

it('falls back to the localized failed-to-send copy when the error carries no message', async () => {
    server.use(http.post(SEND, () => new HttpResponse(null, { status: 500 })));
    const result = await sendOTP('user@example.com');
    expect(result.success).toBe(false);
    expect(result.error).toBe(i18next.t('auth.failedToSendBody'));
    expect(result.error).not.toBe('auth.failedToSendBody');
});

it('returns the failure when the request itself is rejected', async () => {
    server.use(http.post(SEND, () => HttpResponse.error()));
    const result = await sendOTP('user@example.com');
    expect(result.success).toBe(false);
    expect(result.error).toEqual(expect.any(String));
    expect(result.error).not.toBe('');
});
