// cloudComplete (the single buffered completion) against the gateway mock: real auth, real E2EE
// both ways, real limiter, real model fallback. What the model side received comes from the mock's
// decrypted call log; what is only visible on the wire (temperature, max_tokens, the thinking flag,
// that nothing is in the clear) comes from the raw request body.
import { _getBreakerState, _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import {
  cloudComplete,
} from '@/lib/llm/cloudComplete';
import logger from '@/lib/logger';
import { mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import {
  errorOf,
  fakeClock,
  resetTransport,
  respond,
  run,
} from './transport-kit';

const SECRET_SYSTEM = 'SENTINEL-SYSTEM-5e2a you are the test model';
const SECRET_USER = 'SENTINEL-USER-b07c what is the news';
const REQUEST = { systemPrompt: SECRET_SYSTEM, prompt: SECRET_USER };

beforeEach(async () => {
  await resetTransport({ signIn: false });
});

afterEach(() => {
  server.events.removeAllListeners();
});

const signedIn = async () => {
  await signInFixtureAccount();
  fakeClock();
};

describe('cloudComplete', () => {
  beforeEach(signedIn);
  const failWith = async (status: number) => {
    server.use(...mockGateway(respond({ status, body: 'gateway said no' })));
    const err = await run(errorOf(cloudComplete(REQUEST)));
    expect(err).toBeInstanceOf(Error);
    return err as Error & { statusCode?: number };
  };

  // The consequence: callers hand the error to logger.captureException, whose 401 rule feeds the auth
  // breaker from statusCode. A dead session that survives the re-mint never reaches it.
  it('CH17: a 401 that survives the re-mint reaches the auth breaker', async () => {
    resetBreaker();
    const err = await failWith(401);

    logger.captureException(err, { tags: { service: 'cloud-complete-test' } });

    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });
});
