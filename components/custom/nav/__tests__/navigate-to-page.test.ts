import { router } from 'expo-router';

import { clearSurface, reportSurface, resetCurrentSurface, useCurrentSurface } from '../current-surface';
import {
  PENDING_PAGE_MAX_AGE_MS,
  consumePendingEdge,
  consumePendingPage,
  navigateToPage,
  navigateToTabEdge,
  navigateToTabScreen,
  registerTabStack,
  resetPendingPage,
  usePendingPageStore,
} from '../navigate-to-page';

const r = router as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  r.navigate = jest.fn();
  r.replace = jest.fn();
  r.dismissAll = jest.fn();
  r.canDismiss = jest.fn(() => false);
  resetPendingPage();
  resetCurrentSurface();
});

describe('navigateToPage', () => {
  it('navigates to the page tab root and leaves a one-shot request', () => {
    reportSurface('feed');
    navigateToPage('stats', { params: { card: 'reach' } });
    expect(r.navigate).toHaveBeenCalledWith('/logged-in/app_container/library');
    expect(r.dismissAll).not.toHaveBeenCalled();
    const req = consumePendingPage('library');
    expect(req).toMatchObject({ page: 'stats', params: { card: 'reach' }, origin: 'feed' });
    expect(consumePendingPage('library')).toBeNull();
  });

  it('dismisses a root push first (no surface, or Search), never a tab stack', () => {
    r.canDismiss = jest.fn(() => true);
    navigateToPage('profile');
    expect(r.dismissAll).toHaveBeenCalledTimes(1);

    r.dismissAll.mockClear();
    reportSurface('search');
    navigateToPage('profile');
    expect(r.dismissAll).toHaveBeenCalledTimes(1);

    r.dismissAll.mockClear();
    reportSurface('interest:f1');
    navigateToPage('saved');
    expect(r.dismissAll).not.toHaveBeenCalled();
  });

  it('replaces a cold redirect stub instead of pushing over it', () => {
    navigateToPage('saved', { replace: true });
    expect(r.replace).toHaveBeenCalledWith('/logged-in/app_container/library');
    expect(r.navigate).not.toHaveBeenCalled();
  });

  it('is consumed only by the page tab', () => {
    navigateToPage('country:DE');
    expect(consumePendingPage('feed')).toBeNull();
    expect(consumePendingPage('world')?.page).toBe('country:DE');
  });

  it('drops a stale request', () => {
    navigateToPage('checks');
    const at = usePendingPageStore.getState().request!.at;
    expect(consumePendingPage('library', at + PENDING_PAGE_MAX_AGE_MS + 1)).toBeNull();
    expect(usePendingPageStore.getState().request).toBeNull();
  });
});

describe('current surface', () => {
  it('clears only its own report, and reads outside React', () => {
    reportSurface('feed');
    reportSurface('interests');
    clearSurface('feed');
    expect(useCurrentSurface.getState()).toBe('interests');
    clearSurface('interests');
    expect(useCurrentSurface.getState()).toBeNull();
  });
});

describe('target stack pop', () => {
  it('pops the TARGET tab stack to root before navigating, after dismissing a root push', () => {
    const calls: string[] = [];
    r.canDismiss = jest.fn(() => true);
    r.dismissAll = jest.fn(() => calls.push('dismissAll'));
    r.navigate = jest.fn(() => calls.push('navigate'));
    const popYou = jest.fn(() => calls.push('pop:you'));
    const popFeed = jest.fn(() => calls.push('pop:feed'));
    const offYou = registerTabStack('you', popYou);
    const offFeed = registerTabStack('feed', popFeed);
    navigateToPage('profile');
    expect(calls).toEqual(['dismissAll', 'pop:you', 'navigate']);
    expect(popFeed).not.toHaveBeenCalled();
    offYou();
    offFeed();
  });

  it('never dismisses from inside a tab, but still pops the target', () => {
    reportSurface('interest:f1');
    r.canDismiss = jest.fn(() => true);
    const pop = jest.fn();
    const off = registerTabStack('library', pop);
    navigateToPage('saved');
    expect(r.dismissAll).not.toHaveBeenCalled();
    expect(pop).toHaveBeenCalledTimes(1);
    off();
  });

  it('pushes a tab screen on top of the popped root', () => {
    const calls: string[] = [];
    r.push = jest.fn((h: { pathname: string }) => calls.push(`push:${h.pathname}`));
    r.navigate = jest.fn(() => calls.push('navigate'));
    const off = registerTabStack('you', () => calls.push('pop:you'));
    navigateToTabScreen('you', 'sources');
    expect(calls).toEqual(['pop:you', 'navigate', 'push:/logged-in/app_container/you/sources']);
    off();
  });

  it('unregisters only its own popper', () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = registerTabStack('feed', a);
    registerTabStack('feed', b);
    offA();
    navigateToPage('stories');
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });
});

describe('cross-tab edge landing', () => {
  it('opens the neighbouring tab and leaves a one-shot edge for it', () => {
    reportSurface('stories');
    navigateToTabEdge('world', 'first');
    expect(r.navigate).toHaveBeenCalledWith('/logged-in/app_container/world');
    expect(consumePendingEdge('library')).toBeNull();
    expect(consumePendingEdge('world')).toBe('first');
    expect(consumePendingEdge('world')).toBeNull();
  });
});

describe('header bottom', () => {
  const { act, renderHook } = require('@testing-library/react-native');
  const { clearHeaderBottom, reportHeaderBottom, useHeaderBottom } = require('../current-surface');

  it('reads the reported bottom, and only its owner clears it', () => {
    const { result } = renderHook(() => useHeaderBottom());
    expect(result.current).toBeNull();
    act(() => reportHeaderBottom('tab:feed', 106.4));
    expect(result.current).toBe(106);
    act(() => reportHeaderBottom('interest:f1', 120));
    act(() => clearHeaderBottom('tab:feed'));
    expect(result.current).toBe(120);
    act(() => clearHeaderBottom('interest:f1'));
    expect(result.current).toBeNull();
  });

  it('is cleared by the account-switch reset', () => {
    reportHeaderBottom('tab:you', 100);
    resetCurrentSurface();
    expect(require('../current-surface').useCurrentSurfaceStore.getState().headerBottom).toBeNull();
  });

  it('TabPages reports the EXPANDED header bottom, never a collapse-dependent one', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs
      .readFileSync(path.resolve(__dirname, '../TabPages.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/reportHeaderBottom\(`tab:\$\{tab\}`, headerHeight\)/);
    expect(src).not.toMatch(/hidden\.value[^\n]*reportHeaderBottom|collapsed/);
  });
});
