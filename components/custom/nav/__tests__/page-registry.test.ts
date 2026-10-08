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

  it("gives every page an explainer for the header's ?", () => {
    for (const id of Object.keys(PAGE_META) as FixedPageId[]) {
      expect(PAGE_META[id].explainer?.paragraphKeys.length).toBeGreaterThan(0);
    }
    expect(PAGE_META.settings.explainer?.titleKey).toBe('explainer.settings.title');
    expect(PAGE_META.notifications.explainer?.titleKey).toBe('explainer.notifications.title');
  });

  it('offers Learn more only where a chapter is named', () => {
    expect(PAGE_META.settings.explainer?.chapter).toBe('privacy');
    expect(PAGE_META.notifications.explainer?.chapter).toBeUndefined();
    expect(PAGE_META.saved.explainer?.chapter).toBe('library');
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
