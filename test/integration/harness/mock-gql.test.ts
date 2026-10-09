// mockGql awaits an async responder, so a test can compute or hold a response.
import { mockGql, server } from '@/test/helpers';

const post = (operationName: string) =>
  fetch('http://127.0.0.1:8790/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName, query: `query ${operationName} { x }`, variables: { n: 2 } }),
  }).then((r) => r.json());

it('a sync responder answers', async () => {
  server.use(mockGql('ProbeSync', { x: 1 }));
  expect(await post('ProbeSync')).toEqual({ data: { x: 1 } });
});

it('an async responder is awaited, with the variables', async () => {
  server.use(
    mockGql('ProbeAsync', async (v: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 10));
      return { x: (v.n as number) * 10 };
    }),
  );
  expect(await post('ProbeAsync')).toEqual({ data: { x: 20 } });
});
