import { releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { FIXTURE_ACCOUNT } from '../mock-backend/fixtures/account';

export { FIXTURE_ACCOUNT };

/** Signs the fixture account in through the app's real client: the same two calls the sign-in screen makes. */
export async function signInFixtureAccount(): Promise<void> {
  // Required here, not imported: better-auth captures globalThis.fetch when the client is
  // created, so the module must first load after msw has patched fetch (the setup's
  // beforeAll). A static import here would load it for every test that imports the helpers.
  const { authClient, sendOTP } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
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
