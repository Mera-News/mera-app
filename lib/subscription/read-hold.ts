// The read hold: the gateway's daily reading limit, as this device knows it.
//
// Only POST /v1/inference/jobs is metered. When the gateway refuses one with
// 429 {code:'daily-quota-exceeded', resetAt}, cloud scoring pauses until the
// reset; every accepted submit reports how much of the day is used
// (X-Mera-Reading-Used, 0..1). On-device reading is never held: callers check
// the processing mode themselves, this module is a pure time check.
//
// **Two clocks.** `resetAt` is the server's instant (00:00 UTC) and is what the
// UI shows. The hold END is that instant moved onto this device's clock (the
// server Date header gives the offset) plus a per-hold jitter of 0-30 min, so
// a fleet of held phones does not resubmit in the same second at midnight.
// `isReadHeld` compares against the hold end, never `resetAt` itself.
//
// **Persistence.** One settings row, `read_hold`, mirrored in memory so the
// synchronous readers (scheduler conditions, the pipeline's gates) never await.
// The row survives a JS reload; `hydrateReadHold` restores it at boot and at
// every background entry point. `resetReadHold` clears memory only: the account
// switch wipe resets the settings table itself.
//
// `setting-service` is required LAZILY: it builds a WatermelonDB collection at
// module scope, and a top-level import would construct a real SQLite adapter in
// every suite that imports the submit path.

import { useSyncExternalStore } from 'react';

export interface ReadHold {
  /** Server instant of the reset (epoch ms), while held; null otherwise. */
  resetAt: number | null;
  /** Share of today's reading used, 0..1; null when unknown or from another UTC day. */
  used: number | null;
}

export const READ_HOLD_KEY = 'read_hold';
export const READ_HOLD_MAX_JITTER_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

interface State {
  resetAt: number | null;
  holdUntil: number | null;
  used: number | null;
  /** UTC day (YYYY-MM-DD) `used` belongs to. */
  usedDay: string | null;
  /** Device time of the last write, for "Last updated". */
  updatedAt: number | null;
}

const EMPTY: State = { resetAt: null, holdUntil: null, used: null, usedDay: null, updatedAt: null };

let state: State = { ...EMPTY };
/** True once this process has read the row or written the hold: a later
 *  hydrate (a background entry point) must not overwrite a newer in-memory
 *  value with a row whose write is still in flight. */
let loaded = false;
let snapshot: ReadHold | null = null;
const listeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/unit/persona/read-hold.test.ts)
// ---------------------------------------------------------------------------

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The next 00:00 UTC strictly after `now`. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Where the hold ends on THIS device's clock. `serverNow` is the server's
 * clock at the moment `deviceNow` was read (the response Date header); without
 * it the clocks are taken as equal. The reset is clamped to at most a day
 * ahead of the server, so a bad clock or a bad parse can never hold forever.
 */
export function computeHoldUntil(args: {
  resetAt: number;
  deviceNow: number;
  serverNow?: number | null;
  jitterMs: number;
}): number {
  const serverNow = args.serverNow ?? args.deviceNow;
  const offset = serverNow - args.deviceNow;
  const reset = Math.min(args.resetAt, serverNow + DAY_MS);
  const jitter = Math.max(0, Math.min(READ_HOLD_MAX_JITTER_MS, args.jitterMs));
  return reset - offset + jitter;
}

/** 'today' or 'tomorrow' for an instant, by the phone's LOCAL date. The next
 *  00:00 UTC is never further away than tomorrow in any time zone. */
export function resetDayWord(at: number, now: number = Date.now()): 'today' | 'tomorrow' {
  const a = new Date(at);
  const n = new Date(now);
  return a.getFullYear() === n.getFullYear() &&
    a.getMonth() === n.getMonth() &&
    a.getDate() === n.getDate()
    ? 'today'
    : 'tomorrow';
}

