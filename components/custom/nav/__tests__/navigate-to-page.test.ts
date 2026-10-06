import { router } from 'expo-router';

import { clearSurface, reportSurface, resetCurrentSurface, useCurrentSurface } from '../current-surface';
import {
  PENDING_PAGE_MAX_AGE_MS,
  consumePendingPage,
  navigateToPage,
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
