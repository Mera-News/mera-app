// Shared by the notification-service seam tests. Not a test file.
//
// `freshGraph()` is a JS reload: a new module registry (jest.isolateModules) over the SAME
// in-memory database. Module memory (listeners, the stash, the startup-gate flag, the stores,
// the token-rotation latch) starts empty; the settings rows survive, which is what a reload does.
//
// Two things follow from a registry being fresh, and both are handled here:
//   - lib/database builds its own in-memory store, so the new graph is handed the ORIGINAL
//     instance (jest.doMock below). It is the same real database, not a stand-in.
//   - A mock factory runs again inside an isolated registry UNLESS the main registry already
//     holds that mock (jest-runtime requireMock). So whether a setup-file mock (expo-router, the
//     secure store) is shared depends on what the test file loaded first. `freshGraph` loads
//     expo-router in the main registry before isolating, which makes `router` one object.
// The notification and logger edges live on globalThis (edge.ts) and are shared outright.
import { graphql } from 'msw';
import { server } from '@/test/helpers';

type Service = typeof import('@/lib/notification-service');
type Route = typeof import('@/lib/stores/pending-notification-route');
type UserStore = typeof import('@/lib/stores/user-store');
type NetworkStore = typeof import('@/lib/stores/network-store');

/**
 * The modules the service imports STATICALLY, as the reloaded graph holds them. The service also
 * `require`s a few modules lazily at call time (pin-store, article-suggestion-service,
 * for-you-store, intercom, setting-service from the route). Those resolve from the test file's own
 * registry, because the isolated registry only lasts for the load: assert on them through the test
 * file's imports, never through this handle.
 */
export interface Graph {
  service: Service;
  route: Route;
  user: UserStore;
  network: NetworkStore;
  /** expo-router's `router`. ONE object across every graph (see freshGraph), so a test that boots two
   *  contexts reads cumulative calls. */
  router: { push: jest.Mock; replace: jest.Mock };
}

/** `env` is set while the graph loads (modules read it at load) and restored after. */
export function freshGraph(env: Record<string, string> = {}): Graph {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharedDatabase = require('@/lib/database');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { router } = require('expo-router');
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let graph!: Graph;
  try {
    jest.isolateModules(() => {
      jest.doMock('@/lib/database', () => sharedDatabase);
      /* eslint-disable @typescript-eslint/no-require-imports */
      graph = {
        service: require('@/lib/notification-service'),
        route: require('@/lib/stores/pending-notification-route'),
        user: require('@/lib/stores/user-store'),
        network: require('@/lib/stores/network-store'),
        router,
      };
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
  } finally {
    jest.dontMock('@/lib/database');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return graph;
}

/** Signs a user in on the graph's stores. The id is the one the mock backend echoes by default. */
export function signIn(g: Graph, userId = 'user-1'): void {
  g.user.useUserStore.setState({ userId });
}

/**
 * Records the variables of every `operationName` request and lets the default handler answer it.
 * (A handler that returns nothing falls through to the next one.)
 */
export function recordOperation(operationName: string): Record<string, any>[] {
  const seen: Record<string, any>[] = [];
  server.use(
    graphql.operation(({ operationName: name, variables }) => {
      if (name === operationName) seen.push(variables);
      return undefined;
    }),
  );
  return seen;
}

/** Lets already-runnable promise chains and database callbacks finish. */
export async function settle(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Polls (on real event-loop turns) until `condition` holds. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, maxTurns = 400): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Seeding, through the app's own writers
// ---------------------------------------------------------------------------

/**
 * One `article_suggestions` row, landed the way a sync lands it (the row id IS the article id, which
 * is what `suggestionId` in a notification payload names). With `relevance` the row is then scored.
 */
export async function seedSuggestion(id: string, relevance?: number): Promise<void> {
  const { persistAndLinkV2Suggestions } = await import(
    '@/lib/database/services/article-suggestion-persist'
  );
  const { saveScoringResult } = await import('@/lib/database/services/article-suggestion-scoring-writes');
  await persistAndLinkV2Suggestions(
    [
      {
        __typename: 'ArticleWithClusters',
        _id: id,
        clusters: [],
        title: `Original ${id}`,
        title_en: `Harbour report ${id}`,
        description_en: `Harbour details ${id}`,
        article_url: `https://example.com/${id}`,
        image_url: null,
        country_code: 'NLD',
        publication_name: 'Test Pub',
        language_code: 'en',
        pubDate: new Date(Date.now() - 3_600_000).toISOString(),
        geo_tags: [],
        entities: [],
        event_type: null,
        category: null,
        maxClusterSize: 1,
      } as never,
    ],
    new Map(),
    {
      matchedTopics: new Map(),
      headlineScope: new Map(),
      headlineCountryCode: new Map(),
      stableClusterId: new Map(),
    },
  );
  if (relevance !== undefined) await saveScoringResult(id, { relevance, reason: '', reasonSkipped: false });
}
