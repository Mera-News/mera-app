// The not-read line: the plain line, or why Mera skipped the article and when
// it reads again while the reading hold is set (owner).
import { notReadLineKey } from '@/components/custom/cards/not-read-line';

const H = 3_600_000;
/** Local noon, so today and tomorrow cannot flip under the test. */
const NOON = new Date(2026, 9, 15, 12, 0, 0).getTime();

describe('notReadLineKey', () => {
  it('is the plain line when not held (on-device reading is never held)', () => {
    expect(notReadLineKey({ held: false, resetAt: NOON + 2 * H, now: NOON })).toBe('feed.notRead.line');
  });
  it('names today when the reset falls on the phone\'s date today', () => {
    expect(notReadLineKey({ held: true, resetAt: NOON + 2 * H, now: NOON })).toBe('feed.notRead.heldToday');
  });
  it('names tomorrow when the reset falls on the next local date', () => {
    expect(notReadLineKey({ held: true, resetAt: NOON + 18 * H, now: NOON })).toBe('feed.notRead.heldTomorrow');
  });
  it('falls back to the plain line when held without a reset instant', () => {
    expect(notReadLineKey({ held: true, resetAt: null, now: NOON })).toBe('feed.notRead.line');
  });
});
