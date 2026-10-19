// What the encryption strip draws, as pure functions. No React, no RN.
//
// The phase store says what is TRUE now (`stripStateFor`). The strip cannot
// simply draw that: a one-shot (attest, secure, retry, return) must finish
// before the next state replaces it, and a warm buffered leg publishes
// `securing` and `thinking` in one tick, so the letter would never be seen
// crossing. `sealedSeq` (monotonic, never reset) says "a new seal happened";
// the reducer owes one `secure` per change it observes, whatever it is shown.

import type { StripState } from '@/lib/services/chat-phase';
import { chatStripAnimationFor } from './animation-registry';
import type { ThemeColors } from '@/lib/theme/tokens';

/** What the strip can draw: the store's states plus the UI-played `return`. */
export type DrawnStrip = StripState | 'return';

const ONE_SHOTS: ReadonlySet<DrawnStrip> = new Set(['attest', 'secure', 'retry', 'return']);

export function isOneShot(state: DrawnStrip): boolean {
  return ONE_SHOTS.has(state);
}

export interface StripDisplay {
  /** What is drawn. Null: released. */
  readonly shown: DrawnStrip | null;
  /** A one-shot is mid-play and holds until it finishes. */
  readonly playing: boolean;
  /** The target to show once the playing one-shot finishes. */
  readonly owed: DrawnStrip | null;
  /** The last `sealedSeq` observed. */
  readonly seq: number;
}

export type StripEvent =
  /** The store moved. `motion` is `useMotionAllowed()`. */
  | { type: 'target'; state: StripState | null; sealedSeq: number; motion: boolean }
  /** The UI plays `return` once (an answer was decrypted). */
  | { type: 'return'; motion: boolean }
  /** The playing one-shot reached its last frame. */
  | { type: 'finished' };

/** A strip that mounts mid-turn owes nothing: the seal it sees is old. */
export function initStripDisplay(state: StripState | null, sealedSeq: number): StripDisplay {
  return { shown: state, playing: false, owed: null, seq: sealedSeq };
}

export function reduceStripDisplay(s: StripDisplay, e: StripEvent): StripDisplay {
  if (e.type === 'finished') {
    if (!s.playing) return s;
    return { ...s, shown: s.owed ?? s.shown, playing: false, owed: null };
  }
  if (e.type === 'return') {
    // Motion off: no hold at all, the caller moves on at once.
    if (!e.motion) return s;
    return { ...s, shown: 'return', playing: true, owed: s.owed ?? s.shown };
  }

  const newSeal = e.sealedSeq !== s.seq;
  const seq = e.sealedSeq;
  // Motion off swaps instantly and owes nothing.
  if (!e.motion) return { shown: e.state, playing: false, owed: null, seq };
  // Release cuts in.
  if (e.state === null) return { shown: null, playing: false, owed: null, seq };

  if (isOneShot(e.state)) {
    // A newer one-shot cuts in; the same one repeated without a new seal is a no-op.
    if (e.state === s.shown && !newSeal) return s;
    return { shown: e.state, playing: true, owed: null, seq };
  }
  // A seal the strip never drew (securing and thinking in one tick): the
  // letter crosses first, then the model reads.
  if (newSeal && e.state === 'think') {
    return { shown: 'secure', playing: true, owed: 'think', seq };
  }
  if (s.playing) return { ...s, owed: e.state, seq };
  if (e.state === s.shown && s.seq === seq) return s;
  return { ...s, shown: e.state, seq };
}

/** The strip rests (holds its resting frame) while something else moves:
 *  a step glyph loops, rows land, or the acknowledgement streams. */
export function stripRests(input: {
  liveTool: boolean;
  landing: boolean;
  ackStreaming: boolean;
}): boolean {
  return input.liveTool || input.landing || input.ackStreaming;
}

export type StripFileId = 'phone' | 'attest' | 'secure' | 'think' | 'retry' | 'return' | 'device';

