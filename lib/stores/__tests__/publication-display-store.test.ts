// publication-display-store.test.ts: the display-name map for publication
// names (ux2 A6). Display only: the raw `publication_name` is the key every
// write keeps; this store only says how to SHOW it in the app language.

import { renderHook, act } from '@testing-library/react-native';
import {
  createPublicationDisplayStore,
  makeUseDisplayPublication,
  PUBLICATION_DISPLAY_BATCH_MAX,
  PUBLICATION_DISPLAY_DEBOUNCE_MS,
  PUBLICATION_DISPLAY_REFRESH_MS,
  type PublicationDisplayCache,
  type PublicationDisplayPorts,
} from '../publication-display-store';

type Fetch = PublicationDisplayPorts['fetch'];

/** In-memory ports: a fake server table per language and a fake settings table. */
function fakePorts(table: Record<string, Record<string, string>> = {}) {
  const saved = new Map<string, PublicationDisplayCache>();
  const fetch = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(async (language, names) => {
    const out: Record<string, string> = {};
    for (const n of names) {
      const hit = table[language]?.[n];
      if (hit !== undefined) out[n] = hit;
    }
    return out;
  });
  const load = jest.fn(async (language: string) => saved.get(language) ?? null);
  const save = jest.fn(async (language: string, entry: PublicationDisplayCache) => {
    saved.set(language, entry);
  });
  return { ports: { fetch, load, save } as PublicationDisplayPorts, fetch, load, save, saved };
}

/** Resolve every pending microtask plus the debounce timer. */
async function settle(ms = PUBLICATION_DISPLAY_DEBOUNCE_MS + 10) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const TABLE = {
  en: { '人民日报': 'Renmin Ribao', 'Российская газета': 'Rossiyskaya Gazeta' },
  ja: { '人民日报': '人民日報', 'Der Spiegel': 'デア・シュピーゲル' },
};

