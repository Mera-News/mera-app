import { ownNewsRoute, ownNewsState } from './own-news-state';
import { podConfig, podState } from './pod-state';

export type NewsRoute = { kind: 'pod' | 'ownNews'; graphqlUrl: string; headers: Record<string, string> };

// Pairing wins over an own news server: while paired, nothing else answers a news query.
export function newsRoute(): NewsRoute | null {
  const p = podConfig();
  if (p) return { kind: 'pod', graphqlUrl: `${p.baseUrl}/graphql`, headers: { authorization: `Bearer ${p.token}` } };
  const own = ownNewsRoute();
  return own ? { kind: 'ownNews', graphqlUrl: own.graphqlUrl, headers: own.key ? { 'x-api-key': own.key } : {} } : null;
}

export const hydrateRoutes = (): Promise<unknown> => Promise.all([ownNewsState.hydrate(), podState.hydrate()]);