export type StripPlayback =
  /** The react-native-svg resting strip: motion off, or no file on disk yet. */
  | { kind: 'svg'; device: boolean }
  | { kind: 'lottie'; id: StripFileId; device: boolean; loop: boolean; autoPlay: boolean; progress?: number };

function fileIdFor(state: DrawnStrip): StripFileId {
  return state === 'devicePreparing' || state === 'deviceLoading' || state === 'deviceThinking'
    ? 'device'
    : state;
}

export function stripPlayback(
  shown: DrawnStrip | null,
  opts: { motion: boolean; rest: boolean; playing: boolean },
  sourceFor: (id: StripFileId) => unknown | null = chatStripAnimationFor,
): StripPlayback {
  // Released while still mounted: the phone at rest, never a blank slot.
  const state: DrawnStrip = shown ?? 'phone';
  const id = fileIdFor(state);
  const device = id === 'device';
  if (!opts.motion || sourceFor(id) === null) return { kind: 'svg', device };
  if (isOneShot(state)) {
    return opts.playing
      ? { kind: 'lottie', id, device, loop: false, autoPlay: true }
      : { kind: 'lottie', id, device, loop: false, autoPlay: false, progress: 1 };
  }
  // The device file plays only while the model loads; frame 0 otherwise.
  const runs = !opts.rest && (device ? state === 'deviceLoading' : true);
  return runs
    ? { kind: 'lottie', id, device, loop: true, autoPlay: true }
    : { kind: 'lottie', id, device, loop: true, autoPlay: false, progress: 0 };
}

export interface MarkPlacement {
  /** At the model end of the line (cloud) or on the phone's screen (device). */
  place: 'model' | 'phone';
  /** The cone sweeps. `MeraLogo`'s own gate still applies (Lite, Reduce Motion). */
  animated: boolean;
  opacity: number;
}

/** Dim the model end while only the phone works. */
export const MARK_DIM_OPACITY = 0.35;

export function markFor(shown: DrawnStrip | null, rest: boolean): MarkPlacement {
  const state: DrawnStrip = shown ?? 'phone';
  if (fileIdFor(state) === 'device') {
    return { place: 'phone', animated: state === 'deviceThinking' && !rest, opacity: 1 };
  }
  return {
    place: 'model',
    animated: state === 'think' && !rest,
    opacity: state === 'phone' ? MARK_DIM_OPACITY : 1,
  };
}

// ── Colours ─────────────────────────────────────────────────────────────────
// Android applies colour filters SRC_ATOP, so a translucent filter blends with
// the authored colour. Every filter is therefore OPAQUE: the token flattened
// over the surface the strip sits on. Exactly three entries: one bad entry
// drops the rest on iOS.

type Rgba = [number, number, number, number];

export function parseColor(input: string): Rgba {
  const s = input.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
  throw new Error(`[strip-display] unparseable colour ${input}`);
}

/** `fg` composited over an opaque `bg`, as `#rrggbb`. */
export function flatten(fg: string, bg: string): string {
  const [fr, fg2, fb, fa] = parseColor(fg);
  const [br, bg2, bb] = parseColor(bg);
  const mix = (f: number, b: number) => Math.round(f * fa + b * (1 - fa));
  return `#${[mix(fr, br), mix(fg2, bg2), mix(fb, bb)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** The wait row sits on the panel's base; the box header on the box surface. */
export type StripHost = 'row' | 'box';

export function stripColorFilters(c: ThemeColors, host: StripHost): { keypath: 'ink' | 'ink3' | 'accent'; color: string }[] {
  const ground = host === 'box' ? flatten(c.surface, c.modalBase) : flatten(c.modalBase, '#000000');
  return [
    { keypath: 'ink', color: flatten(c.ink2, ground) },
    { keypath: 'ink3', color: flatten(c.ink3, ground) },
    { keypath: 'accent', color: flatten(c.accentMark, ground) },
  ];
}
