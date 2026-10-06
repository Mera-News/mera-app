import {
  addCountry,
  dropIndexFor,
  filterAddable,
  initialArrange,
  moveItem,
  removePage,
  reorder,
  slotToIndex,
  toDraft,
} from '../arrange-model';

const FR = { alpha2: 'fr', name: 'France' };

describe('arrange draft', () => {
  it('reorders without touching removed or added', () => {
    const s = reorder(initialArrange(['feed', 'interests', 'stories']), 2, 0);
    expect(toDraft(s)).toEqual({ order: ['stories', 'feed', 'interests'], removed: [], added: [] });
  });

  it('records a removal and drops it from the order', () => {
    const s = removePage(initialArrange(['world', 'country:DE']), 'country:DE');
    expect(toDraft(s)).toEqual({ order: ['world'], removed: ['country:DE'], added: [] });
  });

  it('adds a country as an alpha-2 page at the end', () => {
    const s = addCountry(initialArrange(['world']), FR);
    expect(toDraft(s)).toEqual({ order: ['world', 'country:FR'], removed: [], added: ['FR'] });
  });

  it('adding then removing in one draft leaves nothing behind', () => {
    const s = removePage(addCountry(initialArrange(['world']), FR), 'country:FR');
    expect(toDraft(s)).toEqual({ order: ['world'], removed: [], added: [] });
  });

  it('removing then re-adding an existing country cancels the removal', () => {
    const s = addCountry(removePage(initialArrange(['world', 'country:FR']), 'country:FR'), FR);
    expect(toDraft(s)).toEqual({ order: ['world', 'country:FR'], removed: [], added: [] });
  });

  it('search excludes countries already in the draft, added ones included', () => {
    const s = addCountry(initialArrange(['world', 'country:DE']), FR);
    const opts = [FR, { alpha2: 'DE', name: 'Germany' }, { alpha2: 'PF', name: 'French Polynesia' }];
    expect(filterAddable(opts, s).map((o) => o.alpha2)).toEqual(['PF']);
  });

  it('moveItem clamps and copies', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 0, 9)).toEqual(['b', 'c', 'a']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('dropIndexFor over a wrapped row', () => {
  // Row 1: a(0..80) b(90..170); row 2: c(0..80), 44 tall rows.
  const rects = [
    { x: 0, y: 0, width: 80, height: 38 },
    { x: 90, y: 0, width: 80, height: 38 },
    { x: 0, y: 48, width: 80, height: 38 },
  ];

  it('drops before the nearest pill in its leading half, after it in its trailing half', () => {
    expect(dropIndexFor(rects, 95, 19)).toBe(1);
    expect(dropIndexFor(rects, 165, 19)).toBe(2);
    expect(dropIndexFor(rects, 70, 70)).toBe(3);
  });

  it('prefers the pill on the same row', () => {
    expect(dropIndexFor(rects, 60, 30)).toBe(1);
  });

  it('mirrors the halves in RTL', () => {
    expect(dropIndexFor(rects, 95, 19, true)).toBe(2);
  });

  it('converts a slot to the target index once the dragged pill is out', () => {
    expect(slotToIndex(0, 2)).toBe(1);
    expect(slotToIndex(2, 0)).toBe(0);
  });
});
