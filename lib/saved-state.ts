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

/** id → authoritative saved flag, for ids mutated during this session. */
const overrides = new Map<string, boolean>();
const listeners = new Set<() => void>();

function emit(): void {
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

/** Test-only reset — the map is module state and would leak across cases. */
export function __resetSavedStateForTests(): void {
  overrides.clear();
  listeners.clear();
}
