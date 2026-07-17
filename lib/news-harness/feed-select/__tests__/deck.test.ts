// feed-select/deck — swipe-deck insertion contract tests (Wave 7b-core M-P5b).

import { insertChunkIntoDeck, type DeckCard } from '../deck';

function card(o: Partial<DeckCard> & { id: string }): DeckCard {
  return {
    bucket: o.bucket ?? 'MEDIUM',
    rawScore: o.rawScore ?? 0.6,
    pubDateMs: o.pubDateMs ?? 1_000,
    state: o.state,
    id: o.id,
  };
}

describe('insertChunkIntoDeck', () => {
  it('never repositions seen/current; newcomers land in the unread region only', () => {
    const deck: DeckCard[] = [
      card({ id: 'seen1', state: 'seen', bucket: 'LOW', rawScore: 0.4 }),
      card({ id: 'cur', state: 'current', bucket: 'LOW', rawScore: 0.4 }),
      card({ id: 'u1', state: 'unread', bucket: 'MEDIUM', rawScore: 0.6 }),
    ];
    // An EMERGENCY newcomer must land directly after the current card, above
    // unread — but never above seen/current.
    const chunk: DeckCard[] = [card({ id: 'emg', bucket: 'EMERGENCY', rawScore: 1.1 })];
    const next = insertChunkIntoDeck(deck, chunk);
    expect(next.map((c) => c.id)).toEqual(['seen1', 'cur', 'emg', 'u1']);
    // frozen prefix untouched.
    expect(next[0].state).toBe('seen');
    expect(next[1].state).toBe('current');
    // newcomer marked unread.
    expect(next[2].state).toBe('unread');
  });

  it('orders unread by bucket desc → rawScore desc → pubDate desc → id', () => {
    const deck: DeckCard[] = [card({ id: 'cur', state: 'current' })];
    const chunk: DeckCard[] = [
      card({ id: 'lowA', bucket: 'LOW', rawScore: 0.4, pubDateMs: 5 }),
      card({ id: 'highA', bucket: 'HIGH', rawScore: 0.8, pubDateMs: 1 }),
      card({ id: 'medNew', bucket: 'MEDIUM', rawScore: 0.6, pubDateMs: 9 }),
      card({ id: 'medOld', bucket: 'MEDIUM', rawScore: 0.6, pubDateMs: 2 }),
    ];
    const next = insertChunkIntoDeck(deck, chunk);
    expect(next.map((c) => c.id)).toEqual([
      'cur',
      'highA', // HIGH bucket first
      'medNew', // MEDIUM, newer pubDate before medOld
      'medOld',
      'lowA', // LOW last
    ]);
  });

  it('breaks pubDate ties by id ascending', () => {
    const deck: DeckCard[] = [];
    const chunk: DeckCard[] = [
      card({ id: 'zeta', bucket: 'MEDIUM', rawScore: 0.6, pubDateMs: 100 }),
      card({ id: 'alpha', bucket: 'MEDIUM', rawScore: 0.6, pubDateMs: 100 }),
    ];
    const next = insertChunkIntoDeck(deck, chunk);
    expect(next.map((c) => c.id)).toEqual(['alpha', 'zeta']);
  });

  it('inserts a mid-bucket newcomer between existing unread cards (re-sort == insert)', () => {
    const deck: DeckCard[] = [
      card({ id: 'cur', state: 'current' }),
      card({ id: 'hi', state: 'unread', bucket: 'HIGH', rawScore: 0.8 }),
      card({ id: 'lo', state: 'unread', bucket: 'LOW', rawScore: 0.4 }),
    ];
    const chunk: DeckCard[] = [card({ id: 'mid', bucket: 'MEDIUM', rawScore: 0.6 })];
    const next = insertChunkIntoDeck(deck, chunk);
    expect(next.map((c) => c.id)).toEqual(['cur', 'hi', 'mid', 'lo']);
  });

  it('dedups chunk cards already present in the deck (by id)', () => {
    const deck: DeckCard[] = [
      card({ id: 'cur', state: 'current' }),
      card({ id: 'dup', state: 'unread', bucket: 'HIGH', rawScore: 0.8 }),
    ];
    const chunk: DeckCard[] = [
      card({ id: 'dup', bucket: 'EMERGENCY', rawScore: 1.1 }), // ignored
      card({ id: 'fresh', bucket: 'MEDIUM', rawScore: 0.6 }),
    ];
    const next = insertChunkIntoDeck(deck, chunk);
    expect(next.map((c) => c.id)).toEqual(['cur', 'dup', 'fresh']);
    // the existing 'dup' keeps its HIGH bucket (not upgraded by the dropped card).
    expect(next.find((c) => c.id === 'dup')!.bucket).toBe('HIGH');
  });

  it('dedups duplicate ids within a single chunk', () => {
    const next = insertChunkIntoDeck(
      [],
      [
        card({ id: 'x', bucket: 'HIGH', rawScore: 0.8 }),
        card({ id: 'x', bucket: 'LOW', rawScore: 0.4 }),
      ],
    );
    expect(next.map((c) => c.id)).toEqual(['x']);
    expect(next[0].bucket).toBe('HIGH'); // first occurrence wins
  });

  it('is pure — does not mutate its inputs', () => {
    const deck: DeckCard[] = [card({ id: 'cur', state: 'current' })];
    const chunk: DeckCard[] = [card({ id: 'n', bucket: 'HIGH', rawScore: 0.8 })];
    const deckCopy = deck.map((c) => ({ ...c }));
    const chunkCopy = chunk.map((c) => ({ ...c }));
    insertChunkIntoDeck(deck, chunk);
    expect(deck).toEqual(deckCopy);
    expect(chunk).toEqual(chunkCopy);
  });

  it('releases in order across two chunks, preserving already-placed unread', () => {
    const deck0: DeckCard[] = [card({ id: 'cur', state: 'current' })];
    const deck1 = insertChunkIntoDeck(deck0, [
      card({ id: 'a', bucket: 'MEDIUM', rawScore: 0.6, pubDateMs: 5 }),
    ]);
    const deck2 = insertChunkIntoDeck(deck1, [
      card({ id: 'b', bucket: 'HIGH', rawScore: 0.8, pubDateMs: 1 }),
      card({ id: 'c', bucket: 'LOW', rawScore: 0.4, pubDateMs: 9 }),
    ]);
    // b (HIGH) jumps above a (MEDIUM); c (LOW) sinks below.
    expect(deck2.map((c) => c.id)).toEqual(['cur', 'b', 'a', 'c']);
  });
});
