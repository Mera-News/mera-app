import {
  DEFAULT_PAGE_ORDER,
  PAGE_META,
  TAB_ORDER,
  alpha2OfPage,
  countryPageId,
  isCountryPage,
  pageMeta,
  tabForSurface,
  tabOfPage,
  type FixedPageId,
} from '../page-registry';

describe('page-registry', () => {
  it('places every default page in the tab whose order lists it', () => {
    for (const [tab, ids] of Object.entries(DEFAULT_PAGE_ORDER)) {
      for (const id of ids) expect(PAGE_META[id].tab).toBe(tab);
    }
    expect(PAGE_META.world.tab).toBe('world');
  });

  it('keeps only Feed mounted outside the pager window', () => {
    const kept = (Object.keys(PAGE_META) as FixedPageId[]).filter((id) => PAGE_META[id].keepMounted);
    expect(kept).toEqual(['feed']);
  });

  it("gives the ? only to Feed and World pages (not the inbox); Library and You have none", () => {
    for (const id of Object.keys(PAGE_META) as FixedPageId[]) {
      const tab = PAGE_META[id].tab;
      const hasHelp = PAGE_META[id].explainer !== null;
      expect(hasHelp).toBe((tab === 'feed' && id !== 'notifications') || tab === 'world');
    }
  });

  it('keeps the inbox last in the Feed, Library static and Settings in You', () => {
    expect(DEFAULT_PAGE_ORDER.feed).toEqual(['feed', 'stories', 'notifications']);
    expect(DEFAULT_PAGE_ORDER.library).toEqual(['saved', 'checks', 'visited', 'stats']);
    expect(DEFAULT_PAGE_ORDER.you).toEqual(['profile', 'settings']);
    expect(tabOfPage('notifications')).toBe('feed');
  });

  it('round-trips country page ids as uppercase alpha-2', () => {
    expect(countryPageId('de')).toBe('country:DE');
    expect(isCountryPage('country:DE')).toBe(true);
    expect(isCountryPage('country:')).toBe(false);
    expect(isCountryPage('world')).toBe(false);
    expect(alpha2OfPage('country:XK')).toBe('XK');
    expect(alpha2OfPage('feed')).toBeNull();
  });

  it('puts country pages in World with their own explainer', () => {
    expect(tabOfPage('country:FR')).toBe('world');
    expect(pageMeta('country:FR').tab).toBe('world');
    expect(pageMeta('country:FR').explainer?.paragraphKeys).toContain('world.explainer.country1');
    expect(pageMeta('world').explainer?.paragraphKeys).toContain('world.explainer.top1');
  });

  it('maps surfaces to tabs, Search to none', () => {
    expect(tabForSurface('search')).toBeNull();
    expect(tabForSurface('interest:abc')).toBe('feed');
    expect(tabForSurface('sources')).toBe('you');
    expect(tabForSurface('settings:notifications')).toBe('you');
    expect(tabForSurface('settings:backup')).toBe('you');
    expect(tabForSurface('checks')).toBe('library');
    expect(tabForSurface('country:NL')).toBe('world');
  });

  it('orders tabs Feed, World, Library, You', () => {
    expect(TAB_ORDER).toEqual(['feed', 'world', 'library', 'you']);
  });
});
