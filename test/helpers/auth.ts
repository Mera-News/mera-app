import { authClient, sendOTP } from '@/lib/auth-client';
import { releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { FIXTURE_ACCOUNT } from '../mock-backend/fixtures/account';

export { FIXTURE_ACCOUNT };

/** Signs the fixture account in through the app's real client: the same two calls the sign-in screen makes. */
export async function signInFixtureAccount(): Promise<void> {
  // The install boundary has not run in a test, and until it decides the latch answers every
  // sync read of the session cookie with null (lib/security/install-boundary-latch.ts).
  releaseAuthReadQuarantine();
  const sent = await sendOTP(FIXTURE_ACCOUNT.email);
  if (!sent.success) throw new Error(`sendOTP failed: ${sent.error}`);
  const { error } = await authClient.signIn.emailOtp({
    email: FIXTURE_ACCOUNT.email,
    otp: FIXTURE_ACCOUNT.otp,
  });
  if (error) throw new Error(`signIn.emailOtp failed: ${JSON.stringify(error)}`);
}
