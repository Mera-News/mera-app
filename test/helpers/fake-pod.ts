// A paired Mera News server at https://pod.own.test, served by MSW handlers with the real pod's wire behaviour.
import { HttpResponse, http } from 'msw';
import appSchema from '@/lib/database/schema';
import { COMMAND_REGISTRY_VERSION } from '@/lib/sync/command';
import { buildSnapshot, type Snapshot } from '@/lib/sync/snapshot';
import type { PodPairing } from '@/lib/own-services/pod-state';
import { resetDatabase } from './db';
import { server } from './msw';

export const POD_URL = 'https://pod.own.test';

/** An active, confirmed pairing with the fake pod, as the phone stores it once the erase has landed. */
export const podPairing = (over: Partial<PodPairing> = {}): PodPairing => ({
  v: 1,
  baseUrl: POD_URL,
  deviceId: 'device-1',
  token: 'pod-token-abcdef123456',
  podName: 'Home pod',
  pairedAt: 1,
  confirmed: { at: 1, privacyVersion: null },
  state: 'active',
  ...over,
});

export type FakePodRequest = { path: string; headers: Record<string, string>; body: any };
type PairingSetup = { code: string; closed?: boolean; alreadyPaired?: boolean };
type CommandAnswer = { ok: unknown } | { error: { code: string; message: string } };

