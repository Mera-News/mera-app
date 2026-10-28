// An article the server no longer holds answers every fact-check operation NOT_FOUND. That is an
// answer, not a failure: the reader is told, the ask is dropped so nothing re-asks it, and nothing
// reaches Sentry (MERA-APP-11 / 8E: one device re-asked one deleted article 2,260 times).
import logger from '@/lib/logger';
import {
  reconcileAskedFactChecks,
  requestFactCheck,
  requestFactCheckAgain,
} from '@/lib/fact-check/fact-check-graphql-client';
import { recordFactCheckAsked } from '@/lib/fact-check/fact-check-settled';
import { mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { askedIds } from './kit';

const gone = (op: string) =>
  mockGqlError(op, 'NOT_FOUND', { message: 'Article not found: a1', statusCode: 404 });

let captures: jest.SpyInstance;
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  captures = jest.spyOn(logger, 'captureException');
});
afterEach(() => {
  captures.mockRestore();
  resetChatModules();
});

it('Fact check again on a deleted article says it is gone and drops the ask', async () => {
  server.use(gone('RequestFactCheckAgain'));
  expect(await requestFactCheckAgain('a1', 'Title')).toBe('gone');
  expect(await askedIds()).not.toContain('a1');
  expect(captures).not.toHaveBeenCalled();
});

it('the panel poll stops on a deleted article: terminal, ask dropped, no Sentry', async () => {
  server.use(gone('GetFactCheck'));
  const outcome = await requestFactCheck('a1', 'Title', undefined, true);
  expect(outcome).toEqual({ terminal: true, row: null });
  expect(await askedIds()).not.toContain('a1');
  expect(captures).not.toHaveBeenCalled();
});

it('the return-to-app re-read drops a deleted article instead of waiting on it', async () => {
  server.use(gone('RequestFactCheckAgain'), gone('GetCachedFactCheck'));
  // An ask recorded by an earlier session, whose article has since gone.
  await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: 'Title' });
  expect(await reconcileAskedFactChecks()).toBe(0);
  expect(await askedIds()).not.toContain('a1');
  expect(captures).not.toHaveBeenCalled();
});
