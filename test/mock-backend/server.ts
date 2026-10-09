// node:http host for Maestro: an origin server plus a forward proxy over the MSW
// handlers. The app reaches it as 10.0.2.2:P (direct, absolute-form or CONNECT).
// Only the host's own addresses are served; any other target is refused and logged.
import { getResponse, type RequestHandler } from 'msw';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { getScenario, resetScenario, setScenario } from './scenario';

type Kind = 'connect' | 'http' | 'unhandled' | 'unhandled-gql';

export async function startMockServer(opts: {
    port: number;
    handlers: RequestHandler[];
    logFile?: string;
    /** Hold refused proxy connections open this long, so the e2e lane's 1 s app-socket
     *  sampler sees them (scripts/e2e-android.sh step 7). */
    denyDelayMs?: number;
}): Promise<{ port: number; close(): Promise<void> }> {
    const denyDelay = opts.denyDelayMs ?? 0;
    let SELF = new Set<string>();
    const log = (
        kind: Kind,
        e: { host: string; method: string; path: string; status: number; via: 'proxy' | 'direct'; op?: string },
    ) => {
        if (!opts.logFile) return;
        appendFileSync(opts.logFile, JSON.stringify({ ts: new Date().toISOString(), kind, ...e }) + '\n');
    };

    const sockets = new Set<net.Socket>();
    const server = http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        let host = req.headers.host ?? '';
        let path = req.url ?? '/';
        let via: 'proxy' | 'direct' = 'direct';
        if (/^https?:\/\//i.test(path)) {
            via = 'proxy';
            const u = new URL(path);
            host = u.host;
            path = u.pathname + u.search;
            if (!SELF.has(host)) {
                log('http', { host, method, path, status: 403, via });
                setTimeout(() => {
                    res.writeHead(403, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'forbidden', host }));
                }, denyDelay);
                return;
            }
        }
        const pathname = path.split('?')[0];
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        if (pathname.startsWith('/__control/')) {
            const loopback = host === `localhost:${boundPort}` || host === `127.0.0.1:${boundPort}`;
            if (via !== 'direct' || !loopback) {
                log('http', { host, method, path, status: 403, via });
                return send(403, { error: 'forbidden' });
            }
            if (pathname === '/__control/health' && method === 'GET') return send(200, { ok: true });
            if (pathname === '/__control/reset' && method === 'POST') {
                resetScenario();
                return send(200, getScenario());
            }
            if (pathname === '/__control/scenario' && method === 'POST') {
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                try {
                    setScenario(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
                } catch {
                    return send(400, { error: 'bad json' });
                }
                return send(200, getScenario());
            }
            return send(404, { error: 'not found' });
        }

        try {
            const hasBody = method !== 'GET' && method !== 'HEAD';
            const request = new Request(`http://${host}${path}`, {
                method,
                headers: req.headers as Record<string, string>,
                body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
                duplex: 'half',
            } as RequestInit);
            const clone = request.clone();
            const response = await getResponse(opts.handlers, request);

            if (!response) {
                if (pathname.endsWith('/graphql')) {
                    let op = '';
                    try {
                        op = (await clone.json()).operationName ?? '';
                    } catch {
                        /* not JSON: log an empty op */
                    }
                    log('unhandled-gql', { host, method, path, status: 200, via, op });
                    return send(200, {
                        errors: [
                            {
                                message: `E2E mock: unhandled operation ${op}`,
                                extensions: { code: 'E2E_UNHANDLED' },
                            },
                        ],
                    });
                }
                log('unhandled', { host, method, path, status: 501, via });
                return send(501, { error: 'unhandled', method, path });
            }

            const headers: Record<string, string | string[]> = {};
            response.headers.forEach((v, k) => {
                if (k !== 'set-cookie') headers[k] = v;
            });
            const cookies = response.headers.getSetCookie();
            if (cookies.length) headers['set-cookie'] = cookies;
            log('http', { host, method, path, status: response.status, via });
            res.writeHead(response.status, headers);
            res.flushHeaders();
            if (response.body) {
                let closed = false;
                res.on('close', () => (closed = true));
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                    if (closed) break;
                    res.write(chunk);
                }
            }
            res.end();
        } catch (err) {
            log('http', { host, method, path, status: 500, via });
            if (!res.headersSent) send(500, { error: String(err) });
            else res.destroy();
        }
    });

    server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });

    server.on('connect', (req, client) => {
        const target = req.url ?? '';
        const ok = SELF.has(target);
        log('connect', { host: target, method: 'CONNECT', path: '', status: ok ? 200 : 403, via: 'proxy' });
        if (!ok) {
            setTimeout(() => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'), denyDelay);
            return;
        }
        const upstream = net.connect(boundPort, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            client.pipe(upstream);
            upstream.pipe(client);
        });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });

    let boundPort = 0;
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, () => resolve());
    });
    boundPort = (server.address() as net.AddressInfo).port;
    SELF = new Set([`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `10.0.2.2:${boundPort}`]);

    return {
        port: boundPort,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
                sockets.forEach((s) => s.destroy());
            }),
    };
}

// CLI: npx tsx test/mock-backend/server.ts --port 8790 --log x.jsonl --handlers ./stub-handlers
if (/server\.ts$/.test(process.argv[1] ?? '')) {
    const arg = (name: string, dflt?: string) => {
        const i = process.argv.indexOf(`--${name}`);
        return i > 0 ? process.argv[i + 1] : dflt;
    };
    (async () => {
        const path = await import('node:path');
        const target = path.resolve(__dirname, arg('handlers', './stub-handlers')!);
        const mod = await import(target);
        const handlers: RequestHandler[] = mod.handlers ?? mod.default?.handlers;
        const { port, close } = await startMockServer({
            port: Number(arg('port', '8790')),
            handlers,
            logFile: arg('log'),
            denyDelayMs: Number(arg('deny-delay', '0')),
        });
        console.log(`mock-backend listening on ${port}`);
        const stop = () => close().then(() => process.exit(0));
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
    })();
}
