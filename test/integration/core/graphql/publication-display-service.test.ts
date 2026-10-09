// publication-display-service at its seam: the real Apollo client against MSW, the real settings
// service on the in-memory DB, and a real publication-display store built per test. The service
// had no test: this pins the locale mapping, batching, the unsupported-server path, the cache row
// and the install wiring (current language adopted, language changes followed, no double wiring).
import { createStore } from 'zustand/vanilla';
import {
  fetchPublicationDisplayNames,
  installPublicationDisplayNames,
  publicationDisplayCacheKey,
  publicationDisplayPorts,
  serverLocaleFor,
} from '@/lib/publication-display-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import * as settingService from '@/lib/database/services/setting-service';
import {
  createPublicationDisplayStore,
  PUBLICATION_DISPLAY_BATCH_MAX,
  PUBLICATION_DISPLAY_DEBOUNCE_MS,
  PublicationDisplayUnsupportedError,
  type PublicationDisplayStore,
} from '@/lib/stores/publication-display-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { graphql, HttpResponse, mockGqlError, server, useFakeClock } from '@/test/helpers';
import { failTransport, rejectionOf, resetNetworkMemory, serve, spyLogger, type Vars } from './kit';

let log: ReturnType<typeof spyLogger>;
beforeEach(() => {
  resetNetworkMemory();
  useForYouStore.getState().setSyncStatusMessage(null);
  log = spyLogger();
});
afterEach(() => log.restore());

/** Answers PublicationDisplayNames with `Display <name>` for every name asked. */
const serveDisplayNames = () =>
  serve('PublicationDisplayNames', (v) => ({
    publicationDisplayNames: (v.names as string[]).map((name) => ({
      __typename: 'PublicationDisplayName',
      name,
      displayName: `Display ${name}`,
    })),
  }));

/** Steps the fake clock until `done()` holds (the debounce, then the real network round trip). */
async function until(done: () => boolean, maxMs = 5_000) {
  for (let t = 0; t < maxMs && !done(); t += 50) await jest.advanceTimersByTimeAsync(50);
  if (!done()) throw new Error('condition not met');
}

