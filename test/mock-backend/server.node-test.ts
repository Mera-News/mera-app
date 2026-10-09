// Run: npx tsx --test test/mock-backend/server.node-test.ts
// Raw node:http / node:net clients on purpose: nothing here may go through MSW interception.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { graphql, http as mswHttp, HttpResponse } from 'msw';
import { getScenario, resetScenario } from './scenario';
import { startMockServer } from './server';

const logFile = path.join(mkdtempSync(path.join(tmpdir(), 'mock-backend-')), 'log.jsonl');
const readLog = () =>
    readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

let releaseSecond!: () => void;
const firstChunkRead = new Promise<void>((r) => (releaseSecond = r));
const enc = new TextEncoder();

let srv: Awaited<ReturnType<typeof startMockServer>>;
before(async () => {
    srv = await startMockServer({
        port: 0,
        logFile,
        handlers: [
            mswHttp.get('*/sse', () =>
                new HttpResponse(
                    new ReadableStream({
                        async start(c) {
                            c.enqueue(enc.encode('data: 1\n\n'));
                            await firstChunkRead;
                            c.enqueue(enc.encode('data: 2\n\n'));
                            c.close();
                        },
                    }),
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
            ),
            mswHttp.get('*/x', () => HttpResponse.text('hit-x')),
            mswHttp.get('*/tunnel', () => HttpResponse.text('hit-tunnel')),
            mswHttp.get('*/cookies', () => {
                const h = new Headers();
                h.append('set-cookie', 'a=1; Path=/');
                h.append('set-cookie', 'b=2; Path=/');
                return new HttpResponse('ok', { headers: h });
            }),
            graphql.query('Known', () => HttpResponse.json({ data: { ok: true } })),
        ],
    });
});
after(async () => {
    await srv.close();
    resetScenario();
});

function request(opts: http.RequestOptions, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: string[]; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, ...opts }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, raw: res.rawHeaders, body: data }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function rawSocket(send: string, until: (s: string) => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
        const s = net.connect(srv.port, '127.0.0.1', () => s.write(send));
        let buf = '';
        s.on('data', (d) => {
            buf += d;
            if (until(buf)) resolve(buf), s.destroy();
        });
        s.on('close', () => resolve(buf));
        s.on('error', reject);
    });
}

test('SSE chunks stream incrementally', async () => {
    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: srv.port, path: '/sse' }, (res) => {
            res.on('data', (c) => {
                seen.push(String(c));
                if (seen.length === 1) releaseSecond();
            });
            res.on('end', resolve);
        }).on('error', reject);
    });
    assert.deepEqual(seen, ['data: 1\n\n', 'data: 2\n\n']);
});

test('CONNECT to a foreign host is refused and logged', async () => {
    const out = await rawSocket('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n', (s) => s.includes('\r\n\r\n'));
    assert.match(out, /^HTTP\/1\.1 403 Forbidden/);
    assert.ok(readLog().some((l) => l.kind === 'connect' && l.host === 'example.com:443' && l.status === 403));
});

test('CONNECT to 10.0.2.2:P tunnels to a handler', async () => {
    const full = await new Promise<string>((resolve, reject) => {
        const s = net.connect(srv.port, '127.0.0.1', () =>
            s.write(`CONNECT 10.0.2.2:${srv.port} HTTP/1.1\r\nHost: 10.0.2.2:${srv.port}\r\n\r\n`),
        );
        let buf = '';
        let sent = false;
        s.on('data', (d) => {
            buf += d;
            if (!sent && buf.includes('\r\n\r\n')) {
                sent = true;
                s.write(`GET /tunnel HTTP/1.1\r\nHost: 10.0.2.2:${srv.port}\r\nConnection: close\r\n\r\n`);
            }
        });
        s.on('close', () => resolve(buf));
        s.on('error', reject);
    });
    assert.match(full, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(full, /hit-tunnel/);
});

test('absolute-form: own host served, foreign host refused and logged', async () => {
    const ok = await request({ path: `http://10.0.2.2:${srv.port}/x`, headers: { host: `10.0.2.2:${srv.port}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'hit-x');
    const bad = await request({ path: 'http://evil.test/', headers: { host: 'evil.test' } });
    assert.equal(bad.status, 403);
    assert.ok(readLog().some((l) => l.host === 'evil.test' && l.status === 403 && l.via === 'proxy'));
});

test('control routes: loopback host changes the scenario, device host is refused', async () => {
    const post = (host: string) =>
        request({ method: 'POST', path: '/__control/scenario', headers: { host, 'content-type': 'application/json' } }, '{"tier":"none"}');
    const bad = await post(`10.0.2.2:${srv.port}`);
    assert.equal(bad.status, 403);
    assert.equal(getScenario().tier, 'starter');
    const ok = await post(`localhost:${srv.port}`);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).tier, 'none');
    assert.equal(getScenario().tier, 'none');
    resetScenario();
    assert.equal(getScenario().tier, 'starter');
});

test('unhandled GraphQL operation answers E2E_UNHANDLED and logs the op', async () => {
    const res = await request(
        { method: 'POST', path: '/graphql', headers: { host: `10.0.2.2:${srv.port}`, 'content-type': 'application/json' } },
        JSON.stringify({ operationName: 'Foo', query: 'query Foo { foo }' }),
    );
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).errors[0].extensions.code, 'E2E_UNHANDLED');
    assert.ok(readLog().some((l) => l.kind === 'unhandled-gql' && l.op === 'Foo'));
});

test('multiple Set-Cookie headers both reach the client', async () => {
    const res = await request({ path: '/cookies' });
    assert.deepEqual(res.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
});