/** A Date response header as epoch ms, or null. */
export function serverNowFromDateHeader(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function heldAt(s: State, now: number): boolean {
  return s.holdUntil != null && now < s.holdUntil;
}

function readFrom(s: State, now: number): ReadHold {
  const held = heldAt(s, now);
  return {
    resetAt: held ? s.resetAt : null,
    used: s.used != null && s.usedDay === utcDay(now) ? s.used : null,
  };
}

export function getReadHold(): ReadHold {
  return readFrom(state, Date.now());
}

export function isReadHeld(now: number = Date.now()): boolean {
  return heldAt(state, now);
}

/** Device time of the last write, for the offline "Last updated" line. */
export function getReadHoldUpdatedAt(): number | null {
  return state.updatedAt;
}

/** Where the current hold ends on this device's clock, or null when none was set. */
export function readHoldEndsAt(): number | null {
  return state.holdUntil;
}

/** Called on every write (a hold set, a hold cleared by a plan rise, a hydrate, a reset).
 *  Expiry emits nothing. */
export function subscribeReadHold(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadHold {
  const next = getReadHold();
  if (!snapshot || snapshot.resetAt !== next.resetAt || snapshot.used !== next.used) {
    snapshot = next;
  }
  return snapshot;
}

/** Re-renders on every write. Expiry is time-based and emits nothing: a screen
 *  that must flip at the hold end runs its own timer. */
export function useReadHold(): ReadHold {
  return useSyncExternalStore(subscribeReadHold, getSnapshot, getSnapshot);
}

function emit(): void {
  for (const l of listeners) l();
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function settingService(): typeof import('@/lib/database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

/**
 * Patch the hold and persist it. `resetAt: null` ends the hold (a tier rise);
 * a number starts or keeps one. Re-sending the same `resetAt` keeps the hold's
 * jitter, so repeated reports do not move the end. `serverNow` is the server
 * clock of the response that carried the value. Never rejects.
 */
export async function setReadHold(
  patch: Partial<ReadHold>,
  opts: { serverNow?: number | null } = {},
): Promise<void> {
  // A write can arrive before boot hydration (a 202, the launch billing read).
  // Merging into empty memory would persist over the stored hold and lose it.
  if (!loaded) await hydrateReadHold();
  const now = Date.now();
  const next: State = { ...state, updatedAt: now };
  if (patch.resetAt !== undefined) {
    if (patch.resetAt == null || !Number.isFinite(patch.resetAt)) {
      next.resetAt = null;
      next.holdUntil = null;
    } else if (patch.resetAt !== state.resetAt || state.holdUntil == null) {
      next.resetAt = patch.resetAt;
      next.holdUntil = computeHoldUntil({
        resetAt: patch.resetAt,
        deviceNow: now,
        serverNow: opts.serverNow,
        jitterMs: Math.random() * READ_HOLD_MAX_JITTER_MS,
      });
    }
  }
  if (patch.used !== undefined) {
    next.used = patch.used == null || !Number.isFinite(patch.used)
      ? null
      : Math.max(0, Math.min(1, patch.used));
    next.usedDay = next.used == null ? null : utcDay(now);
  }
  state = next;
  loaded = true;
  emit();
  try {
    await settingService().setSetting(READ_HOLD_KEY, JSON.stringify(state));
  } catch {
    // The in-memory hold still applies for this process; the next write retries.
  }
}

/** Restore the persisted hold, once per process. Runs inside hydrateAllStores'
 *  Promise.all and at the background entry points, so it never rejects. */
export async function hydrateReadHold(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await settingService().getSetting(READ_HOLD_KEY);
    if (!raw) {
      loaded = true;
      return;
    }
    const parsed = JSON.parse(raw) as Partial<State>;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    state = {
      resetAt: num(parsed.resetAt),
      holdUntil: num(parsed.holdUntil),
      used: num(parsed.used),
      usedDay: typeof parsed.usedDay === 'string' ? parsed.usedDay : null,
      updatedAt: num(parsed.updatedAt),
    };
    loaded = true;
    emit();
  } catch {
    // Unreadable row: no hold is the safe reading; the next 429 restores it.
  }
}

/** Memory only. Called from clearAllStores on an account switch (the wipe
 *  resets the settings row itself). */
export function resetReadHold(): void {
  state = { ...EMPTY };
  loaded = false;
  emit();
}
