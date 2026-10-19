// What the encryption strip draws: the displayed-state reducer, playback,
// rest, the mark and the colour filters. Pure, no render.
// tokens pulls the theme store, which needs AsyncStorage at import.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
import {
  MARK_DIM_OPACITY,
  flatten,
  initStripDisplay,
  markFor,
  markLayout,
  reduceStripDisplay,
  stripColorFilters,
  stripPlayback,
  stripRests,
  type StripDisplay,
  type StripEvent,
  type StripFileId,
} from '@/components/custom/chat/strip-display';
import { COLORS } from '@/lib/theme/tokens';
import { CHAT_DEVICE_SCREEN_BOX, CHAT_STRIP_MARK_BOX } from '@/components/custom/chat/animation-registry';
import type { StripState } from '@/lib/services/chat-phase';

const target = (state: StripState | null, sealedSeq: number, motion = true): StripEvent => ({
  type: 'target',
  state,
  sealedSeq,
  motion,
});
const run = (s: StripDisplay, ...events: StripEvent[]) => events.reduce(reduceStripDisplay, s);

describe('reduceStripDisplay', () => {
  it('owes the letter when securing and thinking land in one tick', () => {
    // A warm buffered leg: the store already says think, with a new seal.
    const s = run(initStripDisplay('phone', 4), target('think', 5));
    expect(s).toMatchObject({ shown: 'secure', playing: true, owed: 'think' });
    expect(run(s, { type: 'finished' })).toMatchObject({ shown: 'think', playing: false, owed: null });
  });

  it('owes nothing for a seal it saw before it mounted', () => {
    expect(run(initStripDisplay('think', 7), target('think', 7))).toMatchObject({ shown: 'think', playing: false });
  });

  it('never compares the monotonic seq to zero: a later turn still owes its letter', () => {
    const s = run(initStripDisplay('phone', 41), target('think', 42));
    expect(s.shown).toBe('secure');
  });

  it('holds a one-shot until it finishes, then shows the newest target', () => {
    const s = run(initStripDisplay('phone', 0), target('secure', 1), target('think', 1), target('phone', 1));
    expect(s).toMatchObject({ shown: 'secure', playing: true, owed: 'phone' });
    expect(run(s, { type: 'finished' }).shown).toBe('phone');
  });

  it('lets a newer one-shot cut in (attest is cut by secure)', () => {
    const s = run(initStripDisplay('phone', 0), target('attest', 1), target('secure', 2));
    expect(s).toMatchObject({ shown: 'secure', playing: true });
  });

  it('a repeated one-shot without a new seal changes nothing', () => {
    const s = run(initStripDisplay('phone', 0), target('secure', 1));
    expect(run(s, target('secure', 1))).toBe(s);
  });

  it('release cuts in, even over a playing one-shot', () => {
    const s = run(initStripDisplay('phone', 0), target('secure', 1), target(null, 1));
    expect(s).toMatchObject({ shown: null, playing: false, owed: null });
  });

  it('return plays, then hands back to what the store said', () => {
    const s = run(initStripDisplay('think', 3), { type: 'return', motion: true });
    expect(s).toMatchObject({ shown: 'return', playing: true, owed: 'think' });
    expect(run(s, { type: 'finished' }).shown).toBe('think');
  });

  it('motion off swaps instantly and owes nothing, and return is a no-op', () => {
    const s = run(initStripDisplay('phone', 0), target('think', 1, false));
    expect(s).toMatchObject({ shown: 'think', playing: false, owed: null, seq: 1 });
    expect(run(s, { type: 'return', motion: false })).toBe(s);
  });

  it('finished while nothing plays is a no-op', () => {
    const s = initStripDisplay('think', 0);
    expect(run(s, { type: 'finished' })).toBe(s);
  });
});

describe('stripRests', () => {
  it.each([
    [false, false, false, false],
    [true, false, false, true],
    [false, true, false, true],
    [false, false, true, true],
  ])('liveTool %s, landing %s, ackStreaming %s -> %s', (liveTool, landing, ackStreaming, rests) => {
    expect(stripRests({ liveTool, landing, ackStreaming })).toBe(rests);
  });
});

