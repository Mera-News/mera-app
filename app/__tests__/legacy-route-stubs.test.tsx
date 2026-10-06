/* eslint-disable @typescript-eslint/no-require-imports */
// Routes that moved into the four tabs keep a stub, so old links, pushes and
// restored screens still open. Each one goes through navigateToPage /
// navigateToTabScreen (dismiss a root push, pop the target tab's stack, then
// navigate), never a <Redirect>, which would stack a second copy of the tabs.
import { render } from '@testing-library/react-native';
import React from 'react';

const mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
    router: { canDismiss: jest.fn(() => true), dismissAll: jest.fn(), navigate: jest.fn(), replace: jest.fn(), push: jest.fn() },
    useLocalSearchParams: () => mockParams,
    useNavigation: () => ({}),
}));

import { router } from 'expo-router';
import { consumePendingPage, resetPendingPage } from '@/components/custom/nav/navigate-to-page';
import { resetCurrentSurface } from '@/components/custom/nav/current-surface';

const r = router as unknown as Record<string, jest.Mock>;

beforeEach(() => {
    jest.clearAllMocks();
    r.canDismiss.mockReturnValue(true);
    for (const k of Object.keys(mockParams)) delete mockParams[k];
    resetPendingPage();
    resetCurrentSurface();
});

const TAB_SCREENS: [string, string, string][] = [
    ['facts', 'you', 'facts'],
    ['locations', 'you', 'locations'],
    ['publication-preferences', 'you', 'sources'],
    ['sources', 'you', 'sources'],
    ['hygiene-review', 'you', 'hygiene-review'],
    ['not-interested', 'you', 'not-interested'],
    ['persona-audit', 'you', 'activity'],
    ['preferences/display', 'you', 'display'],
    ['preferences/mera-protocol', 'you', 'mera-protocol'],
    ['preferences/notifications', 'you', 'notifications'],
];

describe.each(TAB_SCREENS)('/logged-in/%s', (route, tab, screen) => {
    it(`dismisses itself and opens ${tab}/${screen} inside the tab's stack`, () => {
        const Route = require(`../logged-in/${route}`).default;
        render(<Route />);
        expect(r.dismissAll).toHaveBeenCalledTimes(1);
        expect(r.navigate).toHaveBeenCalledWith(`/logged-in/app_container/${tab}`);
        expect(r.push).toHaveBeenCalledWith(
            expect.objectContaining({ pathname: `/logged-in/app_container/${tab}/${screen}` }),
        );
        expect(r.replace).not.toHaveBeenCalled();
    });
});

const PAGES: [string, string, string][] = [
    ['config-panel', 'you', 'profile'],
    ['profile-advanced', 'you', 'profile'],
    ['saved-suggestions', 'library', 'saved'],
    ['visited-publications', 'library', 'visited'],
    ['share-stats', 'library', 'stats'],
    ['country-articles', 'world', 'world'],
];

describe.each(PAGES)('/logged-in/%s', (route, tab, page) => {
    it(`opens the ${page} page of ${tab} through the pending store`, () => {
        const Route = require(`../logged-in/${route}`).default;
        render(<Route />);
        expect(r.navigate).toHaveBeenCalledWith(`/logged-in/app_container/${tab}`);
        expect(consumePendingPage(tab as never)?.page).toBe(page);
    });
});

it('share-stats forwards the card it named', () => {
    mockParams.card = 'keep';
    const Route = require('../logged-in/share-stats').default;
    render(<Route />);
    expect(consumePendingPage('library')).toMatchObject({ page: 'stats', params: { card: 'keep' } });
});

it('a stub opened cold (nothing to dismiss) replaces itself instead of pushing the tabs on top', () => {
    r.canDismiss.mockReturnValue(false);
    const Route = require('../logged-in/saved-suggestions').default;
    render(<Route />);
    expect(r.replace).toHaveBeenCalledWith('/logged-in/app_container/library');
    expect(r.navigate).not.toHaveBeenCalled();
});

it('fact-feed opens One interest in the Feed stack with its params', () => {
    Object.assign(mockParams, { factId: 'f1', statement: 'Lives in Berlin', via: 'next' });
    const Route = require('../logged-in/fact-feed').default;
    render(<Route />);
    expect(r.push).toHaveBeenCalledWith({
        pathname: '/logged-in/app_container/feed/interest',
        params: { factId: 'f1', statement: 'Lives in Berlin', via: 'next' },
    });
});
