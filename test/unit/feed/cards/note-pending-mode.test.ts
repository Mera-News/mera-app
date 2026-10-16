// notePendingMode: the ONE rule for what a scored row with no note shows.
// reason_pending always writes (the orphaned-reasons sweep always brings the
// note); under the cloud reading hold it says when instead.
import { notePendingMode } from '@/components/custom/cards/note-pending-mode';
import { ArticleSuggestionStatus as S } from '@/lib/database/article-suggestion-status';

describe('notePendingMode', () => {
  it('is writing for a pending row with no note, whatever any in-flight set says', () => {
    expect(notePendingMode({ status: S.ReasonPending, reason: '' }, false)).toBe('writing');
  });
  it('is held for a pending row while the reading hold is set', () => {
    expect(notePendingMode({ status: S.ReasonPending, reason: '' }, true)).toBe('held');
  });
  it.each([
    ['reason_skipped', { status: S.ReasonSkipped, reason: '' }],
    ['complete', { status: S.Complete, reason: '' }],
    ['unscored', { status: S.Unscored, reason: '' }],
    ['no status', { status: undefined, reason: '' }],
    ['a pending row that has its note', { status: S.ReasonPending, reason: 'Done.' }],
  ])('is undefined for %s', (_name, row) => {
    expect(notePendingMode(row as never, false)).toBeUndefined();
    expect(notePendingMode(row as never, true)).toBeUndefined();
  });
});
