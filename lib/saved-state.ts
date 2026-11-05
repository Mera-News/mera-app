// saved-state — the app-wide "is this article saved?" invalidation channel.
//
// PROBLEM IT SOLVES. Every surface that shows a bookmark keeps its own local
// `saved` flag, seeded once by an `isSuggestionSaved()` read on mount. Nothing
// told those flags when the row changed somewhere ELSE, so deleting an article
// from the Saved list left its Feed card still showing a filled bookmark — and
// the next tap ran the "un-save" branch against a row that no longer existed: a
// silent no-op that merely cleared the icon.
//
// Re-reading the DB per card was not an option (dozens of rows in a scrolling
// list), and a WatermelonDB observable per card is the same cost in disguise.
// Instead the WRITE side publishes, and readers subscribe to a plain in-memory
// map. Same shape as lib/time-tick.ts: one module-level source, `useSyncExternal
// Store` on the reading side, no timers and no DB traffic.
//
// This is an OVERRIDE layer, not a cache. A missing entry means "nobody has
// mutated this id since launch — trust your own mount-time read". Only ids the
// user has actually saved or unsaved get an entry, so the map stays proportional
// to interaction rather than to feed size.

import { useSyncExternalStore } from 'react';

/** Saved's two lists. Here rather than in the service so a card can name it
 *  without importing the database. */
export type SavedList = 'later' | 'archive';

/** id → authoritative saved flag, for ids mutated during this session. */
const overrides = new Map<string, boolean>();
/** id → the Saved list it now sits in, for ids saved or moved this session. */
const listOverrides = new Map<string, SavedList>();
const listeners = new Set<() => void>();
/** Bumped on every change, for a reader that derives a whole list. */
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce that `id`'s saved state is now `saved`. Called by the write paths in
 * saved-article-suggestion-service, so every mounted surface showing that
 * article corrects itself on the next frame — whichever screen performed the
 * change.
 */
export function publishSavedState(id: string, saved: boolean): void {
  if (!id) return;
  if (overrides.get(id) === saved) return; // no-op writes must not re-render
  overrides.set(id, saved);
  emit();
}

/** Non-reactive read — for imperative paths that need the current override. */
export function getSavedOverride(id: string): boolean | undefined {
  return id ? overrides.get(id) : undefined;
}

/**
 * Reactive override for one article id. `undefined` ⇒ untouched this session;
 * the caller should fall back to its own mount-time DB read.
 *
 * Returns a primitive, so `useSyncExternalStore`'s snapshot is referentially
 * stable and this cannot loop.
 */
export function useSavedOverride(id: string): boolean | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id ? overrides.get(id) : undefined),
    () => undefined, // server snapshot (unused on native; required by the API)
  );
}

/** Announce which list `id` now sits in. Same contract as publishSavedState. */
export function publishSavedList(id: string, list: SavedList): void {
  if (!id) return;
  if (listOverrides.get(id) === list) return;
  listOverrides.set(id, list);
  emit();
}

/** Non-reactive read of {@link useSavedList}. */
export function getSavedListOverride(id: string): SavedList | undefined {
  return id ? listOverrides.get(id) : undefined;
}

/** Reactive list override for one id. `undefined` ⇒ untouched this session. */
export function useSavedList(id: string): SavedList | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id ? listOverrides.get(id) : undefined),
    () => undefined,
  );
}

/**
 * Changes whenever any id's override does. The Saved page re-derives its rows
 * from it, so a removed or moved row leaves the list and its group heading on
 * the next frame, count included. A number, so the snapshot is stable.
 */
export function useSavedStateVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/**
 * Sign-out reset: drop every override and tell mounted readers to re-read. The
 * listeners stay, since mounted components keep their subscriptions.
 */
export function resetSavedState(): void {
  overrides.clear();
  listOverrides.clear();
  emit();
}

/** Test-only reset — the map is module state and would leak across cases. */
export function __resetSavedStateForTests(): void {
  overrides.clear();
  listOverrides.clear();
  listeners.clear();
}
