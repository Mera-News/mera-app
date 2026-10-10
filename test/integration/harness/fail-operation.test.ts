// The scenario's failOperation: one GraphQL operation answers with a GraphQL error, every other op
// keeps its data. The device flow .maestro/dev/feed-sync-failure.yaml relies on exactly this.
import { setScenario } from '@/test/helpers';

const ask = async (op: string, field: string) => {
  const res = await fetch('http://127.0.0.1:8790/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: op, query: `query ${op} { ${field} { subscriptionTier } }` }),
  });
  return (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] };
};

it('fails only the named operation, with a GraphQL error', async () => {
  setScenario({ failOperation: 'GetUserBilling' });
  const failed = await ask('GetUserBilling', 'userBilling');
  expect(failed.data).toBeUndefined();
  expect(failed.errors?.[0].message).toContain('GetUserBilling failed');

  const other = await ask('GetUserBillingLapseState', 'userBilling');
  expect(other.errors).toBeUndefined();
  expect(other.data?.userBilling).toEqual(expect.objectContaining({ subscriptionTier: 'starter' }));
});

it('answers normally once the flag is cleared', async () => {
  setScenario({ failOperation: null });
  expect((await ask('GetUserBilling', 'userBilling')).data?.userBilling).toBeTruthy();
});
