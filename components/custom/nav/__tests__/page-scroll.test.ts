import type { PageId } from '../page-registry';
import { retapTarget, scrollListToTop } from '../page-scroll';
import { decideTabPressAction, tabRouteKeyContaining, tabRouteKeyFor, TAB_PRESS_TOP_EPSILON } from '../tab-press';

describe('retapTarget', () => {
  const targets = new Map<PageId, string>([
    ['saved', 'saved-list'],
    ['visited', 'visited-list'],
  ]);

  it('sends the re-tap to the visible page only', () => {
    expect(retapTarget(targets, 'visited', false)).toBe('visited-list');
    expect(retapTarget(targets, 'saved', false)).toBe('saved-list');
  });

  it('sends nothing for a page with no list, with no page, or while arranging', () => {
    expect(retapTarget(targets, 'stats', false)).toBeNull();
    expect(retapTarget(targets, null, false)).toBeNull();
    expect(retapTarget(targets, 'saved', true)).toBeNull();
  });
});

describe('scrollListToTop', () => {
  it('uses a list offset, or a scroll view position', () => {
    const list = { scrollToOffset: jest.fn() };
    scrollListToTop({ current: list }, true);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
    const view = { scrollTo: jest.fn() };
    scrollListToTop({ current: view }, false);
    expect(view.scrollTo).toHaveBeenCalledWith({ x: 0, y: 0, animated: false });
    expect(() => scrollListToTop({ current: null }, true)).not.toThrow();
  });
});

describe('decideTabPressAction', () => {
  const base = { isForThisTab: true, isFocused: true, offset: 500, canRefresh: true, isRefreshing: false };
  it('scrolls a scrolled page up, then refreshes at the top', () => {
    expect(decideTabPressAction(base)).toBe('scroll-to-top');
    expect(decideTabPressAction({ ...base, offset: TAB_PRESS_TOP_EPSILON })).toBe('refresh');
    expect(decideTabPressAction({ ...base, offset: 0, canRefresh: false })).toBe('ignore');
    expect(decideTabPressAction({ ...base, offset: 0, isRefreshing: true })).toBe('ignore');
  });
  it('ignores a switch to the tab and a pushed screen (the root not focused)', () => {
    expect(decideTabPressAction({ ...base, isFocused: false })).toBe('ignore');
    expect(decideTabPressAction({ ...base, isForThisTab: false })).toBe('ignore');
  });
});

describe('tabRouteKeyContaining', () => {
  const tabs = {
    routes: [
      { key: 'feed-k', state: { routes: [{ key: 'feed-index' }, { key: 'article' }] } },
      { key: 'library-k', state: { routes: [{ key: 'library-index' }] } },
    ],
  };
  it('finds the tab whose stack holds the screen', () => {
    expect(tabRouteKeyContaining(tabs, 'library-index')).toBe('library-k');
    expect(tabRouteKeyContaining(tabs, 'feed-k')).toBe('feed-k');
    expect(tabRouteKeyContaining(tabs, 'nowhere')).toBeNull();
  });
});

describe('tabRouteKeyFor', () => {
  // The device's real tab state (Explore, 4 re-taps all ignored): the tab
  // routes carry NO nested stack state, and the key is `<name>-<id>`.
  const deviceTabs = {
    type: 'tab',
    routes: [
      { name: 'feed', key: 'feed-Qm3uS0aPZt' },
      { name: 'world', key: 'world-VXa_1FqDYVhqwsw8afzH6' },
      { name: 'library', key: 'library-8xw1' },
      { name: 'you', key: 'you-Lp0' },
    ],
  };
  it("finds this tab's route by name when the nested state is missing", () => {
    expect(tabRouteKeyContaining(deviceTabs, 'index-a1')).toBeNull();
    expect(tabRouteKeyFor(deviceTabs, 'world', 'index-a1')).toBe('world-VXa_1FqDYVhqwsw8afzH6');
    expect(tabRouteKeyFor(deviceTabs, 'feed', 'index-b2')).toBe('feed-Qm3uS0aPZt');
  });
  it('so a re-tap of Explore while scrolled down scrolls', () => {
    const target = 'world-VXa_1FqDYVhqwsw8afzH6';
    expect(
      decideTabPressAction({
        isForThisTab: target === tabRouteKeyFor(deviceTabs, 'world', 'index-a1'),
        isFocused: true,
        offset: 997.33,
        canRefresh: true,
        isRefreshing: false,
      }),
    ).toBe('scroll-to-top');
  });
});
