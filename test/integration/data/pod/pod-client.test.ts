import appSchema from '@/lib/database/schema';
import { COMMAND_REGISTRY_VERSION } from '@/lib/sync/command';
import { PodError, pairWithCode, pull, resolveVersion, revoke, send, setReading, status } from '@/lib/own-services/pod-client';
import { recordPodError, recordPodOk, resetPodHealth, usePodHealth } from '@/lib/own-services/pod-health';
import type { PodPairing } from '@/lib/own-services/pod-state';
import { advanceUntilDone, delay, fakePod, http, HttpResponse, POD_URL, server, useFakeClock } from '@/test/helpers';

const TOKEN = 'pod-token-abcdef123456';
const cfg: PodPairing = {
  v: 1, baseUrl: POD_URL, deviceId: 'device-1', token: TOKEN, podName: 'Home pod', pairedAt: 1,
  confirmed: { at: 1, privacyVersion: null }, state: 'active',
};
const local = { schemaVersion: appSchema.version, registry: COMMAND_REGISTRY_VERSION };
const request = { ...local, hashes: {} as Record<string, string> };
const table = (hash: string) => ({ hash, mode: 'replace' as const, rows: [{ id: 'r1' }] });

const fail = async (p: Promise<unknown>): Promise<PodError> => {
  try {
    await p;
  } catch (e) {
    return e as PodError;
  }
  throw new Error('expected the call to fail');
};

let logs: jest.SpyInstance[];
beforeEach(() => {
  resetPodHealth();
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  logs.forEach((s) => s.mockRestore());
  jest.useRealTimers();
});

describe('pairing', () => {
  it('trims and upper-cases the code, sends only the code and the device name, and no Authorization', async () => {
    const pod = fakePod();
    const answer = await pairWithCode(POD_URL, ' k7q2m9xd ', 'My phone');
    expect(Object.keys(answer).sort()).toEqual(['deviceId', 'podName', 'token']);
    expect(answer.podName).toBe('Home pod');
    expect(pod.tokens.has(answer.token)).toBe(true);
    expect(pod.requests).toHaveLength(1);
    expect(pod.requests[0].body).toEqual({ code: 'K7Q2M9XD', deviceName: 'My phone' });
    expect(pod.requests[0].headers.authorization).toBeUndefined();
  });

  it('a wrong code is wrong_code', async () => {
    fakePod();
    expect((await fail(pairWithCode(POD_URL, 'NOPE0000', 'p'))).code).toBe('wrong_code');
  });

  it('a closed pairing is pairing_closed, and a used code is dead', async () => {
    fakePod({ pairing: { closed: true } });
    expect((await fail(pairWithCode(POD_URL, 'K7Q2M9XD', 'p'))).code).toBe('pairing_closed');
    fakePod();
    await pairWithCode(POD_URL, 'K7Q2M9XD', 'p');
    expect((await fail(pairWithCode(POD_URL, 'K7Q2M9XD', 'p'))).code).toBe('pairing_closed');
  });

  it('a taken server is already_paired, read from the body, and only after a valid code', async () => {
    const pod = fakePod({ pairing: { alreadyPaired: true } });
    expect((await fail(pairWithCode(POD_URL, 'NOPE0000', 'p'))).code).toBe('wrong_code');
    expect((await fail(pairWithCode(POD_URL, 'K7Q2M9XD', 'p'))).code).toBe('already_paired');
    expect(pod.tokens.size).toBe(0);
  });

  it('any other 409 on pairing is version', async () => {
    const pod = fakePod();
    pod.answer('/pair', 409, { error: 'version_mismatch' });
    expect((await fail(pairWithCode(POD_URL, 'K7Q2M9XD', 'p'))).code).toBe('version');
    pod.answer('/pair', 409);
    expect((await fail(pairWithCode(POD_URL, 'K7Q2M9XD', 'p'))).code).toBe('version');
  });

  it('the sixth try in a minute is too_many_tries', async () => {
    fakePod();
    for (let i = 0; i < 5; i++) expect((await fail(pairWithCode(POD_URL, 'NOPE0000', 'p'))).code).toBe('wrong_code');
    expect((await fail(pairWithCode(POD_URL, 'K7Q2M9XD', 'p'))).code).toBe('too_many_tries');
  });

  it('an unknown error code on a 403 is failed', async () => {
    const pod = fakePod();
    pod.answer('/pair', 403, { error: 'something_new' });
    expect((await fail(pairWithCode(POD_URL, 'K7Q2M9XD', 'p'))).code).toBe('failed');
  });

  it.each(['http://pod.own.test', 'https://me:pw@pod.own.test', 'pod.own.test'])('never sends to %s', async (baseUrl) => {
    const pod = fakePod();
    expect((await fail(pairWithCode(baseUrl, 'K7Q2M9XD', 'p'))).code).toBe('failed');
    expect(pod.requests).toHaveLength(0);
    expect((await fail(status({ ...cfg, baseUrl }))).code).toBe('failed');
    expect(pod.requests).toHaveLength(0);
  });
});

