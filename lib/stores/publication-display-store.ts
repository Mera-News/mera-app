// publication-display-store: how to SHOW a publication's name in the app
// language (ux2 A6). 人民日报 reads "Renmin Ribao" to an English reader and
// Le Monde reads "Ле Монд" to a Russian one: written phonetically in the
// reader's script, never translated for meaning (the server computes it).
//
// DISPLAY ONLY. The raw `publication_name` stays the KEY everywhere: "Fewer
// from", publication prefs, visit rows, hard filters and the scorer all write
// and match the raw name. Only display sites read this store, through
// `useDisplayPublication` (or `displayPublicationName` in a callback).
//
// Shape:
//  - `names` is raw name -> display name for the CURRENT app language. A name
//    the server had no entry for is stored as itself, so it counts as known and
//    is never asked for again (that is what stops a flicker loop).
//  - Names are collected as cards render them and sent in one debounced,
//    batched call, at most PUBLICATION_DISPLAY_BATCH_MAX per call.
//  - The map is cached per language by the `load`/`save` ports (the settings
//    table), so it shows instantly on launch and survives being offline. A
//    cache older than PUBLICATION_DISPLAY_REFRESH_MS is shown AND refreshed,
//    which is how a name the server translated later reaches the app.
//  - A language switch drops the map, loads that language's cache and
//    refetches every name seen this session in the new language.
//
// The ports are injected (`configure`) by lib/publication-display-service.ts
// at startup. This module imports no database or network code on purpose: the
// card graph imports it, and a database import there crashes the card suites
// in jest (initializeJSI). Unwired, it queues names and does nothing else.

import { useEffect } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';

/** One language's cached map, as the cache port stores it. */
export interface PublicationDisplayCache {
  savedAt: number;
  names: Record<string, string>;
}

/** What the store needs from the outside world. */
export interface PublicationDisplayPorts {
  /** raw name -> display name, for the app language code given. Names the
   *  server does not know may be left out. Rejects when offline. */
  fetch(language: string, names: readonly string[]): Promise<Record<string, string>>;
  load(language: string): Promise<PublicationDisplayCache | null>;
  save(language: string, entry: PublicationDisplayCache): Promise<void>;
}

/** Names per call; the server caps a call at 200. */
export const PUBLICATION_DISPLAY_BATCH_MAX = 200;
/** Coalesce window: a screen of cards mounting at once is one call. */
export const PUBLICATION_DISPLAY_DEBOUNCE_MS = 250;
/** A cache older than this is refreshed in the background. */
export const PUBLICATION_DISPLAY_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Retry after a failed call: doubles from here up to the max. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** The cache keeps the most recent entries only. */
const MAX_CACHED_NAMES = 3000;

interface PublicationDisplayState {
  /** App language the map is for. Null until wired. */
  language: string | null;
  /** raw name -> display name, current language only. */
  names: Record<string, string>;
  /** Ask for a name's display form. Idempotent and cheap: call it per render. */
  request: (name: string) => void;
  /** Adopt an app language: its cache shows first, then missing names load. */
  setLanguage: (language: string) => Promise<void>;
  /** Inject (or with null, remove) the fetch and cache ports. */
  configure: (ports: PublicationDisplayPorts | null) => void;
}

export type PublicationDisplayStore = UseBoundStore<StoreApi<PublicationDisplayState>>;

function capNames(names: Record<string, string>): Record<string, string> {
  const keys = Object.keys(names);
  if (keys.length <= MAX_CACHED_NAMES) return names;
  const out: Record<string, string> = {};
  for (const k of keys.slice(keys.length - MAX_CACHED_NAMES)) out[k] = names[k];
  return out;
}

/** A fresh store. The app uses the one instance below; tests make their own. */
export function createPublicationDisplayStore(): PublicationDisplayStore {
  let ports: PublicationDisplayPorts | null = null;
  /** Every name asked for this session, in any language. */
  const seen = new Set<string>();
  /** Names waiting for the next call, in the current language. */
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let failures = 0;

  const store = create<PublicationDisplayState>((set, get) => {
    const schedule = (delay = PUBLICATION_DISPLAY_DEBOUNCE_MS) => {
      if (!ports || get().language === null || timer || inFlight || pending.size === 0) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
    };

    const flush = async () => {
      const language = get().language;
      if (!ports || language === null || pending.size === 0) return;
      const batch = Array.from(pending).slice(0, PUBLICATION_DISPLAY_BATCH_MAX);
      for (const n of batch) pending.delete(n);
      const activePorts = ports;
      inFlight = true;
      let answer: Record<string, string>;
      try {
        answer = await activePorts.fetch(language, batch);
      } catch {
        inFlight = false;
        // A switch mid-call already rebuilt `pending` for the new language.
        if (get().language !== language) {
          schedule();
          return;
        }
        for (const n of batch) pending.add(n);
        failures += 1;
        schedule(Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS));
        return;
      }
      inFlight = false;
      if (get().language !== language) {
        // Answered in the language the user just left: never show or cache it.
        schedule();
        return;
      }
      failures = 0;
      const names = { ...get().names };
      for (const n of batch) names[n] = answer[n] ?? n;
      set({ names });
      activePorts.save(language, { savedAt: Date.now(), names: capNames(names) }).catch(() => undefined);
      schedule();
    };

    return {
      language: null,
      names: {},

      request: (name) => {
        if (!name || get().names[name] !== undefined) return;
        if (pending.has(name)) return;
        if (seen.has(name) && get().language !== null) return;
        seen.add(name);
        pending.add(name);
        schedule();
      },

      setLanguage: async (language) => {
        if (get().language === language) return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        failures = 0;
        set({ language, names: {} });
        let cached: PublicationDisplayCache | null = null;
        try {
          cached = ports ? await ports.load(language) : null;
        } catch {
          cached = null;
        }
        // Switched again while the cache loaded: that call owns the store now.
        if (get().language !== language) return;
        const names = cached?.names ?? {};
        const stale = cached ? Date.now() - cached.savedAt > PUBLICATION_DISPLAY_REFRESH_MS : false;
        pending = new Set(Array.from(seen).filter((n) => names[n] === undefined));
        if (stale) for (const n of Object.keys(names)) pending.add(n);
        set({ names });
        schedule();
      },

      configure: (next) => {
        ports = next;
        if (!next && timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  });
  return store;
}

export const usePublicationDisplayStore = createPublicationDisplayStore();

/** The hook factory, so tests can bind it to their own store. */
export function makeUseDisplayPublication(store: PublicationDisplayStore) {
  function useDisplay(name: string): string;
  function useDisplay(name: string | null | undefined): string | null | undefined;
  function useDisplay(name: string | null | undefined): string | null | undefined {
    const display = store((s) => (name ? s.names[name] : undefined));
    useEffect(() => {
      if (name && display === undefined) store.getState().request(name);
    }, [name, display]);
    return display ?? name;
  }
  return useDisplay;
}

/**
 * A publication name as the reader should SEE it: the display form in the app
 * language when known, otherwise the name itself. Display sites only; never
 * pass the result to a write, a filter or a match (those keep the raw name).
 */
export const useDisplayPublication = makeUseDisplayPublication(usePublicationDisplayStore);

/** {@link useDisplayPublication} for a callback (a toast, a dialog body). */
export function displayPublicationName(name: string): string {
  if (!name) return name;
  return usePublicationDisplayStore.getState().names[name] ?? name;
}
