// Guard: no module may capture fetch before MSW patches it. better-auth binds globalThis.fetch
// when lib/auth-client.ts is imported; the import below is static, so it runs before any test
// body. If MSW were not yet listening, getSession() would go to the real network (ECONNREFUSED
// on loopback) and MSW would see nothing, so the recorded list would stay empty.
import { authClient } from '@/lib/auth-client';
import { server } from '@/test/helpers';

describe('fetch capture', () => {
  it('a statically imported auth client reaches MSW', async () => {
    const seen: string[] = [];
    const onStart = ({ request }: { request: Request }) => seen.push(new URL(request.url).pathname);
    server.events.on('request:start', onStart);
    try {
      await authClient.getSession();
    } finally {
      server.events.removeListener('request:start', onStart);
    }
    expect(seen).toContain('/api/auth/get-session');
  });
});