describe('answers map to one result each', () => {
  it('a revoked or unknown token is refused', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.revoked.add(TOKEN);
    expect((await fail(pull(cfg, request))).code).toBe('refused');
    expect((await fail(status({ ...cfg, token: 'someone-elses-token-1' }))).code).toBe('refused');
  });

  it('a different version is version, and a 5xx or an unknown status is failed', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.versions.registry += 1;
    expect((await fail(pull(cfg, request))).code).toBe('version');
    expect((await fail(send(cfg, [{ name: 'x', args: [] }], request))).code).toBe('version');
    pod.versions.registry -= 1;
    pod.answer('/snapshot', 500);
    expect((await fail(pull(cfg, request))).code).toBe('failed');
    pod.answer('/snapshot', 418, { error: 'teapot' });
    expect((await fail(pull(cfg, request))).code).toBe('failed');
  });

  it('a pod that is down is unreachable, then answers again after up()', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.down();
    expect((await fail(status(cfg))).code).toBe('unreachable');
    pod.up();
    expect((await status(cfg)).podName).toBe('Home pod');
  });

  it('a redirect is not followed and counts as unreachable', async () => {
    fakePod({ token: TOKEN });
    let followed = 0;
    server.use(
      http.post(`${POD_URL}/snapshot`, () => new HttpResponse(null, { status: 302, headers: { location: 'https://elsewhere.own.test/x' } })),
      http.all('https://elsewhere.own.test/*', () => {
        followed += 1;
        return HttpResponse.json({});
      }),
    );
    expect((await fail(pull(cfg, request))).code).toBe('unreachable');
    expect(followed).toBe(0);
  });

  it('a call that never answers is unreachable after its time limit', async () => {
    fakePod({ token: TOKEN });
    server.use(http.post(`${POD_URL}/snapshot`, () => delay('infinite')), http.get(`${POD_URL}/status`, () => delay('infinite')));
    useFakeClock('2026-01-01T00:00:00Z');
    const slow = fail(pull(cfg, request));
    await jest.advanceTimersByTimeAsync(29_000);
    let settled = false;
    slow.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1_500);
    expect((await slow).code).toBe('unreachable');
    const shortCall = fail(status(cfg));
    await jest.advanceTimersByTimeAsync(15_500);
    expect((await shortCall).code).toBe('unreachable');
  });
});

describe('what a request carries', () => {
  it('has the bearer token and no cookie, client header or api key, on every route', async () => {
    const pod = fakePod({ token: TOKEN });
    await pull(cfg, request);
    await send(cfg, [], request);
    await status(cfg);
    await setReading(cfg, false);
    await revoke(cfg);
    expect(pod.requests.map((r) => r.path)).toEqual(['/snapshot', '/commands', '/status', '/reading', '/devices/revoke']);
    for (const r of pod.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      for (const h of ['cookie', 'x-mera-client', 'x-api-key']) expect(r.headers[h]).toBeUndefined();
    }
  });

  it('puts the request and its hashes in the body', async () => {
    const pod = fakePod({ token: TOKEN });
    await send(cfg, [{ name: 'markRead', args: [1] }], { ...request, hashes: { a: 'h' } });
    expect(pod.requests[0].body).toEqual({ ...local, hashes: { a: 'h' }, commands: [{ name: 'markRead', args: [1] }] });
  });
});

describe('snapshots and commands', () => {
  it('pull answers the snapshot, leaving rows out for a table whose hash the phone holds', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.snapshot = { ...pod.snapshot, tables: { a: table('h1'), b: table('h2') } };
    const snap = await pull(cfg, { ...request, hashes: { a: 'h1', b: 'old' } });
    expect(snap.tables.a.rows).toBeUndefined();
    expect(snap.tables.a.hash).toBe('h1');
    expect(snap.tables.b.rows).toEqual([{ id: 'r1' }]);
  });

  it('send answers one result per command and the snapshot with it', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.snapshot = { ...pod.snapshot, tables: { a: table('h1') } };
    pod.onCommand = (name) => (name === 'bad' ? { error: { code: 'nope', message: 'no' } } : { ok: name });
    const out = await send(cfg, [{ name: 'good', args: [] }, { name: 'bad', args: [] }], request);
    expect(out.results).toEqual([{ ok: 'good' }, { error: { code: 'nope', message: 'no' } }]);
    expect(out.snapshot?.tables.a.rows).toHaveLength(1);
  });
});

