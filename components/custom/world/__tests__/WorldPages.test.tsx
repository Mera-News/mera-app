import { act, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, o?: Record<string, unknown>) => (o?.country ? `${k}:${o.country}` : k),
    }),
}));
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});

// The shell renders nothing here; the test drives its props.
let mockTabProps: any = null;
jest.mock('@/components/custom/nav/TabPages', () => ({
    __esModule: true,
    default: (p: any) => {
        mockTabProps = p;
        return null;
    },
}));
jest.mock('@/components/custom/nav/HowThisPageWorks', () => ({
    __esModule: true,
    default: () => null,
}));
jest.mock('@/components/custom/explore/ScopeArticleList', () => ({
    __esModule: true,
    default: () => null,
}));

const world = { id: 'world', scope: { id: 'world', kind: 'world', label: '' }, origin: 'world' };
const de = { id: 'country:DE', scope: { id: 'country:DEU', kind: 'country', label: 'Germany' }, origin: 'place' };
const fr = { id: 'country:FR', scope: { id: 'country:FRA', kind: 'country', label: 'France' }, origin: 'browse' };
let mockPages: any[] = [world, de, fr];
let mockLoaded = true;
let mockIntroDone: boolean | null = false;
const mockAdd = jest.fn(async () => {});
const mockRemove = jest.fn(async () => {});
const mockMarkIntro = jest.fn(async () => {});
jest.mock('@/lib/explore/world-pages', () => ({
    useWorldPages: () => ({ pages: mockPages, loaded: mockLoaded }),
    useWorldIntroDone: () => mockIntroDone,
    addWorldCountry: (...a: unknown[]) => mockAdd(...(a as [])),
    removeWorldCountry: (...a: unknown[]) => mockRemove(...(a as [])),
    markWorldIntroDone: () => mockMarkIntro(),
}));
const mockSetPageOrder = jest.fn();
jest.mock('@/lib/navigation/page-order', () => ({ setPageOrder: (...a: unknown[]) => mockSetPageOrder(...a) }));
jest.mock('@/lib/navigation/tab-bar', () => ({ useListEndClearance: () => 172 }));
const mockGetAllCountries = jest.fn(async () => ['FRA', 'PYF', 'DEU', 'NLD']);
jest.mock('@/lib/account-service', () => ({
    __esModule: true,
    default: { getAllCountries: () => mockGetAllCountries() },
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    router: { push: (...a: unknown[]) => mockPush(...a) },
}));

import ScopeArticleList from '@/components/custom/explore/ScopeArticleList';
import HowThisPageWorks from '@/components/custom/nav/HowThisPageWorks';
import { WorldPages } from '../WorldPages';

const header = { scrollHandler: {}, headerHeight: 120, hidden: { value: 0 }, reveal: jest.fn() } as any;
const pageEl = (pageId: string, active = true): any =>
    mockTabProps.renderPage({ pageId, active, header, params: null });

beforeEach(() => {
    jest.clearAllMocks();
    mockTabProps = null;
    mockPages = [world, de, fr];
    mockLoaded = true;
    mockIntroDone = false;
});

describe('WorldPages', () => {
    it('hands the shell World then the countries, flagged, with search in place of the bell', () => {
        render(<WorldPages />);
        expect(mockTabProps.tab).toBe('world');
        expect(mockTabProps.pages).toEqual([
            { id: 'world', label: 'tabs.world' },
            { id: 'country:DE', label: 'Germany', flagAlpha2: 'DE' },
            { id: 'country:FR', label: 'France', flagAlpha2: 'FR' },
        ]);
        mockTabProps.trailing.onPress();
        expect(mockPush).toHaveBeenCalledWith('/logged-in/search');
    });

    it('renders each page as its scope list under the shared header, gated on loaded locations', () => {
        mockLoaded = false;
        render(<WorldPages />);
        const el = pageEl('country:DE', false);
        expect(el.type).toBe(ScopeArticleList);
        expect(el.props.scope).toBe(de.scope);
        expect(el.props.active).toBe(false);
        expect(el.props.enabled).toBe(false);
        expect(el.props.headerHeight).toBe(120);
        expect(el.props.scrollHandler).toBe(header.scrollHandler);
        expect(el.props.bottomClearance).toBe(172);
        expect(el.props.footer.type).toBe(HowThisPageWorks);
        expect(el.props.footer.props.pageId).toBe('country:DE');
        expect(pageEl('world').props.footer.props.pageId).toBe('world');
        expect(pageEl('country:XX')).toBeNull();
    });

    it('keeps a window per page, 24h by default, and re-keys only that page on a change', () => {
        render(<WorldPages />);
        expect(pageEl('world').props.windowHours).toBe(24);
        act(() => pageEl('country:DE').props.onWindowChange(6));
        expect(pageEl('country:DE').props.windowHours).toBe(6);
        expect(pageEl('country:DE').key).toBe('6');
        expect(pageEl('world').props.windowHours).toBe(24);
        expect(pageEl('country:FR').props.windowHours).toBe(24);
    });

    it('shows the intro line only on World alone, until the pen has been opened', () => {
        mockPages = [world];
        const r = render(<WorldPages />);
        expect(pageEl('world').props.listHeaderExtra).toBeTruthy();
        mockIntroDone = true;
        r.rerender(<WorldPages />);
        expect(pageEl('world').props.listHeaderExtra).toBeUndefined();
        mockIntroDone = null; // not read yet: never flash it
        r.rerender(<WorldPages />);
        expect(pageEl('world').props.listHeaderExtra).toBeUndefined();
        mockIntroDone = false;
        mockPages = [world, de];
        r.rerender(<WorldPages />);
        expect(pageEl('world').props.listHeaderExtra).toBeUndefined();
    });

    it('opening the pen marks the intro done and loads the add list once', async () => {
        render(<WorldPages />);
        await act(async () => {
            mockTabProps.arrange.onOpen();
        });
        expect(mockMarkIntro).toHaveBeenCalledTimes(1);
        await act(async () => {
            mockTabProps.arrange.onOpen();
        });
        expect(mockGetAllCountries).toHaveBeenCalledTimes(1);
        const names = mockTabProps.arrange.world.search('fr').map((o: any) => o.name);
        // France already has a page; French Polynesia is offered.
        expect(names).toEqual(['French Polynesia']);
    });

    it('notes only place countries, and World is never removable', () => {
        render(<WorldPages />);
        const w = mockTabProps.arrange.world;
        expect(w.footnoteFor('country:DE')).toBe('world.arrange.placesNote:Germany');
        expect(w.footnoteFor('country:FR')).toBeNull();
        expect(w.footnoteFor('world')).toBeNull();
        expect(w.removable('world')).toBe(false);
        expect(w.removable('country:FR')).toBe(true);
    });

    it('✓ commits removals, additions and the order through the World services', async () => {
        render(<WorldPages />);
        await act(async () => {
            await mockTabProps.arrange.onSave({
                order: ['country:DE', 'world', 'country:FR'],
                removed: ['country:FR'],
                added: ['NL'],
            });
        });
        expect(mockRemove).toHaveBeenCalledWith('FR');
        expect(mockAdd).toHaveBeenCalledWith('NL');
        expect(mockSetPageOrder).toHaveBeenCalledWith('world', ['country:DE', 'world', 'country:NL']);
    });
});
