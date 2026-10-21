// notePendingMode: the ONE rule for what a scored row with no note shows.
// reason_pending always writes (the orphaned-reasons sweep always brings the
// note); under the cloud reading hold it says when instead.
import { noteBoxState, notePendingMode, showsBelowGate, showsChipOnly } from '@/components/custom/cards/note-pending-mode';
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

describe('showsChipOnly', () => {
  it('is true for a complete row with a relevance and no note, in either mode (Skip notes, D42)', () => {
    expect(showsChipOnly({ status: S.Complete, reason: '', relevance: 0.6 })).toBe(true);
  });
  it.each([
    ['a row with its note', { status: S.Complete, reason: 'Why.', relevance: 0.6 }],
    ['a complete row with no relevance', { status: S.Complete, reason: '', relevance: 0 }],
    ['a pending row (it shows writing)', { status: S.ReasonPending, reason: '', relevance: 0.6 }],
    ['reason_skipped (its fact chips show)', { status: S.ReasonSkipped, reason: '', relevance: 0.6 }],
    ['unscored', { status: S.Unscored, reason: '', relevance: 0 }],
  ])('is false for %s', (_name, row) => {
    expect(showsChipOnly(row as never)).toBe(false);
  });
});

describe('noteBoxState', () => {
  it.each([
    ['writing', false, 'writing'],
    ['writing', true, 'writing'],
    ['held', false, 'paused'],
    ['held', true, 'paused'],
    [undefined, true, 'off'],
    [undefined, false, 'failed'],
  ] as const)('pending %p, skip notes %p -> %p', (pending, skip, state) => {
    expect(noteBoxState(pending, skip)).toBe(state);
  });
  it('a row Mera discarded (below the gate) says so, never failed, Skip notes on or off', () => {
    expect(noteBoxState(undefined, false, true)).toBe('discarded');
    expect(noteBoxState(undefined, true, true)).toBe('discarded');
  });
});

describe('showsBelowGate', () => {
  it.each([
    ['a complete row below the gate', { status: S.Complete, reason: '', relevance: 0.2 }],
    ['an ineligible row (relevance 0)', { status: S.Complete, reason: '', relevance: 0 }],
    ['reason_skipped below the gate', { status: S.ReasonSkipped, reason: '', relevance: 0.3 }],
  ])('is true for %s', (_name, row) => {
    expect(showsBelowGate(row as never)).toBe(true);
  });
  it.each([
    ['a pick with no note (Skip notes)', { status: S.Complete, reason: '', relevance: 0.6 }],
    ['a row at the gate', { status: S.Complete, reason: '', relevance: 0.4 }],
    ['a pending row', { status: S.ReasonPending, reason: '', relevance: 0.2 }],
    ['unscored', { status: S.Unscored, reason: '', relevance: 0 }],
    ['excluded', { status: S.Excluded, reason: '', relevance: 0 }],
    ['a row with a note', { status: S.Complete, reason: 'Why.', relevance: 0.2 }],
  ])('is false for %s', (_name, row) => {
    expect(showsBelowGate(row as never)).toBe(false);
  });
});