describe('status, reading and revoke', () => {
  it('setReading pauses the pod and the next status agrees', async () => {
    fakePod({ token: TOKEN });
    expect((await status(cfg)).reading).toBe('on');
    expect((await setReading(cfg, true)).reading).toBe('paused');
    expect((await status(cfg)).reading).toBe('paused');
    expect((await setReading(cfg, false)).reading).toBe('on');
  });

  it('revoke removes the device, so its token is refused afterwards', async () => {
    const pod = fakePod({ token: TOKEN });
    await revoke(cfg);
    expect(pod.revoked.has(TOKEN)).toBe(true);
    expect((await fail(status(cfg))).code).toBe('refused');
  });

  it('revoke against a pod that is down, or that never answers, resolves within 5 seconds', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.down();
    await expect(revoke(cfg)).resolves.toBeUndefined();
    pod.up();
    server.use(http.post(`${POD_URL}/devices/revoke`, () => delay('infinite')));
    useFakeClock('2026-01-01T00:00:00Z');
    let done = false;
    const p = revoke(cfg).then(() => (done = true));
    await jest.advanceTimersByTimeAsync(4_900);
    expect(done).toBe(false);
    await advanceUntilDone(p, 1_000);
    expect(done).toBe(true);
  });
});

describe('resolveVersion', () => {
  it('phone-old when the pod runs a newer schema, server-old when it runs an older one', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.versions.schemaVersion = local.schemaVersion + 1;
    expect(await resolveVersion(cfg, local)).toBe('phone-old');
    pod.versions.schemaVersion = local.schemaVersion - 1;
    expect(await resolveVersion(cfg, local)).toBe('server-old');
    pod.versions = { ...local, registry: local.registry + 1 };
    expect(await resolveVersion(cfg, local)).toBe('phone-old');
  });

  it('failed when the versions match, unreachable when status fails', async () => {
    const pod = fakePod({ token: TOKEN });
    expect(await resolveVersion(cfg, local)).toBe('failed');
    pod.down();
    expect(await resolveVersion(cfg, local)).toBe('unreachable');
  });
});

describe('secrets stay out of errors and logs', () => {
  it('no thrown error carries the token, the code or the address, and nothing is logged', async () => {
    const pod = fakePod({ token: TOKEN });
    const errors: PodError[] = [];
    errors.push(await fail(pairWithCode(POD_URL, 'WRONG123', 'p')));
    pod.revoked.add(TOKEN);
    errors.push(await fail(pull(cfg, request)));
    pod.revoked.clear();
    pod.down();
    errors.push(await fail(send(cfg, [], request)));
    pod.up();
    pod.answer('/snapshot', 500);
    errors.push(await fail(pull(cfg, request)));
    errors.push(await fail(pairWithCode('http://pod.own.test', 'WRONG123', 'p')));
    for (const e of errors) {
      expect(e).toBeInstanceOf(PodError);
      expect(e.ownServer).toBe(true);
      expect(e.cause).toBeUndefined();
      const dump = JSON.stringify([e.message, e.stack, Object.getOwnPropertyNames(e).map((k) => (e as any)[k])]);
      for (const secret of [TOKEN, 'WRONG123', 'pod.own.test']) expect(dump).not.toContain(secret);
    }
    // The database logs its own lines; only a secret in any line matters here.
    const logged = JSON.stringify(logs.flatMap((s) => s.mock.calls));
    for (const secret of [TOKEN, 'WRONG123', 'pod.own.test']) expect(logged).not.toContain(secret);
  });
});

describe('health', () => {
  it('maps each error code and leaves it alone for failed', () => {
    const cases: [ConstructorParameters<typeof PodError>[0], string][] = [
      ['unreachable', 'unreachable'],
      ['refused', 'refused'],
      ['phone-old', 'phone-old'],
      ['server-old', 'server-old'],
    ];
    for (const [code, health] of cases) {
      recordPodError(new PodError(code));
      expect(usePodHealth.getState().health).toBe(health);
    }
    recordPodError(new PodError('failed'));
    expect(usePodHealth.getState().health).toBe('server-old');
    recordPodOk();
    expect(usePodHealth.getState().health).toBe('ok');
    resetPodHealth();
    expect(usePodHealth.getState().health).toBeNull();
  });
});
