// The connection check maps each answer to one status and never turns the mode on.
import { checkOwnAi } from '@/lib/own-services/check-ai';
import { ownAiOn, ownAiState } from '@/lib/own-services/own-ai-state';
import { http, HttpResponse, server } from '@/test/helpers';

const KEY = 'own-ai-key-12345678';
const check = (key: string | null = KEY) => checkOwnAi({ baseUrl: 'https://ai.own.test/v1', model: 'own-model', key });
const answer = (resolver: () => Response | Promise<Response>) => server.use(http.post('https://ai.own.test/v1/chat/completions', resolver));

it('connected: one request with the body, the bearer and no redirect following', async () => {
  const seen: { body: unknown; headers: Headers; redirect: string }[] = [];
  server.use(
    http.post('https://ai.own.test/v1/chat/completions', async ({ request }) => {
      seen.push({ body: await request.clone().json(), headers: request.headers, redirect: request.redirect });
      return HttpResponse.json({ choices: [{ message: { content: 'OK' } }] });
    }),
  );
  expect(await check()).toBe('connected');
  expect(seen).toHaveLength(1);
  expect(seen[0].body).toEqual({ model: 'own-model', messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1, stream: false });
  expect(seen[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(seen[0].headers.get('cookie')).toBeNull();
  expect(seen[0].redirect).toBe('manual');
});

it('no key sends no bearer', async () => {
  let auth: string | null = 'unset';
  answer(() => HttpResponse.json({ choices: [] }));
  server.use(http.post('https://ai.own.test/v1/chat/completions', ({ request }) => { auth = request.headers.get('authorization'); return HttpResponse.json({ choices: [] }); }));
  expect(await check(null)).toBe('connected');
  expect(auth).toBeNull();
});

const cases: [string, () => Response, string][] = [
  ['unreachable', () => HttpResponse.error(), 'unreachable'],
  ['redirect', () => new HttpResponse(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }), 'redirect'],
  ['refused 401', () => new HttpResponse('no', { status: 401 }), 'refused'],
  ['refused 403', () => new HttpResponse('no', { status: 403 }), 'refused'],
  ['no-model 404 by message', () => HttpResponse.json({ error: { message: 'The model does not exist' } }, { status: 404 }), 'no-model'],
  ['no-model 400 by code', () => HttpResponse.json({ error: { code: 'model_not_found' } }, { status: 400 }), 'no-model'],
  ['not-openai 404', () => HttpResponse.json({ detail: 'Not Found' }, { status: 404 }), 'not-openai'],
  ['busy', () => new HttpResponse('slow down', { status: 429 }), 'busy'],
  ['failing', () => new HttpResponse('boom', { status: 503 }), 'failing'],
  ['not-openai 200 without choices', () => HttpResponse.json({ ok: true }), 'not-openai'],
  ['not-openai 200 html', () => new HttpResponse('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'not-openai'],
];
it.each(cases)('%s', async (_n, reply, status) => {
  answer(reply);
  expect(await check()).toBe(status);
});

it('never turns the mode on, and logs nothing that holds the key or the address', async () => {
  await ownAiState.save({ v: 1, baseUrl: 'https://ai.own.test/v1', model: 'own-model', key: KEY, on: false, checkedAt: null, status: null, confirmed: null });
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
  answer(() => HttpResponse.json({ choices: [{}] }));
  expect(await check()).toBe('connected');
  answer(() => HttpResponse.error());
  expect(await check()).toBe('unreachable');
  const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
  spies.forEach((s) => s.mockRestore());
  expect(logged).not.toContain(KEY);
  expect(logged).not.toContain('ai.own.test');
  expect(ownAiOn()).toBe(false);
});
