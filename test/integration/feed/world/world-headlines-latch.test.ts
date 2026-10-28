// The World topic filter's old-server fallback: a server without `worldHeadlines` answers
// GRAPHQL_VALIDATION_FAILED once, the session latches, and the list keeps working off the
// current windowed country document with topics hidden.
import { mockGqlError, renderHookInScreen, server } from '@/test/helpers';
import { waitFor } from '@testing-library/react-native';
import { useScopeArticleList } from '@/components/custom/explore/useScopeArticleList';
import { __resetExploreWindowSupport, __resetWorldTopicsSupport } from '@/lib/article-service';
import type { ExploreScope } from '@/lib/explore/scopes';
import { graphql } from '@/test/helpers';

const WORLD: ExploreScope = { id: 'world', kind: 'world', label: '', icon: 'public', countryCodeAlpha3: null };

function record(...ops: string[]) {
  const sent: { op: string; vars: Record<string, any> }[] = [];
  server.use(
    graphql.operation(({ operationName, variables }) => {
      if (ops.includes(operationName)) sent.push({ op: operationName, vars: variables });
      return undefined;
    }),
  );
  return sent;
}

const render = (topicId?: string) =>
  renderHookInScreen(() => useScopeArticleList({ scope: WORLD, enabled: true, windowHours: 12, topicId }));

beforeEach(() => {
  __resetExploreWindowSupport();
  __resetWorldTopicsSupport();
  server.use(mockGqlError('GetWorldHeadlines', 'GRAPHQL_VALIDATION_FAILED', { message: 'Cannot query field "worldHeadlines"' }));
});

it('falls back to the windowed country document, keeps the list and reports topicsSupported false', async () => {
  const sent = record('GetWorldHeadlines', 'GetTopHeadlinesForCountryWindowed');
  const { result } = render();
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(sent.map((s) => s.op)).toEqual(['GetWorldHeadlines', 'GetTopHeadlinesForCountryWindowed']);
  expect(sent[1].vars.windowHours).toBe(12);
  expect(result.current.headlines).toHaveLength(10);
  expect(result.current.loadFailed).toBe(false);
  expect(result.current.topicsSupported).toBe(false);
  expect(result.current.facets).toEqual([]);
});

it('latches for the session: a later load never asks for worldHeadlines again', async () => {
  const first = render();
  await waitFor(() => expect(first.result.current.isLoading).toBe(false));
  const sent = record('GetWorldHeadlines', 'GetTopHeadlinesForCountryWindowed');
  const second = render('ct-politics');
  await waitFor(() => expect(second.result.current.isLoading).toBe(false));
  expect(sent.map((s) => s.op)).toEqual(['GetTopHeadlinesForCountryWindowed']);
  expect(second.result.current.headlines).toHaveLength(10);
  expect(second.result.current.topicsSupported).toBe(false);
});

it('any other error is a failed load, not a latch', async () => {
  server.use(mockGqlError('GetWorldHeadlines', 'INTERNAL_SERVER_ERROR'));
  const sent = record('GetTopHeadlinesForCountryWindowed');
  const { result } = render();
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.loadFailed).toBe(true);
  expect(sent).toHaveLength(0);
});
