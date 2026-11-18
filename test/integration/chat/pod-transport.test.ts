// While paired, every model call goes to the paired server with the device token and nothing reaches Mera's gateway.
import { cloudChatStream, transportServesJobs } from '@/lib/llm/cloudComplete';
import { POD_PAIRING_KEY } from '@/lib/own-services/keys';
import { ownAiState, type OwnAiConfig } from '@/lib/own-services/own-ai-state';
import { forgetPairing, podState, savePairing, type PodPairing } from '@/lib/own-services/pod-state';
import { attestationRequests, failSecureStore, fakePod, gatewayCalls, healSecureStore, http, HttpResponse, podPairing, POD_URL, server, signInFixtureAccount } from '@/test/helpers';
import { fakeClock, resetTransport, run } from '@/test/integration/chat/transport/transport-kit';

const TOKEN = 'pod-token-abcdef123456';
const pairing: PodPairing = podPairing({ token: TOKEN });
const ownAi: OwnAiConfig = { v: 1, baseUrl: 'https://ai.own.test/v1', model: 'own-model', key: 'own-ai-key-12345678', on: true, checkedAt: 1, status: 'connected', confirmed: { at: 1, privacyVersion: null } };
const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }], route: 'topics' as const, enableThinking: false };

const leg = async () => {
  let text = '';
  for await (const e of cloudChatStream(REQUEST)) text += JSON.stringify(e);
  return text;
};

let pod: ReturnType<typeof fakePod>;
let logs: jest.SpyInstance[];
beforeEach(async () => {
  await resetTransport({ signIn: false });
  ownAiState.resetMemory();
  podState.resetMemory();
  pod = fakePod({ token: TOKEN });
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  logs.forEach((s) => s.mockRestore());
  jest.useRealTimers();
});

const chatRequests = () => pod.requests.filter((r) => r.path === '/v1/chat/completions');

it('a paired chat leg reaches the paired server with the bearer and nothing of Mera is attached', async () => {
  await savePairing(pairing);
  expect(await leg()).toContain('Hello from the pod.');
  expect(chatRequests()).toHaveLength(1);
  const { headers } = chatRequests()[0];
  expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  for (const h of ['cookie', 'x-mera-client', 'x-api-key']) expect(headers[h]).toBeUndefined();
  expect(gatewayCalls()).toHaveLength(0);
  expect(attestationRequests()).toBe(0);
  expect(transportServesJobs()).toBe(false);
});

it('an own AI service that is also on loses to the pairing', async () => {
  let own = 0;
  server.use(http.post('https://ai.own.test/*', () => { own += 1; return HttpResponse.json({}); }));
  await ownAiState.save(ownAi);
  await savePairing(pairing);
  await leg();
  expect(chatRequests()).toHaveLength(1);
  expect(own).toBe(0);
  expect(gatewayCalls()).toHaveLength(0);
});

it('before the item is read, the leg waits and then lands at the paired server', async () => {
  await savePairing(pairing);
  podState.resetMemory();
  expect(podState.isHydrated()).toBe(false);
  await leg();
  expect(chatRequests()).toHaveLength(1);
  expect(gatewayCalls()).toHaveLength(0);
});

it('a throwing read fails the leg rather than reach the gateway, and lands at the paired server once healed', async () => {
  await savePairing(pairing);
  podState.resetMemory();
  failSecureStore(POD_PAIRING_KEY, 'get');
  await expect(leg()).rejects.toThrow();
  expect(gatewayCalls()).toHaveLength(0);
  expect(chatRequests()).toHaveLength(0);
  healSecureStore();
  await leg();
  expect(chatRequests()).toHaveLength(1);
});

it('after the pairing is removed the next leg reaches the gateway and the paired server gets nothing more', async () => {
  await savePairing(pairing);
  await leg();
  await forgetPairing();
  await signInFixtureAccount();
  fakeClock();
  await run(leg().catch(() => ''));
  expect(chatRequests()).toHaveLength(1);
  expect(gatewayCalls().length + attestationRequests()).toBeGreaterThan(0);
});

it('pairing again with the same address sends only the new token', async () => {
  const NEW = 'pod-token-fedcba654321';
  pod.tokens.add(NEW);
  await savePairing(pairing);
  await leg();
  await forgetPairing();
  await savePairing({ ...pairing, deviceId: 'device-2', token: NEW });
  await leg();
  expect(chatRequests().map((r) => r.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEW}`]);
});

it('a redirect from the paired server is refused, never followed, and the token goes nowhere else', async () => {
  let elsewhere = 0;
  let asked = 0;
  server.use(
    http.all('https://elsewhere.test/*', () => { elsewhere += 1; return HttpResponse.json({}); }),
    http.post(`${POD_URL}/v1/chat/completions`, () => { asked += 1; return new HttpResponse(null, { status: 302, headers: { location: 'https://elsewhere.test/v1/chat/completions' } }); }),
  );
  await savePairing(pairing);
  await expect(leg()).rejects.toThrow();
  // A refused redirect ends the call: the paired server is asked exactly once.
  expect(asked).toBe(1);
  expect(elsewhere).toBe(0);
});

it('a failing paired server leaves neither the token nor the address in the error, its fields or any log line', async () => {
  let asked = 0;
  server.use(http.post(`${POD_URL}/v1/chat/completions`, () => { asked += 1; return HttpResponse.json({ error: 'upstream_error' }, { status: 500 }); }));
  await savePairing(pairing);
  const err = (await leg().then(() => null, (e: unknown) => e)) as Error;
  expect(err).toBeTruthy();
  expect(asked).toBeGreaterThan(0);
  const everything = JSON.stringify({ ...err, message: err.message, name: err.name }) + logs.flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c)).join('\n');
  expect(everything).not.toContain(TOKEN);
  expect(everything).not.toContain('pod.own.test');
});