describe('serverLocaleFor', () => {
  it.each([
    ['pt', 'pt-BR'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hant', 'zh-TW'],
  ])('maps the app code %s to the server locale %s', (app, server) => {
    expect(serverLocaleFor(app)).toBe(server);
  });

  it.each(['en', 'de', 'fr', 'ja'])('passes %s through unchanged', (code) => {
    expect(serverLocaleFor(code)).toBe(code);
  });
});

describe('fetchPublicationDisplayNames', () => {
  it('sends the mapped locale and the names, and maps the rows to raw -> display', async () => {
    const seen = serveDisplayNames();

    const out = await fetchPublicationDisplayNames('zh-Hans', ['人民日报', 'Le Monde']);

    expect(seen).toEqual([{ language: 'zh-CN', names: ['人民日报', 'Le Monde'] }]);
    expect(out).toEqual({ 人民日报: 'Display 人民日报', 'Le Monde': 'Display Le Monde' });
  });

  it('makes no request for no names', async () => {
    const seen = serveDisplayNames();
    expect(await fetchPublicationDisplayNames('en', [])).toEqual({});
    expect(seen).toEqual([]);
  });

  it('splits more than the batch maximum into several requests, in order, and merges the answers', async () => {
    const names = Array.from({ length: PUBLICATION_DISPLAY_BATCH_MAX * 2 + 50 }, (_, i) => `Pub ${i}`);
    const seen = serveDisplayNames();

    const out = await fetchPublicationDisplayNames('en', names);

    expect(seen.map((v) => (v.names as string[]).length)).toEqual([PUBLICATION_DISPLAY_BATCH_MAX, PUBLICATION_DISPLAY_BATCH_MAX, 50]);
    expect((seen[2].names as string[])[0]).toBe(`Pub ${PUBLICATION_DISPLAY_BATCH_MAX * 2}`);
    expect(Object.keys(out)).toHaveLength(names.length);
  });

  it('skips rows with no name or no display name, and treats a null list as empty', async () => {
    serve('PublicationDisplayNames', () => ({
      publicationDisplayNames: [
        { name: 'A', displayName: 'Alpha' },
        { name: 'B', displayName: '' },
        { name: 'C', displayName: null },
        { name: '', displayName: 'Nameless' },
      ],
    }));
    expect(await fetchPublicationDisplayNames('en', ['A', 'B', 'C'])).toEqual({ A: 'Alpha' });

    serve('PublicationDisplayNames', () => ({ publicationDisplayNames: null }));
    expect(await fetchPublicationDisplayNames('en', ['A'])).toEqual({});
  });

  it('uses no-cache: the same names are asked twice', async () => {
    const seen = serveDisplayNames();
    await fetchPublicationDisplayNames('en', ['A']);
    await fetchPublicationDisplayNames('en', ['A']);
    expect(seen).toHaveLength(2);
  });

  it('rejects with the unsupported error when the server has no such query, logging once at info and never to Sentry', async () => {
    server.use(mockGqlError('PublicationDisplayNames', 'GRAPHQL_VALIDATION_FAILED', { message: 'Cannot query field' }));

    await expect(fetchPublicationDisplayNames('en', ['A'])).rejects.toBeInstanceOf(PublicationDisplayUnsupportedError);
    await expect(fetchPublicationDisplayNames('en', ['A'])).rejects.toBeInstanceOf(PublicationDisplayUnsupportedError);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('server has no publicationDisplayNames'));
    // The expected code is a breadcrumb in the error link, not an event, and not a feed banner.
    expect(log.captureException).not.toHaveBeenCalled();
    expect(useForYouStore.getState().syncStatusMessage).toBeNull();
  });

  it('re-throws any other GraphQL error as it came, reporting it but never painting the feed as failed', async () => {
    server.use(mockGqlError('PublicationDisplayNames', 'INTERNAL_SERVER_ERROR', { message: 'db down' }));

    const err = await fetchPublicationDisplayNames('en', ['A']).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PublicationDisplayUnsupportedError);
    expect((err as Error).message).toContain('db down');
    expect(log.captureException).toHaveBeenCalled();
    expect(useForYouStore.getState().syncStatusMessage).toBeNull();
  });

  it('re-throws a transport failure', async () => {
    server.use(failTransport('PublicationDisplayNames'));
    const err = await rejectionOf(() => fetchPublicationDisplayNames('en', ['A']));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PublicationDisplayUnsupportedError);
  });
});

describe('the cache port', () => {
  it('keys one settings row per app language', () => {
    expect(publicationDisplayCacheKey('de')).toBe('publication_display_names:de');
  });

  it('save writes the entry as JSON under the language key and load reads it back', async () => {
    const entry = { savedAt: 1_700_000_000_000, names: { A: 'Alpha' } };

    await publicationDisplayPorts.save('de', entry);

    expect(JSON.parse((await getSetting('publication_display_names:de')) ?? 'null')).toEqual(entry);
    expect(await publicationDisplayPorts.load('de')).toEqual(entry);
    expect(await publicationDisplayPorts.load('fr')).toBeNull();
  });

  it.each([
    ['not JSON', '{nope'],
    ['JSON null', 'null'],
    ['no savedAt', JSON.stringify({ names: {} })],
    ['a string savedAt', JSON.stringify({ savedAt: '1', names: {} })],
    ['no names', JSON.stringify({ savedAt: 1 })],
    ['names as an array', JSON.stringify({ savedAt: 1, names: ['A'] })],
    ['names as a string', JSON.stringify({ savedAt: 1, names: 'A' })],
  ])('load reads a row with %s as no cache', async (_label, raw) => {
    await setSetting('publication_display_names:en', raw);
    expect(await publicationDisplayPorts.load('en')).toBeNull();
  });

  it('save swallows a failed write and warns', async () => {
    const write = jest.spyOn(settingService, 'setSetting').mockRejectedValueOnce(new Error('disk full'));

    await expect(publicationDisplayPorts.save('en', { savedAt: 1, names: {} })).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith('[publication-display] cache write failed', {
      error: expect.stringContaining('disk full'),
    });
    write.mockRestore();
  });
});