describe('publication-display-store', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('names displayed in the same moment go out in ONE batched call', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    store.getState().request('Российская газета');
    store.getState().request('Le Monde');
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][0]).toBe('en');
    expect([...f.fetch.mock.calls[0][1]].sort()).toEqual(
      ['Le Monde', 'Российская газета', '人民日报'].sort(),
    );
    expect(store.getState().names).toEqual({
      '人民日报': 'Renmin Ribao',
      'Российская газета': 'Rossiyskaya Gazeta',
      // Not in the answer: known as itself, so it is never asked again.
      'Le Monde': 'Le Monde',
    });
  });

  it('a known name is never re-requested (no flicker loop)', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('Le Monde');
    await settle();
    store.getState().request('Le Monde');
    store.getState().request('Le Monde');
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it(`caps each call at ${PUBLICATION_DISPLAY_BATCH_MAX} names and sends the rest next`, async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts();
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    for (let i = 0; i < PUBLICATION_DISPLAY_BATCH_MAX + 5; i++) store.getState().request(`Pub ${i}`);
    await settle();
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[0][1]).toHaveLength(PUBLICATION_DISPLAY_BATCH_MAX);
    expect(f.fetch.mock.calls[1][1]).toHaveLength(5);
  });

  it('persists the map per language in the cache port', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    await settle();
    expect(f.saved.get('en')?.names).toEqual({ '人民日报': 'Renmin Ribao' });
  });

  it('a fresh cache shows instantly and is not refetched (offline launch)', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts();
    f.saved.set('en', { savedAt: Date.now() - 1000, names: { '人民日报': 'Renmin Ribao' } });
    f.fetch.mockRejectedValue(new Error('offline'));
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    expect(store.getState().names['人民日报']).toBe('Renmin Ribao');
    store.getState().request('人民日报');
    await settle();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('a stale cache still shows instantly and is refreshed once the name is displayed again', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts({ en: { '人民日报': 'Renmin Ribao (new)' } });
    f.saved.set('en', {
      savedAt: Date.now() - PUBLICATION_DISPLAY_REFRESH_MS - 1,
      names: { '人民日报': 'Renmin Ribao' },
    });
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    expect(store.getState().names['人民日报']).toBe('Renmin Ribao');
    // Nothing fetched at launch: before sign-in there is no session to ask with,
    // and an UNAUTHENTICATED answer feeds the auth-failure breaker.
    await settle();
    expect(f.fetch).not.toHaveBeenCalled();
    // A card showing it (signed in by then) refreshes it, once.
    store.getState().request('人民日报');
    store.getState().request('人民日报');
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(store.getState().names['人民日报']).toBe('Renmin Ribao (new)');
    store.getState().request('人民日报');
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('a language switch drops the old map and refetches every name seen, in the new language', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    store.getState().request('Der Spiegel');
    await settle();
    expect(store.getState().names['人民日报']).toBe('Renmin Ribao');

    await act(async () => {
      await store.getState().setLanguage('ja');
    });
    // Never the previous language's name under the new one.
    expect(store.getState().names['人民日报']).toBeUndefined();
    await settle();
    expect(f.fetch).toHaveBeenLastCalledWith('ja', expect.arrayContaining(['人民日报', 'Der Spiegel']));
    expect(store.getState().names).toEqual({ '人民日报': '人民日報', 'Der Spiegel': 'デア・シュピーゲル' });
  });

  it('switching back to a language used before shows its cached map instantly', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    await settle();
    await act(async () => {
      await store.getState().setLanguage('ja');
    });
    await settle();
    f.fetch.mockClear();
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    expect(store.getState().names['人民日报']).toBe('Renmin Ribao');
    await settle();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('an answer that lands after a language switch is dropped, never shown under the new language', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    let release: (v: Record<string, string>) => void = () => {};
    f.fetch.mockImplementationOnce(
      () => new Promise<Record<string, string>>((r) => (release = r)),
    );
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    await settle(); // the en call is now in flight
    await act(async () => {
      await store.getState().setLanguage('ja');
    });
    await act(async () => {
      release({ '人民日报': 'Renmin Ribao' });
      await Promise.resolve();
    });
    expect(store.getState().names['人民日报']).not.toBe('Renmin Ribao');
    expect(f.saved.get('ja')?.names?.['人民日报']).not.toBe('Renmin Ribao');
  });

  it('offline: a failed call leaves the raw name and retries later, not in a loop', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    f.fetch.mockRejectedValueOnce(new Error('offline'));
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(store.getState().names['人民日报']).toBeUndefined();
    // Re-rendering cards keep asking; that must not hammer the server.
    store.getState().request('人民日报');
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    // The backoff retry heals it.
    await settle(60_000);
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(store.getState().names['人民日报']).toBe('Renmin Ribao');
  });

  // A server without the query (GRAPHQL_VALIDATION_FAILED) will not grow it
  // mid-session: every further call would only be another logged error.
  it('an "unsupported" failure stops every further request until the next launch', async () => {
    const { PublicationDisplayUnsupportedError } = require('../publication-display-store');
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    f.fetch.mockRejectedValueOnce(new PublicationDisplayUnsupportedError());
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    store.getState().request('Der Spiegel');
    await settle(10 * 60_000);
    await act(async () => {
      await store.getState().setLanguage('ja');
    });
    await settle(10 * 60_000);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    // Raw names throughout.
    expect(store.getState().names['人民日报']).toBeUndefined();
  });

  it('any other failure keeps the backoff retry', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    f.fetch.mockRejectedValueOnce(new Error('Network request failed'));
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    store.getState().request('人民日报');
    await settle();
    await settle(60_000);
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('names asked for before the store is wired are fetched once it is', async () => {
    const store = createPublicationDisplayStore();
    const f = fakePorts(TABLE);
    store.getState().request('人民日报');
    await settle();
    store.getState().configure(f.ports);
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    await settle();
    expect(f.fetch).toHaveBeenCalledWith('en', ['人民日报']);
    expect(store.getState().names['人民日报']).toBe('Renmin Ribao');
  });

  it('unwired (tests, early launch): no timers, no calls, nothing thrown', async () => {
    const store = createPublicationDisplayStore();
    store.getState().request('人民日报');
    expect(jest.getTimerCount()).toBe(0);
  });

  describe('useDisplayPublication', () => {
    it('shows the original until the display name is known, then the display name', async () => {
      const store = createPublicationDisplayStore();
      const useDisplay = makeUseDisplayPublication(store);
      const f = fakePorts(TABLE);
      store.getState().configure(f.ports);
      await act(async () => {
        await store.getState().setLanguage('en');
      });
      const { result } = renderHook(() => useDisplay('人民日报'));
      expect(result.current).toBe('人民日报');
      await settle();
      expect(result.current).toBe('Renmin Ribao');
      expect(f.fetch).toHaveBeenCalledTimes(1);
    });

    it('passes a missing name through untouched', () => {
      const store = createPublicationDisplayStore();
      const useDisplay = makeUseDisplayPublication(store);
      const { result } = renderHook(() => useDisplay(undefined));
      expect(result.current).toBeUndefined();
      const empty = renderHook(() => useDisplay(''));
      expect(empty.result.current).toBe('');
    });
  });
});

describe('DisplayPublicationName (list rows)', () => {
  it('renders the display form as a bare string inside a Text', () => {
    const { render } = require('@testing-library/react-native');
    const { Text } = require('react-native');
    const R = require('react');
    const { usePublicationDisplayStore, DisplayPublicationName } = require('../publication-display-store');
    usePublicationDisplayStore.setState({ language: 'en', names: { '人民日报': 'Renmin Ribao' } });
    try {
      const r = render(R['createElement'](Text, null, R['createElement'](DisplayPublicationName, { name: '人民日报' })));
      expect(r.getByText('Renmin Ribao')).toBeTruthy();
    } finally {
      usePublicationDisplayStore.setState({ language: null, names: {} });
    }
  });
});
