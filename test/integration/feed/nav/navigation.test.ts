// Page navigation: the current-surface store, the publication page entry point (which asks
// nav-state which route is on top) and the one-shot pending page request. Real stores and the
// real nav-state; expo-router (a native edge) is the only mock, and its calls are asserted.
import { router } from 'expo-router';
import { reportHeaderBottom, resetCurrentSurface, useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';
import {
    PENDING_PAGE_MAX_AGE_MS,
    consumePendingPage,
    navigateToPage,
    resetPendingPage,
    usePendingPageStore,
} from '@/components/custom/nav/navigate-to-page';
import {
    __resetPublicationOnTopForTests,
    buildPublicationParams,
    openPublicationPage,
    parsePublicationOrder,
    publicationKeysFor,
    setPublicationOnTop,
} from '@/components/custom/publication-page/open-publication-page';
import { setCurrentPathname } from '@/lib/nav-state';
import { useFakeClock } from '@/test/helpers';

const push = router.push as jest.Mock;

beforeEach(() => {
    setCurrentPathname('/logged-in/app_container/for_you');
    __resetPublicationOnTopForTests();
    resetCurrentSurface();
    resetPendingPage();
});

describe('tabHeaderBottom', () => {
    it("keeps the tallest tab header, and ignores other screens' headers", () => {
        reportHeaderBottom('tab:feed', 99);
        reportHeaderBottom('tab:world', 143.4);
        reportHeaderBottom('tab:feed', 99);
        reportHeaderBottom('fact', 200);
        expect(useCurrentSurfaceStore.getState().tabHeaderBottom).toBe(143);
    });
});

describe('buildPublicationParams', () => {
    it('carries the publisher id, with the name and country beside it when known', () => {
        expect(buildPublicationParams({ publisherId: 'p1', rawName: 'The Hindu', countryCode: 'IND' })).toEqual({
            publisherId: 'p1',
            name: 'The Hindu',
            country: 'IND',
        });
    });

    it('falls back to name plus country when there is no id (suggestion rows)', () => {
        expect(buildPublicationParams({ rawName: '  De Telegraaf ', countryCode: 'NLD' })).toEqual({
            name: 'De Telegraaf',
            country: 'NLD',
        });
    });

    it('adds order only for Top headlines', () => {
        expect(buildPublicationParams({ publisherId: 'p1' }, 'TOP_HEADLINES')).toEqual({
            publisherId: 'p1',
            order: 'TOP_HEADLINES',
        });
        expect(buildPublicationParams({ publisherId: 'p1' }, 'NEWEST')).toEqual({ publisherId: 'p1' });
    });

    it('returns null with neither an id nor a name', () => {
        expect(buildPublicationParams({ rawName: '   ' })).toBeNull();
        expect(buildPublicationParams({ publisherId: '', rawName: '' })).toBeNull();
    });

    it('never produces a feed id param, whatever it is handed', () => {
        const params = buildPublicationParams({
            publisherId: 'p1',
            rawName: 'X',
            publicationSourceId: 'feed-1',
        } as never);
        expect(Object.keys(params ?? {})).toEqual(['publisherId', 'name']);
    });
});

describe('openPublicationPage', () => {
    it('pushes the publication route', () => {
        expect(openPublicationPage({ publisherId: 'p1', rawName: 'The Hindu' })).toBe(true);
        expect(push).toHaveBeenCalledWith({
            pathname: '/logged-in/publication',
            params: { publisherId: 'p1', name: 'The Hindu' },
        });
    });

    it('does not push an empty target', () => {
        expect(openPublicationPage({ rawName: '' })).toBe(false);
        expect(push).not.toHaveBeenCalled();
    });

    it('does not push the same publication again when it is already on top', () => {
        setCurrentPathname('/logged-in/publication');
        setPublicationOnTop(publicationKeysFor({ publisherId: 'p1', rawName: 'The Hindu', countryCode: 'IND' }));
        expect(openPublicationPage({ rawName: 'the hindu', countryCode: 'ind' })).toBe(false);
        expect(openPublicationPage({ publisherId: 'p1' })).toBe(false);
        expect(push).not.toHaveBeenCalled();
        // A DIFFERENT publication from the same page does push.
        expect(openPublicationPage({ publisherId: 'p2' })).toBe(true);
        expect(push).toHaveBeenCalledTimes(1);
    });

    it('pushes again once the page has left the top (keys cleared on blur)', () => {
        setCurrentPathname('/logged-in/publication');
        setPublicationOnTop(publicationKeysFor({ publisherId: 'p1' }));
        setPublicationOnTop([]);
        expect(openPublicationPage({ publisherId: 'p1' })).toBe(true);
    });

    it('ignores a stale registration when another route is on top', () => {
        setPublicationOnTop(publicationKeysFor({ publisherId: 'p1' }));
        setCurrentPathname('/logged-in/article-detail');
        expect(openPublicationPage({ publisherId: 'p1' })).toBe(true);
    });
});

describe('parsePublicationOrder', () => {
    it('reads the three views and treats anything else as Latest', () => {
        expect(parsePublicationOrder('TOP_HEADLINES')).toBe('TOP_HEADLINES');
        expect(parsePublicationOrder('HISTORY')).toBe('HISTORY');
        expect(parsePublicationOrder('NEWEST')).toBe('NEWEST');
        expect(parsePublicationOrder(undefined)).toBe('NEWEST');
        expect(parsePublicationOrder(['HISTORY'])).toBe('NEWEST');
        expect(parsePublicationOrder('history')).toBe('NEWEST');
    });

    it('round-trips through buildPublicationParams', () => {
        expect(buildPublicationParams({ rawName: 'NOS', countryCode: 'NLD' }, 'HISTORY')).toEqual({
            name: 'NOS',
            country: 'NLD',
            order: 'HISTORY',
        });
    });
});

describe('a pending page request', () => {
    it('is taken once by its own tab, never twice', () => {
        navigateToPage('settings');
        expect(usePendingPageStore.getState().request?.page).toBe('settings');
        // Another tab does not take it, and leaves it for the right one.
        expect(consumePendingPage('feed')).toBeNull();
        expect(consumePendingPage('you')?.page).toBe('settings');
        expect(consumePendingPage('you')).toBeNull();
        expect(usePendingPageStore.getState().request).toBeNull();
    });

    it('opens the target tab', () => {
        navigateToPage('saved');
        expect(router.navigate).toHaveBeenCalledWith('/logged-in/app_container/library');
    });

    it('is dropped once it is older than the max age, so a failed jump never fires later', () => {
        useFakeClock(1_000_000);
        navigateToPage('stats');
        const at = usePendingPageStore.getState().request!.at;
        expect(consumePendingPage('library', at + PENDING_PAGE_MAX_AGE_MS + 1)).toBeNull();
        expect(usePendingPageStore.getState().request).toBeNull();
    });
});
