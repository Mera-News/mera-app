// article-suggestion-diagnostics behind the Observability screen: the shared-note breakdown
// (is a note copied between articles, i.e. propagation?) and the scoring-mode breakdown. Real rows,
// real writers. Replaces the getSharedNoteBreakdown block of
// lib/database/services/__tests__/article-suggestion-service.test.ts.
import {
  batchPropagateScores,
  saveReason,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-scoring-writes';
import {
  getScoringModeBreakdown,
  getSharedNoteBreakdown,
} from '@/lib/database/services/article-suggestion-diagnostics';
import { article, freezeClock, seed, toComplete, toReasonPending } from './support';

beforeEach(() => freezeClock());

// Propagation is the ONLY writer that copies a note verbatim between articles, so a shared string is
// its fingerprint; a decode shift or a model echoing its prompt produces a sentence that exists once.
describe('getSharedNoteBreakdown', () => {
  const copied = 'The Hormuz closure raises what you pay at the pump.';
  const hormuz = (id: string, title: string) => article(id, { title_en: title, description_en: 'Hormuz closure' });

  it('reports nothing shared when every note is unique', async () => {
    await seed([article('a'), article('b')]);
    await toComplete('a', 0.8, 'One harbour note');
    await toComplete('b', 0.8, 'Another harbour note');

    expect(await getSharedNoteBreakdown()).toEqual({
      rowsWithNote: 2,
      distinctNotes: 2,
      sharedNoteGroups: 0,
      rowsSharingANote: 0,
      largestGroupSize: 0,
      largestGroup: null,
    });
  });

  it('finds a note propagated across articles and names the group', async () => {
    await seed([hormuz('a', 'Strait closed'), hormuz('b', 'Tanker traffic halts'), article('c')]);
    await batchPropagateScores([
      { id: 'a', relevance: 0.8, reason: copied },
      { id: 'b', relevance: 0.8, reason: copied },
    ]);
    await toComplete('c', 0.8, 'Its own harbour note');

    const r = await getSharedNoteBreakdown();

    expect(r).toMatchObject({ rowsWithNote: 3, distinctNotes: 2, sharedNoteGroups: 1, rowsSharingANote: 2, largestGroupSize: 2 });
    expect(r.largestGroup?.note).toBe(copied);
    expect([...r.largestGroup!.titles].sort()).toEqual(['Strait closed', 'Tanker traffic halts']);
  });

  it('treats whitespace-only notes as absent rather than as one shared group', async () => {
    await seed([article('a'), article('b')]);
    await saveReason('a', '   ');
    await saveReason('b', '   ');

    const r = await getSharedNoteBreakdown();

    expect(r.sharedNoteGroups).toBe(0);
    expect(r.largestGroup).toBeNull();
  });

  it('returns the zeroed shape when no row carries a note', async () => {
    expect(await getSharedNoteBreakdown()).toEqual({
      rowsWithNote: 0,
      distinctNotes: 0,
      sharedNoteGroups: 0,
      rowsSharingANote: 0,
      largestGroupSize: 0,
      largestGroup: null,
    });
    await seed([article('a')]);
    await toReasonPending('a');
    expect((await getSharedNoteBreakdown()).rowsWithNote).toBe(0);
  });

  it('truncates the sampled note and titles so the share payload stays bounded', async () => {
    const longNote = `harbour ${'n'.repeat(300)}`;
    const longTitle = `Harbour ${'t'.repeat(300)}`;
    await seed([article('a', { title_en: longTitle }), article('b', { title_en: longTitle })]);
    await batchPropagateScores([
      { id: 'a', relevance: 0.8, reason: longNote },
      { id: 'b', relevance: 0.8, reason: longNote },
    ]);

    const r = await getSharedNoteBreakdown();

    expect(r.largestGroup!.note).toHaveLength(120);
    expect(r.largestGroup!.titles[0]).toHaveLength(80);
  });

  it('caps the sampled group at six members however large it really is', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `s${i}`);
    await seed(ids.map((id) => article(id)));
    await batchPropagateScores(ids.map((id) => ({ id, relevance: 0.8, reason: 'Same harbour sentence everywhere' })));

    const r = await getSharedNoteBreakdown();

    // the COUNT is honest about all nine; only the eyeball sample is capped
    expect(r).toMatchObject({ largestGroupSize: 9, rowsSharingANote: 9 });
    expect(r.largestGroup!.titles).toHaveLength(6);
  });

  it('names the biggest of several groups', async () => {
    await seed(['a', 'b', 'c', 'd', 'e'].map((id) => article(id)));
    await batchPropagateScores([
      { id: 'a', relevance: 0.8, reason: 'Small harbour group' },
      { id: 'b', relevance: 0.8, reason: 'Small harbour group' },
      { id: 'c', relevance: 0.8, reason: 'Big harbour group' },
      { id: 'd', relevance: 0.8, reason: 'Big harbour group' },
      { id: 'e', relevance: 0.8, reason: 'Big harbour group' },
    ]);

    const r = await getSharedNoteBreakdown();

    expect(r).toMatchObject({ sharedNoteGroups: 2, rowsSharingANote: 5, largestGroupSize: 3 });
    expect(r.largestGroup?.note).toBe('Big harbour group');
  });
});

describe('getScoringModeBreakdown', () => {
  const score = (id: string, scoreComponentsJson?: string) =>
    saveScoringResult(id, { relevance: 0.7, reason: '', reasonSkipped: true, scoreComponentsJson });

  it('is all zero on a fresh device', async () => {
    expect(await getScoringModeBreakdown()).toEqual({ math: 0, backstop: 0, unknown: 0 });
  });

  it('counts scored rows by the mode recorded in their audit blob', async () => {
    await seed(['m1', 'm2', 'b1', 'noblob', 'bad', 'othermode', 'unscored'].map((id) => article(id)));
    await score('m1', '{"mode":"math"}');
    await score('m2', '{"mode":"math"}');
    await score('b1', '{"mode":"backstop"}');
    await score('noblob');
    await score('bad', 'not json');
    await score('othermode', '{"mode":"judge"}');

    // math / backstop name the routing; a missing, unparseable or unknown blob is reported, not folded in;
    // a row that was never scored is not counted at all
    expect(await getScoringModeBreakdown()).toEqual({ math: 2, backstop: 1, unknown: 3 });
  });
});
