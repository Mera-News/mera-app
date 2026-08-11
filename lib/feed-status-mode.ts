// The feed pipeline's status as a value, and the one rule about it that the UI
// needs — with NO imports.
//
// That emptiness is the point. The hook that derives this (lib/hooks/
// use-feed-status-mode) reaches the scheduler and the for-you store, which
// transitively instantiate a native SQLite adapter at module load. A purely
// presentational component that only needs to know "does this mode draw
// anything?" must not pull that in behind it — otherwise every test of the
// glyph has to mock a database to render an icon.

export type FeedStatusMode = 'processing' | 'error' | 'limited' | 'deferred' | 'idle';

/**
 * Whether this mode has anything worth putting on screen.
 *
 * `deferred` is deliberately NOT visible. It means "there are unscored rows but
 * nothing is in flight" — a deliberate wait for the next batch, which the old
 * full-width bar rendered as a standing "waiting for the next batch (N)" line.
 * That was a pipeline count the reader could not act on, and it is exactly the
 * kind of ambient progress chatter the Feed is being cleared of. The count still
 * appears inside the detail panel for anyone who opens it.
 */
export function isStatusVisible(mode: FeedStatusMode): boolean {
    return mode === 'processing' || mode === 'error' || mode === 'limited';
}
