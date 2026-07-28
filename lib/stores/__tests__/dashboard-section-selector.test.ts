import { SECTION_PREVIEW_COUNT } from '../dashboard-section-selector';

// The ordering + badge helpers that used to live here were removed: ordering is
// now the shared lib/feed-ordering/priority-order rule (covered by its own
// suite), and the "+N new" badge was dropped from the section header.
describe('SECTION_PREVIEW_COUNT', () => {
  it('previews three cards per section', () => {
    expect(SECTION_PREVIEW_COUNT).toBe(3);
  });
});
