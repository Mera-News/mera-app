// The feed pipeline's status as a value, and the one rule about it that the UI
// needs — with NO imports.
//
// That emptiness is the point. The hook that derives this (lib/hooks/
// use-feed-status-mode) reaches the scheduler and the for-you store, which
// transitively instantiate a native SQLite adapter at module load. A purely
// presentational component that only needs to know "does this mode draw
// anything?" must not pull that in behind it — otherwise every test of the
// glyph has to mock a database to render an icon.

/**
 * `deferred` means "there are unscored rows but nothing is in flight" — a
 * deliberate wait for the next batch. It carries no visual weight of its own:
 * the old full-width bar rendered it as a standing "waiting for the next batch
 * (N)" line, which was a pipeline count the reader could not act on and exactly
 * the ambient progress chatter the Feed is being cleared of. It renders the same
 * resting mark as `idle`, and the count is still in the detail panel one tap
 * away.
 */
export type FeedStatusMode = 'processing' | 'error' | 'limited' | 'deferred' | 'idle';

// `isStatusVisible(mode)` used to live here, answering "does this mode draw
// anything?" (true for processing/error/limited, false for idle/deferred). It is
// GONE ON PURPOSE, not merely unused.
//
// The status lives in the Feed's counts card (for-you/DashboardStatsCard), the
// Feed list's first item: its Mera mark moves while a run is in flight, and at
// the limit or on a problem the card is the notice. Nothing decides
// visibility from the mode, and a predicate exported here would invite exactly
// that wiring back: a status surface that appears and vanishes with each sync.
