// Shared by the GraphQL service seam tests in this folder: the real Apollo client talks to MSW,
// and these helpers script one operation and read back what the service sent. Not a test file.
import { graphql, HttpResponse, mockGql, server, useFakeClock as freezeClock, advanceUntilDone } from '@/test/helpers';
import { _resetNetworkTrackingForTests, useNetworkStore } from '@/lib/stores/network-store';
import logger from '@/lib/logger';

export type Vars = Record<string, unknown>;

/** Answers one operation and records the variables of every request for it. */
export function serve<T>(operationName: string, answer: (variables: Vars) => T): Vars[] {
  const seen: Vars[] = [];
  server.use(
    mockGql(operationName, (variables) => {
      seen.push(variables);
      return answer(variables);
    }),
  );
  return seen;
}

/** Records the query document and variables of every request for one operation, and answers it. */
export function serveWithDocument<T>(
  operationName: string,
  answer: (variables: Vars) => T,
): { documents: string[]; variables: Vars[] } {
  const out = { documents: [] as string[], variables: [] as Vars[] };
  server.use(
    graphql.operation(({ operationName: name, query, variables }) => {
      if (name !== operationName) return undefined;
      out.documents.push(query);
      out.variables.push(variables);
      return HttpResponse.json({ data: answer(variables) as Record<string, unknown> });
    }),
  );
  return out;
}

/** A transport failure for one operation. */
export const failTransport = (operationName: string) =>
  graphql.operation(({ operationName: name }) => (name === operationName ? HttpResponse.error() : undefined));

/**
 * Starts `call` under the fake clock, advances time through the link chain's retry backoff and
 * resolves to the rejection (or null when the call resolved).
 */
export async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  freezeClock(Date.now());
  return advanceUntilDone(
    call().then(
      () => null,
      (e: unknown) => e ?? new Error('rejected with nothing'),
    ),
  );
}

/** Like {@link rejectionOf} for a call that is expected to resolve despite the failure: its value. */
export async function underClock<T>(call: () => Promise<T>): Promise<T> {
  freezeClock(Date.now());
  return advanceUntilDone(call());
}

/** Module memory in the Apollo link chain that a per-test reset does not touch. */
export function resetNetworkMemory(): void {
  _resetNetworkTrackingForTests();
  useNetworkStore.setState({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
}

/** Call-through spies on the real logger; `restore()` in afterEach. */
export function spyLogger() {
  const captureException = jest.spyOn(logger, 'captureException');
  const warn = jest.spyOn(logger, 'warn');
  const info = jest.spyOn(logger, 'info');
  return {
    captureException,
    warn,
    info,
    restore: () => [captureException, warn, info].forEach((s) => s.mockRestore()),
  };
}