describe('stripPlayback', () => {
  const has = (id: StripFileId) => id;
  const none = () => null;

  it('motion off draws the svg resting strip, never Lottie', () => {
    expect(stripPlayback('think', { motion: false, rest: false, playing: false }, has)).toEqual({ kind: 'svg', device: false });
    expect(stripPlayback('deviceThinking', { motion: false, rest: false, playing: false }, has)).toEqual({ kind: 'svg', device: true });
  });

  it('a missing file draws the svg resting strip', () => {
    expect(stripPlayback('secure', { motion: true, rest: false, playing: true }, none)).toEqual({ kind: 'svg', device: false });
  });

  it('a playing one-shot plays once; a finished one rests on its last frame', () => {
    expect(stripPlayback('secure', { motion: true, rest: false, playing: true }, has)).toMatchObject({ id: 'secure', loop: false, autoPlay: true });
    expect(stripPlayback('secure', { motion: true, rest: false, playing: false }, has)).toMatchObject({ autoPlay: false, progress: 1 });
  });

  it('a loop runs unless the strip rests, and rests on frame 0', () => {
    expect(stripPlayback('think', { motion: true, rest: false, playing: false }, has)).toMatchObject({ loop: true, autoPlay: true });
    expect(stripPlayback('phone', { motion: true, rest: true, playing: false }, has)).toMatchObject({ autoPlay: false, progress: 0 });
  });

  it('the device file runs only while the model loads', () => {
    expect(stripPlayback('deviceLoading', { motion: true, rest: false, playing: false }, has)).toMatchObject({ id: 'device', autoPlay: true });
    expect(stripPlayback('deviceThinking', { motion: true, rest: false, playing: false }, has)).toMatchObject({ id: 'device', autoPlay: false, progress: 0 });
    expect(stripPlayback('devicePreparing', { motion: true, rest: false, playing: false }, has)).toMatchObject({ id: 'device', autoPlay: false, progress: 0 });
  });

  it('a released strip still draws the phone at rest', () => {
    expect(stripPlayback(null, { motion: true, rest: false, playing: false }, has)).toMatchObject({ id: 'phone' });
  });
});

describe('markFor', () => {
  it('sweeps the cone only while the model reads and the strip moves', () => {
    expect(markFor('think', false)).toEqual({ place: 'model', animated: true, opacity: 1 });
    expect(markFor('think', true).animated).toBe(false);
    expect(markFor('secure', false).animated).toBe(false);
    expect(markFor('return', false).animated).toBe(false);
  });

  it('dims the model end while only the phone works', () => {
    expect(markFor('phone', false).opacity).toBe(MARK_DIM_OPACITY);
    expect(markFor(null, false).opacity).toBe(MARK_DIM_OPACITY);
  });

  it('sits on the phone screen on device, sweeping only while it thinks', () => {
    expect(markFor('deviceThinking', false)).toEqual({ place: 'phone', animated: true, opacity: 1 });
    expect(markFor('deviceLoading', false)).toEqual({ place: 'phone', animated: false, opacity: 1 });
  });
});

describe('stripColorFilters', () => {
  it('flattens a translucent colour over its ground', () => {
    expect(flatten('rgba(255,255,255,0.5)', '#000000')).toBe('#808080');
    expect(flatten('#E78A53', '#FFFFFF')).toBe('#E78A53');
    expect(flatten('rgb(11,10,12)', '#000000')).toBe('#0B0A0C');
  });

  it('gives exactly ink, ink3 and accent, all opaque, in both themes and on both hosts', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const host of ['row', 'box'] as const) {
        const filters = stripColorFilters(COLORS[mode], host);
        expect(filters.map((f) => f.keypath)).toEqual(['ink', 'ink3', 'accent']);
        for (const f of filters) expect(f.color).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it('flattens over the box surface for the header, so the ground differs', () => {
    const row = stripColorFilters(COLORS.dark, 'row');
    const box = stripColorFilters(COLORS.dark, 'box');
    expect(box[1].color).not.toBe(row[1].color);
  });
});

describe('markLayout', () => {
  it('puts the mark at the model end, as tall as the phone, at full width', () => {
    const at = markLayout(CHAT_STRIP_MARK_BOX, 272);
    expect(at.size).toBeCloseTo(30);
    expect(at.left + at.size / 2).toBeCloseTo(255);
    expect(at.top).toBeCloseTo(1);
  });

  it('scales with a narrower strip, centred in the 32pt height', () => {
    const at = markLayout(CHAT_STRIP_MARK_BOX, 136);
    expect(at.size).toBeCloseTo(15);
    expect(at.top + at.size / 2).toBeCloseTo(16);
  });

  it('never draws a 0pt mark when the strip measured 0 wide (a parent with no width)', () => {
    // The wait row once shrink-wrapped its content: onLayout gave 0 and the mark vanished.
    expect(markLayout(CHAT_STRIP_MARK_BOX, 0).size).toBeCloseTo(30);
    expect(markLayout(CHAT_DEVICE_SCREEN_BOX, 0).size).toBeCloseTo(19.8);
  });

  it('sits on the phone screen on device', () => {
    const at = markLayout(CHAT_DEVICE_SCREEN_BOX, 28);
    expect(at.left + at.size / 2).toBeCloseTo(14);
    expect(at.top + at.size / 2).toBeCloseTo(15);
  });
});
