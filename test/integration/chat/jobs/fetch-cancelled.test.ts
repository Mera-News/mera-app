// A native-cancelled /results fetch (expo fetch throws a plain `Error('fetch failed: cancelled')`,
// text localized per device) is not a Sentry event; a timeout or 5xx still is. Either way the stale
// requeue still runs. The only fake is globalThis.fetch for the results URL (the network edge).
import logger from '@/lib/logger';
import {
  batches,
  cleanupWorld,
  gateway,
  later,
  resetPipelineWorld,
  seedAndEnqueue,
  tick,
  warmAttestation,
} from '../../persona/scoring-pipeline-kit';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

beforeEach(() => resetPipelineWorld());
afterEach(cleanupWorld);

function failResultsWith(message: string): void {
  const real = globalThis.fetch;
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    /\/v1\/inference\/jobs\/[^/]+\/results/.test(String(input instanceof Request ? input.url : input))
      ? Promise.reject(new Error(message))
      : real(input, init),
  );
}

async function staleTickAfterFailure(message: string) {
  gateway();
  await warmAttestation();
  await seedAndEnqueue(['a0'], { flush: true });
  failResultsWith(message);
  await tick(); // starts the staleness clock
  later(16 * 60_000);
  await tick();
  return (await batches())[0];
}

const fetchCaptures = () =>
  (logger.captureException as jest.Mock).mock.calls.filter(([, ctx]) => ctx?.tags?.step === 'fetch');

describe('a failed results fetch in the scoring pipeline', () => {
  it('does not report a cancelled fetch, and still requeues the stale batch', async () => {
    const b = await staleTickAfterFailure('fetch failed: cancelled');

    expect(fetchCaptures()).toHaveLength(0);
    expect(b.attempt).toBe(1);
  });

  it('still reports a timeout-worded failure', async () => {
    await staleTickAfterFailure('fetch failed: The request timed out.');

    expect(fetchCaptures().length).toBeGreaterThan(0);
  });
});
