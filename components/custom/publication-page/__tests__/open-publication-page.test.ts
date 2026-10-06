const mockPush = jest.fn();
let mockPathname = '/logged-in/app_container/for_you';
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock('@/lib/nav-state', () => ({ getCurrentPathname: () => mockPathname }));

import {
    __resetPublicationOnTopForTests,
    buildPublicationParams,
    openPublicationPage,
    parsePublicationOrder,
    publicationKeysFor,
    setPublicationOnTop,
} from '../open-publication-page';

beforeEach(() => {
    mockPush.mockClear();
    mockPathname = '/logged-in/app_container/for_you';
    __resetPublicationOnTopForTests();
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
        expect(mockPush).toHaveBeenCalledWith({
            pathname: '/logged-in/publication',
            params: { publisherId: 'p1', name: 'The Hindu' },
        });
    });

    it('does not push an empty target', () => {
        expect(openPublicationPage({ rawName: '' })).toBe(false);
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('does not push the same publication again when it is already on top', () => {
        mockPathname = '/logged-in/publication';
        setPublicationOnTop(publicationKeysFor({ publisherId: 'p1', rawName: 'The Hindu', countryCode: 'IND' }));
        expect(openPublicationPage({ rawName: 'the hindu', countryCode: 'ind' })).toBe(false);
        expect(openPublicationPage({ publisherId: 'p1' })).toBe(false);
        expect(mockPush).not.toHaveBeenCalled();
        // A DIFFERENT publication from the same page does push.
        expect(openPublicationPage({ publisherId: 'p2' })).toBe(true);
        expect(mockPush).toHaveBeenCalledTimes(1);
    });

    it('pushes again once the page has left the top (keys cleared on blur)', () => {
        mockPathname = '/logged-in/publication';
        setPublicationOnTop(publicationKeysFor({ publisherId: 'p1' }));
        setPublicationOnTop([]);
        expect(openPublicationPage({ publisherId: 'p1' })).toBe(true);
    });

    it('ignores a stale registration when another route is on top', () => {
        setPublicationOnTop(publicationKeysFor({ publisherId: 'p1' }));
        mockPathname = '/logged-in/article-detail';
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
