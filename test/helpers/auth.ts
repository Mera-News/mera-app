import { releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { FIXTURE_ACCOUNT } from '../mock-backend/fixtures/account';

export { FIXTURE_ACCOUNT };

/** Signs the fixture account in through the app's real client over the mock backend's email OTP
 *  (the app itself signs in only with the phone; this is the test fixture's way in). */
export async function signInFixtureAccount(): Promise<void> {
  // Required lazily so importing the helpers does not load the auth client (and its Sentry,
  // RevenueCat and Intercom imports) into every suite. MSW patches fetch at setup load, so a
  // static import elsewhere is safe too (test/integration/harness/fetch-capture.test.ts).
  const { authClient } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
  // The install boundary has not run in a test, and until it decides the latch answers every
  // sync read of the session cookie with null (lib/security/install-boundary-latch.ts).
  releaseAuthReadQuarantine();
  const sent = await authClient.emailOtp.sendVerificationOtp({ email: FIXTURE_ACCOUNT.email, type: 'sign-in' });
  if (sent.error) throw new Error(`sendVerificationOtp failed: ${JSON.stringify(sent.error)}`);
  const { error } = await authClient.signIn.emailOtp({
    email: FIXTURE_ACCOUNT.email,
    otp: FIXTURE_ACCOUNT.otp,
  });
  if (error) throw new Error(`signIn.emailOtp failed: ${JSON.stringify(error)}`);
}
