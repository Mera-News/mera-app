import Constants from 'expo-constants';
import { authClient, getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { AUTH_ENDPOINT } from '@/lib/config/endpoints';
import {
  FIXTURE_ACCOUNT,
  failSecureStore,
  http,
  HttpResponse,
  secureStoreDump,
  server,
  signInFixtureAccount,
} from '@/test/helpers';
import { getLastOtpEmail } from '@/test/mock-backend/auth';

// The setup's expo-constants mock has no ExecutionEnvironment, so the real expo-linking
// throws inside the expo client's getOrigin(). A native edge, so a mock is allowed.
// ponytail: belongs in jest.setup.native.js (harness-owned); every test that touches
// the auth client needs it until then.
jest.mock('expo-linking', () => ({
  createURL: (path: string, opts?: { scheme?: string }) => `${opts?.scheme ?? 'app'}://${path}`,
}));

const COOKIE_KEY = `${Constants.expoConfig?.slug || 'app'}_cookie`;

const jwtPayload = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

describe('mock auth: email OTP round trip through the real auth client', () => {
  // getJwtToken keeps a 30s module-level cache across tests.
  beforeEach(() => invalidateJwtCache());

  it('is signed out at first: no JWT, no session', async () => {
    expect(await getJwtToken()).toBeNull();
    const session = await authClient.getSession();
    expect(session.error).toBeNull();
    expect(session.data).toBeNull();
  });

  it('signs the fixture account in and persists the session cookie', async () => {
    await signInFixtureAccount();
    expect(getLastOtpEmail()).toBe(FIXTURE_ACCOUNT.email);

    const { data } = await authClient.getSession();
    expect(data?.user.id).toBe(FIXTURE_ACCOUNT.userId);

    const jwt = await getJwtToken();
    expect(jwt?.split('.')).toHaveLength(3);
    expect(jwtPayload(jwt as string).sub).toBe(FIXTURE_ACCOUNT.userId);

    // Positive control: the Set-Cookie header reached the expo client and the secure store.
    const stored = JSON.parse(secureStoreDump()[COOKIE_KEY]);
    expect(stored['better-auth.session_token'].value).toMatch(/^[\w-]+\./);
  });

  it('rejects a wrong code and stays signed out', async () => {
    const res = await authClient.signIn.emailOtp({ email: FIXTURE_ACCOUNT.email, otp: '000000' });
    expect(res.error).toMatchObject({ status: 400, code: 'INVALID_OTP' });
    expect((await authClient.getSession()).data).toBeNull();
    expect(secureStoreDump()[COOKIE_KEY]).toBeUndefined();
  });

  it('answers the scenario variants the persona seams rely on', async () => {
    const mismatch = await authClient.signIn.emailOtp({
      email: FIXTURE_ACCOUNT.email,
      otp: FIXTURE_ACCOUNT.otp,
      expectedUserId: '66e2e0000000000000000002',
    } as { email: string; otp: string });
    expect(mismatch.error).toMatchObject({ status: 409, code: 'REAUTH_ACCOUNT_MISMATCH' });

    const invalidEmail = await authClient.signIn.emailOtp({ email: 'nope', otp: FIXTURE_ACCOUNT.otp });
    expect(invalidEmail.error).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect((await authClient.getSession()).data).toBeNull();
  });

  it('signs out: the session is gone server side and the cookie is cleared', async () => {
    await signInFixtureAccount();
    expect((await authClient.getSession()).data).not.toBeNull();

    await authClient.signOut();
    expect((await authClient.getSession()).data).toBeNull();
    invalidateJwtCache();
    expect(await getJwtToken()).toBeNull();
  });

  it('degrades to a null JWT when the keychain read fails', async () => {
    await signInFixtureAccount();
    failSecureStore(COOKIE_KEY, 'get');
    invalidateJwtCache();
    await expect(getJwtToken()).resolves.toBeNull();
  });

  describe('the app routes', () => {
    it('probes, accepts legal terms and requests deletion once signed in', async () => {
      expect((await fetch(`${AUTH_ENDPOINT}/api/auth/ok`)).status).toBe(200);

      const body = { termsVersion: '1', privacyVersion: '1' };
      const signedOut = await authClient.$fetch('/accept-legal', { method: 'POST', body });
      expect(signedOut.error).toMatchObject({ status: 401 });

      await signInFixtureAccount();
      expect((await authClient.$fetch('/accept-legal', { method: 'POST', body })).error).toBeNull();
      expect((await authClient.$fetch('/request-account-deletion', { method: 'POST' })).error).toBeNull();
    });

    it('serves the device routes without a session', async () => {
      const nonce = await authClient.$fetch<{ nonce: string }>('/device/nonce', { method: 'POST', body: { purpose: 'attest' } });
      expect(nonce.data?.nonce).toMatch(/^[\w-]{20,}$/);

      const device = await authClient.$fetch<{ user: { id: string }; trialAvailable: boolean }>('/device/sign-in/dev', {
        method: 'POST',
        body: { token: 'x' },
      });
      expect(device.data).toMatchObject({ user: { id: FIXTURE_ACCOUNT.userId }, trialAvailable: false });
      expect((await authClient.getSession()).data?.user.id).toBe(FIXTURE_ACCOUNT.userId);

      const confirm = (otp: string) =>
        authClient.$fetch('/device/email/confirm', { method: 'POST', body: { email: FIXTURE_ACCOUNT.email, otp } });
      expect((await confirm(FIXTURE_ACCOUNT.otp)).error).toBeNull();
      expect((await confirm('000000')).error).toMatchObject({ status: 400 });
    });
  });

  it('serves the image asset route', async () => {
    const res = await fetch(`${AUTH_ENDPOINT}/assets/img/a.jpg`);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });

  it('lets a per-test override win over the handlers', async () => {
    server.use(http.get('*/api/auth/get-session', () => HttpResponse.json(null, { status: 503 })));
    expect((await authClient.getSession()).data).toBeNull();
  });
});
