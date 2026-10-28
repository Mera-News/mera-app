// A bundle ahead of its server: the fact-check documents select `recheckAvailableAt`, and a server
// deployed before it rejects the whole document (GRAPHQL_VALIDATION_FAILED). The client falls back
// to the legacy documents once, stays on them for the session, and offers no recheck call.
import {
  requestFactCheck,
  requestFactCheckAgain,
} from '@/lib/fact-check/fact-check-graphql-client';
import { mockGql, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { checkRow, storedFor } from './kit';

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});
afterEach(() => resetChatModules());

it('reads through the legacy document after a validation failure, and asks no recheck', async () => {
  const ops: string[] = [];
  server.events.on('request:start', async ({ request }) => {
    const body = (await request.clone().json().catch(() => null)) as { operationName?: string } | null;
    if (body?.operationName) ops.push(body.operationName);
  });
  server.use(
    mockGqlError('GetFactCheck', 'GRAPHQL_VALIDATION_FAILED', { httpStatus: 400 }),
    mockGql('GetFactCheckLegacy', { factCheck: checkRow() }),
    mockGqlError('RequestFactCheckAgain', 'GRAPHQL_VALIDATION_FAILED', { httpStatus: 400 }),
  );

  const first = await requestFactCheck('a1', 'Title', undefined, true);
  expect(first.terminal).toBe(true);
  expect((await storedFor('a1'))[0]).toMatchObject({ status: 'complete' });

  await requestFactCheck('a2', 'Title', undefined, true);
  expect(await requestFactCheckAgain('a1', 'Title')).toBe('not-asked');

  const fetchOps = ops.filter((o) => o.startsWith('GetFactCheck') || o === 'RequestFactCheckAgain');
  expect(fetchOps).toEqual(['GetFactCheck', 'GetFactCheckLegacy', 'GetFactCheckLegacy']);
});

it('asks for a recheck on a server that has the option', async () => {
  const asked: unknown[] = [];
  server.use(
    mockGql('RequestFactCheckAgain', (v) => {
      asked.push(v);
      return { requestFactCheck: checkRow({ status: 'pending' }) };
    }),
  );
  expect(await requestFactCheckAgain('a1', 'Title')).toBe('asked');
  expect(asked).toEqual([{ articleId: 'a1' }]);
  expect((await storedFor('a1'))[0]).toMatchObject({ status: 'pending' });
});