export function fakePod(options: { pairing?: Partial<PairingSetup>; token?: string } = {}) {
  const pod = {
    pairing: { code: 'K7Q2M9XD', closed: false, alreadyPaired: false, ...options.pairing } as PairingSetup,
    versions: { schemaVersion: appSchema.version as number, registry: COMMAND_REGISTRY_VERSION as number },
    snapshot: { schemaVersion: appSchema.version, registry: COMMAND_REGISTRY_VERSION, tables: {} } as Snapshot,
    onCommand: ((_name: string, _args: unknown[]): CommandAnswer => ({ ok: null })) as (name: string, args: unknown[]) => CommandAnswer,
    requests: [] as FakePodRequest[],
    tokens: new Set<string>(options.token ? [options.token] : []),
    revoked: new Set<string>(),
    reading: 'on' as 'on' | 'paused',
    /** What /status says about wake-ups; undefined is an older server that does not say. */
    wakeups: undefined as undefined | 'on' | 'off' | 'disabled',
    relayOrigin: undefined as undefined | string,
    /** The pass the phone handed over with POST /ping, if any. */
    pass: null as null | { capability: string; expiresAt: number },
    chatReply: 'Hello from the pod.',
    /** Data per GraphQL operation name. */
    graphql: {} as Record<string, unknown>,
    operations: [] as string[],
    down() {
      isDown = true;
    },
    up() {
      isDown = false;
    },
    /** One-off override: the next request to `path` answers `status` and `body`. */
    answer(path: string, status: number, body?: unknown) {
      overrides.set(path, { status, body });
    },
  };
  let isDown = false;
  let issued = 0;
  let used = false;
  const tries: number[] = [];
  const overrides = new Map<string, { status: number; body?: unknown }>();

  const status = () => ({
    reading: pod.reading,
    podName: 'Home pod',
    ...pod.versions,
    ...(pod.wakeups ? { wakeups: pod.wakeups, relayOrigin: pod.relayOrigin } : {}),
  });
  const json = (body: unknown, init?: number) => HttpResponse.json(body as any, { status: init ?? 200 });
  const mismatch = () => json({ error: 'version_mismatch', message: 'The versions differ.' }, 409);
  const differs = (b: any) => b?.schemaVersion !== pod.versions.schemaVersion || (b?.registry !== undefined && b.registry !== pod.versions.registry);

  // A table whose hash the caller already holds comes back without rows.
  const answerFor = (hashes: Record<string, string> = {}): Snapshot => {
    const tables = Object.fromEntries(
      Object.entries(pod.snapshot.tables).map(([name, t]) => [name, hashes[name] === t.hash ? { hash: t.hash, mode: t.mode } : t]),
    );
    return { ...pod.snapshot, tables };
  };

  const route = (method: 'get' | 'post', path: string, auth: boolean, handle: (body: any, token?: string) => Response | Promise<Response>) =>
    http[method](`${POD_URL}${path}`, async ({ request }) => {
      const text = method === 'post' ? await request.text() : '';
      const body = text ? JSON.parse(text) : undefined;
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => (headers[k] = v));
      pod.requests.push({ path, headers, body });
      if (isDown) return HttpResponse.error();
      const o = overrides.get(path);
      if (o) {
        overrides.delete(path);
        return o.body === undefined ? new HttpResponse(null, { status: o.status }) : json(o.body, o.status);
      }
      const token = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
      if (auth && (!token || !pod.tokens.has(token) || pod.revoked.has(token))) return new HttpResponse(null, { status: 401 });
      return handle(body, token);
    });

  server.use(
    route('post', '/pair', false, (b) => {
      const now = Date.now();
      tries.push(now);
      if (pod.pairing.closed || used) return json({ error: 'pairing_closed' }, 403);
      if (tries.filter((t) => now - t < 60_000).length >= 6) return json({ error: 'too_many_tries' }, 429);
      if (b?.code !== pod.pairing.code) return json({ error: 'wrong_code' }, 403);
      // Only a caller that holds a valid code learns the server is taken.
      if (pod.pairing.alreadyPaired) return json({ error: 'already_paired' }, 409);
      used = true;
      const token = `pod-token-${(issued += 1)}-0123456789`;
      pod.tokens.add(token);
      return json({ deviceId: `device-${issued}`, token, podName: 'Home pod' });
    }),
    route('post', '/snapshot', true, (b) => (differs(b) ? mismatch() : json(answerFor(b.hashes)))),
    route('post', '/commands', true, (b) => {
      if (differs(b)) return mismatch();
      const results = (b.commands as { name: string; args: unknown[] }[]).map((c) => pod.onCommand(c.name, c.args));
      return json({ results, snapshot: answerFor(b.hashes) });
    }),
    route('get', '/status', true, () => json(status())),
    route('post', '/reading', true, (b) => {
      pod.reading = b?.paused ? 'paused' : 'on';
      return json(status());
    }),
    route('post', '/ping', true, (b) => {
      pod.pass = typeof b?.capability === 'string' ? { capability: b.capability, expiresAt: b.expiresAt } : null;
      if (pod.wakeups !== 'disabled') pod.wakeups = pod.pass ? 'on' : 'off';
      return json({});
    }),
    route('post', '/devices/revoke', true, (_b, token) => {
      pod.revoked.add(token!);
      return json({});
    }),
    route('post', '/graphql', true, (b) => {
      pod.operations.push(b?.operationName);
      return json(b?.operationName in pod.graphql ? { data: pod.graphql[b.operationName] } : { errors: [{ message: 'no answer set' }] });
    }),
    route('post', '/v1/chat/completions', true, () => {
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-pod', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const body = chunk({ role: 'assistant', content: pod.chatReply }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
      return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
  return pod;
}

/** Runs `seed` against the phone's database, takes the snapshot a pod would serve, and empties the database. */
export async function podSnapshotFrom(seed: () => Promise<void>): Promise<Snapshot> {
  await seed();
  const snapshot = await buildSnapshot({ hashes: {}, registry: COMMAND_REGISTRY_VERSION });
  await resetDatabase();
  return snapshot;
}

export type MintAnswer = { status: number; body?: unknown; headers?: Record<string, string> };

/** The auth host's pass route, `POST <auth>/api/auth/pod/ping-capability`: answers 200 with a fresh pass unless told otherwise. */
export function fakeMint(authOrigin: string) {
  const mint = {
    /** Each request's body and whether it carried a signed-in session cookie. */
    requests: [] as { body: any; session: boolean }[],
    /** Answers used once each, first in first out; then the default 200. */
    queue: [] as MintAnswer[],
    expiresInS: 14 * 24 * 3600,
    issued: [] as string[],
  };
  server.use(
    http.post(`${authOrigin}/api/auth/pod/ping-capability`, async ({ request }) => {
      // Signed in only, like the real route (better-auth's session middleware).
      const session = /better-auth\.session_token=/.test(request.headers.get('cookie') ?? '');
      mint.requests.push({ body: await request.json().catch(() => null), session });
      if (!session) return HttpResponse.json({}, { status: 401 });
      const next = mint.queue.shift();
      if (next) return HttpResponse.json((next.body ?? {}) as any, { status: next.status, headers: next.headers });
      const capability = `mp1.k1.pass-${mint.issued.length + 1}`;
      mint.issued.push(capability);
      return HttpResponse.json({ capability, expiresAt: Math.floor(Date.now() / 1000) + mint.expiresInS });
    }),
  );
  return mint;
}
