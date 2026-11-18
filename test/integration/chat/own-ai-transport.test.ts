// The person's own AI service as the client's transport: off is today's gateway, on never touches it.
import { cloudComplete, transportServesJobs } from '@/lib/llm/cloudComplete';
import { OWN_AI_KEY } from '@/lib/own-services/keys';
import { ownAiState, saveOwnAiFields, type OwnAiConfig } from '@/lib/own-services/own-ai-state';
import {
  attestationRequests,
  failSecureStore,
  gatewayCalls,
  healSecureStore,
  http,
  HttpResponse,
  server,
  signInFixtureAccount,
} from '@/test/helpers';
import { fakeClock, resetTransport, run } from '@/test/integration/chat/transport/transport-kit';

const BASE = 'https://ai.own.test/v1';
const KEY = 'own-ai-key-12345678';
const REQUEST = { systemPrompt: 'system', prompt: 'user' };
const config = (over: Partial<OwnAiConfig> = {}): OwnAiConfig => ({
  v: 1, baseUrl: BASE, model: 'own-model', key: KEY, on: true, checkedAt: 1, status: 'connected', ...over,
});

let own: { url: string; headers: Headers }[];
beforeEach(async () => {
  await resetTransport({ signIn: false });
  ownAiState.resetMemory();
  own = [];
  server.use(
    http.post('https://ai.own.test/*', ({ request }) => {
      own.push({ url: request.url, headers: request.headers });
      return HttpResponse.json({ choices: [{ message: { content: 'own reply' } }] });
    }),
    http.post('https://ai2.own.test/*', ({ request }) => {
      own.push({ url: request.url, headers: request.headers });
      return HttpResponse.json({ choices: [{ message: { content: 'own reply' } }] });
    }),
  );
});

const viaGateway = async () => {
  await signInFixtureAccount();
  fakeClock();
  return run(cloudComplete(REQUEST));
};

it('no item: the call reaches the gateway and the own host gets nothing', async () => {
  await ownAiState.hydrate();
  await viaGateway();
  expect(gatewayCalls('chat')).toHaveLength(1);
  expect(own).toHaveLength(0);
  expect(transportServesJobs()).toBe(true);
});

it('on after hydrate: the call lands at the own host with the bearer and nothing from Mera', async () => {
  await ownAiState.save(config());
  expect(await cloudComplete(REQUEST)).toBe('own reply');
  expect(own).toHaveLength(1);
  expect(own[0].url).toBe(`${BASE}/chat/completions`);
  expect(own[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(own[0].headers.get('cookie')).toBeNull();
  expect(own[0].headers.get('x-mera-client')).toBeNull();
  expect(gatewayCalls()).toHaveLength(0);
  expect(attestationRequests()).toBe(0);
});

it('on with no key sends no bearer', async () => {
  await ownAiState.save(config({ key: null }));
  await cloudComplete(REQUEST);
  expect(own[0].headers.get('authorization')).toBeNull();
});

it('before hydrate: the call waits for the item, lands at the own host, and jobs are off', async () => {
  await ownAiState.save(config());
  ownAiState.resetMemory();
  expect(transportServesJobs()).toBe(false);
  await cloudComplete(REQUEST);
  expect(own).toHaveLength(1);
  expect(gatewayCalls()).toHaveLength(0);
  // The own transport never runs gateway jobs either, so scoring stays inline.
  expect(transportServesJobs()).toBe(false);
});

it('editing the address while on turns it off, the next call goes to the gateway, and the old transport is not reused', async () => {
  await ownAiState.save(config());
  await cloudComplete(REQUEST);
  expect(own).toHaveLength(1);
  await saveOwnAiFields({ baseUrl: 'https://ai2.own.test/v1', model: 'own-model', key: KEY });
  await viaGateway();
  expect(gatewayCalls('chat')).toHaveLength(1);
  expect(own).toHaveLength(1);
  await ownAiState.save({ ...ownAiState.get()!, on: true });
  await cloudComplete(REQUEST);
  expect(own[1].url).toBe('https://ai2.own.test/v1/chat/completions');
});

it('a throwing read: the call fails rather than reach the gateway, and lands at the own host once healed', async () => {
  await ownAiState.save(config());
  ownAiState.resetMemory();
  failSecureStore(OWN_AI_KEY, 'get');
  await expect(cloudComplete(REQUEST)).rejects.toThrow();
  expect(gatewayCalls()).toHaveLength(0);
  expect(own).toHaveLength(0);
  healSecureStore();
  await cloudComplete(REQUEST);
  expect(own).toHaveLength(1);
});

it('a provider error echoing the request leaves no key or address in what is thrown or reported', async () => {
  await ownAiState.save(config());
  server.use(
    http.post('https://ai.own.test/*', () =>
      HttpResponse.json({ error: `bad request, Authorization: Bearer ${KEY}, url ${BASE}` }, { status: 400 }),
    ),
  );
  const err = (await cloudComplete(REQUEST).then(() => null, (e: unknown) => e)) as Error & Record<string, unknown>;
  expect(err).toBeTruthy();
  expect(err.message).not.toContain(KEY);
  expect(err.message).not.toContain('ai.own.test');
  // The provider body rides on `responseBody`, which nothing reads or reports; if a caller ever puts it in
  // an error report, the report scrubber replaces the stored key and host.
  const { scrubOwnServices } = require('@/lib/own-services/report-scrub') as typeof import('@/lib/own-services/report-scrub');
  const reported = scrubOwnServices(String(err.responseBody ?? ''));
  expect(reported).not.toContain(KEY);
  expect(reported).not.toContain('ai.own.test');
});

it('after a logout wipe, the next sign-in on this phone starts with the mode off and no stored key', async () => {
  await ownAiState.save(config());
  const { wipeAllLocalUserData } = require('@/lib/security/local-wipe') as typeof import('@/lib/security/local-wipe');
  await wipeAllLocalUserData();
  const { secureStoreDump } = require('@/test/helpers/storage') as typeof import('@/test/helpers/storage');
  expect(secureStoreDump()[OWN_AI_KEY]).toBeUndefined();
  expect(ownAiState.isHydrated()).toBe(false);
  await ownAiState.hydrate();
  expect(ownAiState.get()).toBeNull();
  await viaGateway();
  expect(gatewayCalls('chat')).toHaveLength(1);
  expect(own).toHaveLength(0);
});
