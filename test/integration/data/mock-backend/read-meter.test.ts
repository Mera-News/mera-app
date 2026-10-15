// The gateway mock's reading meter (setReadMeter) on /v1/inference/jobs: what
// the persona scoring tests rely on. A held submit is refused before anything
// is decrypted, so the refusal cases POST a bare body.

import { prepareE2EEContext } from '@/lib/e2ee/e2ee-service';
import { invalidateJwtCache } from '@/lib/auth-client';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { sendInferenceRequest } from '@/lib/llm/submitInferenceJob';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { assertNoGatewayViolations, gatewayCalls, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';
import { OLD_CLIENT_QUOTA_STATUS } from '@/test/mock-backend/gateway/handlers';
import { setReadMeter } from '@/test/mock-backend/gateway/state';

const JOBS = 'http://127.0.0.1:8790/v1/inference/jobs';
const NOW = Date.UTC(2026, 9, 15, 23, 59, 0);
const RESET = Date.UTC(2026, 9, 16, 0, 0, 0);

const post = (headers: Record<string, string>) =>
  fetch(JOBS, {
    method: 'POST',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ e2eeSession: {}, requests: [] }),
  });

async function submit(idempotencyKey: string) {
  const ctx = await prepareE2EEContext(SMALL_MODEL);
  return sendInferenceRequest({
    bundle: { calls: [{ id: 'score:0', system: 's', prompt: 'p' }] } as never,
    ctx,
    token: null,
    model: SMALL_MODEL,
    context: 'foreground',
    idempotencyKey,
  });
}

/** The X-Mera-Reading-Used header of every mocked jobs 202, in order. */
function usedHeaders(): (string | null)[] {
  const seen: (string | null)[] = [];
  server.events.on('response:mocked', ({ request, response }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/v1/inference/jobs' && response.status === 202) {
      seen.push(response.headers.get('x-mera-reading-used'));
    }
  });
  return seen;
}

beforeEach(async () => {
  resetLimiter();
  clearAttestationCache();
  invalidateJwtCache();
  useFakeClock(NOW, { advanceTimers: true });
  await signInFixtureAccount();
});

afterEach(() => {
  server.events.removeAllListeners();
  assertNoGatewayViolations();
});

it('held, with X-Mera-Reading: 1: 429 daily-quota-exceeded, ISO resetAt, Retry-After capped at 60', async () => {
  setReadMeter({ resetAt: RESET });
  const res = await post({ 'x-mera-reading': '1' });
  expect(res.status).toBe(429);
  expect(res.headers.get('retry-after')).toBe('60');
  expect(await res.json()).toEqual({ code: 'daily-quota-exceeded', resetAt: new Date(RESET).toISOString() });
});

it('Retry-After counts down to the reset when it is under a minute away', async () => {
  setReadMeter({ resetAt: NOW + 12_500 });
  const res = await post({ 'x-mera-reading': '1' });
  expect(res.headers.get('retry-after')).toBe('13');
});

it('held, without the header (an old bundle): the old-client status, same body, no Retry-After', async () => {
  setReadMeter({ resetAt: RESET });
  const res = await post({});
  expect(res.status).toBe(OLD_CLIENT_QUOTA_STATUS);
  expect(OLD_CLIENT_QUOTA_STATUS).toBe(402);
  expect(res.headers.get('retry-after')).toBeNull();
  expect((await res.json()).code).toBe('daily-quota-exceeded');
});

it('not held: 202 carries X-Mera-Reading-Used; a replay is the cached 202 with no header', async () => {
  const seen = usedHeaders();
  setReadMeter({ used: 0.62 });
  const first = await submit('key-1');
  expect(first.status).toBe('ok');
  // Held after the first job: the replay of the same key is still accepted and never refused.
  setReadMeter({ resetAt: RESET });
  const again = await submit('key-1');
  expect(again).toMatchObject({ status: 'ok' });
  expect(seen).toEqual(['0.62', null]);
  expect(gatewayCalls('job')).toHaveLength(1);
});

it('a past resetAt is not a hold, and no meter means no header', async () => {
  const seen = usedHeaders();
  setReadMeter({ resetAt: NOW - 1 });
  expect((await submit('key-2')).status).toBe('ok');
  expect(seen).toEqual([null]);
});