describe('installPublicationDisplayNames', () => {
  let store: PublicationDisplayStore;
  // A real vanilla store standing in for the app-language store: the service only reads
  // getState().appLanguage and subscribes.
  type Source = NonNullable<Parameters<typeof installPublicationDisplayNames>[1]>;
  const languages = (appLanguage: string) => {
    const language = createStore<{ appLanguage: string }>(() => ({ appLanguage }));
    return Object.assign(language as unknown as Source, {
      switchTo: (next: string) => language.setState({ appLanguage: next }),
    });
  };

  beforeEach(() => {
    store = createPublicationDisplayStore();
    useFakeClock(Date.now());
  });

  it('adopts the current app language, fetches requested names after the debounce and caches the map', async () => {
    const seen = serveDisplayNames();
    await installPublicationDisplayNames(store, languages('de'));
    expect(store.getState().language).toBe('de');

    store.getState().request('Le Monde');
    await jest.advanceTimersByTimeAsync(PUBLICATION_DISPLAY_DEBOUNCE_MS - 50);
    expect(seen).toEqual([]);
    await until(() => store.getState().names['Le Monde'] !== undefined);

    expect(seen).toEqual([{ language: 'de', names: ['Le Monde'] }]);
    expect(store.getState().names).toEqual({ 'Le Monde': 'Display Le Monde' });
    // The cache write is not awaited by the store; poll the row.
    let raw: string | null = null;
    await until(() => {
      void getSetting('publication_display_names:de').then((r) => (raw = r));
      return raw !== null;
    });
    expect(JSON.parse(raw ?? 'null').names).toEqual({ 'Le Monde': 'Display Le Monde' });
  });

  it('shows the cached map for the language at once, before any request', async () => {
    await setSetting(
      'publication_display_names:fr',
      JSON.stringify({ savedAt: Date.now(), names: { 'Le Monde': 'Le Monde (cache)' } }),
    );
    const seen = serveDisplayNames();

    await installPublicationDisplayNames(store, languages('fr'));

    expect(store.getState().names).toEqual({ 'Le Monde': 'Le Monde (cache)' });
    store.getState().request('Le Monde');
    await jest.advanceTimersByTimeAsync(PUBLICATION_DISPLAY_DEBOUNCE_MS * 4);
    expect(seen).toEqual([]);
  });

  it('follows an app language change: the new locale is loaded and names seen this session are refetched in it', async () => {
    const seen = serveDisplayNames();
    const source = languages('en');
    await installPublicationDisplayNames(store, source);
    store.getState().request('Renmin');
    await until(() => store.getState().names.Renmin !== undefined);

    source.switchTo('pt');
    await until(() => seen.length === 2 && store.getState().names.Renmin !== undefined);

    expect(store.getState().language).toBe('pt');
    expect(seen.map((v: Vars) => v.language)).toEqual(['en', 'pt-BR']);
    expect(seen[1].names).toEqual(['Renmin']);
  });

  it('replaces the previous subscription on a second install instead of doubling it', async () => {
    const first = languages('en');
    const second = languages('en');
    await installPublicationDisplayNames(store, first);
    await installPublicationDisplayNames(store, second);

    first.switchTo('de');
    await jest.advanceTimersByTimeAsync(100);
    expect(store.getState().language).toBe('en');

    second.switchTo('de');
    await until(() => store.getState().language === 'de');
  });

  it('stops asking for the rest of the session once the server answers GRAPHQL_VALIDATION_FAILED', async () => {
    let asked = 0;
    server.use(
      graphql.operation(({ operationName }) => {
        if (operationName !== 'PublicationDisplayNames') return undefined;
        asked += 1;
        return HttpResponse.json({
          errors: [{ message: 'Cannot query field', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
        });
      }),
    );
    await installPublicationDisplayNames(store, languages('en'));

    store.getState().request('A');
    await until(() => asked === 1);
    await jest.advanceTimersByTimeAsync(PUBLICATION_DISPLAY_DEBOUNCE_MS * 4);
    store.getState().request('B');
    await jest.advanceTimersByTimeAsync(PUBLICATION_DISPLAY_DEBOUNCE_MS * 4);

    expect(asked).toBe(1);
    expect(store.getState().names).toEqual({});
  });

  it('keeps the raw name and retries later when the server is unreachable', async () => {
    server.use(failTransport('PublicationDisplayNames'));
    await installPublicationDisplayNames(store, languages('en'));

    store.getState().request('A');
    await jest.advanceTimersByTimeAsync(PUBLICATION_DISPLAY_DEBOUNCE_MS + 10_000);

    expect(store.getState().names).toEqual({});
    expect(await getSetting('publication_display_names:en')).toBeNull();
  });
});
