import { dropNearDuplicates, isNearDuplicate } from '@/lib/news-harness/on-device/follow-story/near-duplicates';

const o = (label: string, search = label.toLowerCase()) => ({ label, search });

describe('isNearDuplicate', () => {
  it.each([
    // AFM's facet cards: one story, a facet word bolted on.
    ['Pune Metro Line 3 Expansion Plans', 'Pune Metro Line 3 Development Timeline'],
    ['Pune Metro Line 3 Development Timeline', 'Pune Metro Line 3 Project Progress'],
    ['Assam Floods', 'Assam Floods Latest Updates'],
    ['Dutch Cabinet Formation Talks', 'Dutch Cabinet Formation Delays'],
  ])('%s ~ %s', (a, b) => {
    expect(isNearDuplicate(o(a), o(b))).toBe(true);
  });

  it('the same search is a duplicate whatever the labels say', () => {
    expect(isNearDuplicate(o('Gaza Truce', 'gaza ceasefire talks'), o('Ceasefire Negotiations', 'Gaza ceasefire  talks'))).toBe(true);
  });

  it.each([
    // Narrow event to broad story: distinct stories, kept.
    ['Ajax vs PSV Match', 'Eredivisie Title Race'],
    ['Barcelona Rail Strikes', 'Spain Rail Strikes'],
    ['Raptors Trade Deadline', 'Raptors Rebuild'],
    ['Latest News', 'Updates'],
  ])('%s is not %s', (a, b) => {
    expect(isNearDuplicate(o(a), o(b))).toBe(false);
  });
});

describe('dropNearDuplicates', () => {
  it('keeps the first of each near-copy, in order', () => {
    const out = dropNearDuplicates([
      o('Pune Metro Line 3 Construction'),
      o('Pune Metro Line 3 Expansion Plans'),
      o('Maharashtra Metro Funding'),
      o('Pune Metro Line 3 Project Progress'),
    ]);
    expect(out.map((x) => x.label)).toEqual(['Pune Metro Line 3 Construction', 'Maharashtra Metro Funding']);
  });

  it('never drops a protected head row, and drops a later row that copies one', () => {
    const out = dropNearDuplicates([o('the floods in assam'), o('Assam Floods'), o('Assam Floods Updates'), o('Brahmaputra Dams')], 2);
    expect(out.map((x) => x.label)).toEqual(['the floods in assam', 'Assam Floods', 'Brahmaputra Dams']);
  });
});

