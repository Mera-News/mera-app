/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
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
        t: (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}:${o.count}` : k),
    }),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    router: { push: (...a: unknown[]) => mockPush(...a), navigate: jest.fn() },
    useFocusEffect: jest.fn(),
}));
jest.mock('react-native-reanimated', () => {
    const { ScrollView } = require('react-native');
    return { __esModule: true, default: { ScrollView }, useAnimatedRef: () => ({ current: null }), runOnUI: (f: any) => f, scrollTo: jest.fn() };
});
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ReactLib.forwardRef(({ children, ...rest }: any, _ref: any) => ReactLib.createElement(actual.View, rest, children));
    return new Proxy(actual, { get: (t, p) => (p === 'ScrollView' ? StubScrollView : (t as any)[p]) });
});
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: Text }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: ({ children, ...p }: any) => <Pressable {...p}>{children}</Pressable>, ButtonText: ({ children }: any) => <Text>{children}</Text> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const Pass = ({ children, ...p }: any) => <View {...p}>{children}</View>;
    return { Modal: ({ isOpen, children }: any) => (isOpen ? <View>{children}</View> : null), ModalBackdrop: () => null, ModalContent: Pass, ModalHeader: Pass, ModalBody: Pass, ModalFooter: Pass };
});
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => true }));
jest.mock('@/components/custom/TranslatableDynamic', () => { const { Text } = require('react-native'); return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> }; });
jest.mock('@/components/custom/BlockedBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/nav/HowThisPageWorks', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/stores/publication-display-store', () => { const { Text } = require('react-native'); return { DisplayPublicationName: ({ name }: any) => <Text>{name}</Text> }; });
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: null }) } }));
const mockUserState = { userId: 'u1', userPersona: { blockedByLlm: false }, fetchUserPersona: jest.fn() };
jest.mock('@/lib/stores/user-store', () => ({ useUserStore: (sel: any) => sel(mockUserState) }));
jest.mock('@/lib/navigation/tab-bar', () => ({ useListEndClearance: () => 172 }));
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));
jest.mock('@/lib/database/services/suppression-service', () => ({ HARD_SUPPRESSION_STRENGTH: 1 }));
jest.mock('@/components/custom/persona-audit/action-display', () => ({
    actionDisplay: () => ({ labelKey: 'unknown' }),
    isRevertible: () => true,
}));

let mockData: any;
jest.mock('../use-hub-data', () => ({
    useHubFacts: () => mockData.facts,
    useActiveTopicTexts: () => ['t1'],
    useHubPlaces: () => mockData.places,
    useHubCleanup: () => mockData.cleanup,
    useHubSubscriptions: () => mockData.subs,
    useHubActivity: () => mockData.activity,
}));
jest.mock('@/components/custom/publication-preferences/use-adjusted-sources', () => ({
    useAdjustedSources: () => ({ rows: mockData.sources, isLoading: false }),
}));
jest.mock('@/components/custom/not-interested/use-not-interested-data', () => ({
    useNotInterestedData: () => mockData.notInterested,
}));

import ProfileHub from '../ProfileHub';

const header = { scrollHandler: undefined, headerHeight: 60, hidden: { value: 0 }, reveal: jest.fn() } as any;

const EMPTY = {
    facts: { facts: [], counts: new Map(), countState: 'ready' },
    places: [],
    sources: [],
    cleanup: { count: 0, firstSummary: null },
    subs: [],
    activity: [],
    notInterested: { filters: [], topics: [] },
};

beforeEach(() => {
    mockPush.mockClear();
    mockData = EMPTY;
});

describe('new profile', () => {
    it('shows the four jump targets with how each fills, and nothing else', () => {
        const r = render(<ProfileHub header={header} active />);
        expect(r.getByText('you.profile.factsEmpty')).toBeTruthy();
        expect(r.getByText('you.profile.placesEmpty')).toBeTruthy();
        expect(r.getByText('you.profile.sourcesEmpty')).toBeTruthy();
        expect(r.getByText('you.profile.topicsDeclinedEmpty')).toBeTruthy();
        expect(r.queryByTestId('profile-card-cleanup')).toBeNull();
        expect(r.queryByTestId('profile-card-pay-for')).toBeNull();
        expect(r.queryByTestId('profile-card-activity')).toBeNull();
        // No View all on an empty Facts card; Sources keeps its way in.
        expect(r.queryByTestId('profile-card-facts-view-all')).toBeNull();
        expect(r.getByTestId('profile-card-sources-view-all')).toBeTruthy();
    });

    it('Add a city opens Locations in the You stack', () => {
        const r = render(<ProfileHub header={header} active />);
        fireEvent.press(r.getByTestId('profile-places-add'));
        expect(mockPush).toHaveBeenCalledWith('/logged-in/app_container/you/locations');
    });
});

describe('returning profile', () => {
    beforeEach(() => {
        mockData = {
            ...EMPTY,
            facts: {
                facts: [
                    { id: 'f1', statement: 'lives in Berlin', createdAt: '2026-01-02' },
                    { id: 'f2', statement: 'cares about climate', createdAt: '2026-01-01' },
                ],
                counts: new Map([['t1', 4]]),
                countState: 'ready',
            },
            places: [{ id: 'l1', city: 'berlin', region: null, countryCode: 'DE', role: 'work' }],
            sources: [{ group: { key: 'g1' }, pref: { publicationName: 'Bild', scopeKind: null }, kind: 'mute' }],
            cleanup: { count: 3, firstSummary: 'Two facts say almost the same thing' },
            notInterested: { filters: [{ id: 's1', pattern: 'celebrity gossip', value: null, strength: 1 }], topics: [{ id: 'tp1', text: 'crypto prices' }] },
            subs: [{ id: 'p1', publisherName: 'Der Tagesspiegel' }],
            activity: [{ id: 'a1', summary: 'Muted Bild', actionType: 'x', reverted: false }],
        };
    });

    it('fills every card from its source', () => {
        const r = render(<ProfileHub header={header} active />);
        expect(r.getByText('Lives in Berlin')).toBeTruthy();
        expect(r.getAllByText('configPanel.articleCount:4')).toHaveLength(2);
        expect(r.getByText('locations.roles.work')).toBeTruthy();
        expect(r.getByText('you.sources.muted')).toBeTruthy();
        expect(r.getByText('you.profile.hidden')).toBeTruthy();
        expect(r.getByText('you.profile.less')).toBeTruthy();
        expect(r.getByText('Der Tagesspiegel')).toBeTruthy();
        expect(r.getByText('articleMenu.undo')).toBeTruthy();
        expect(r.getByText('3')).toBeTruthy();
        expect(r.getByTestId('profile-card-facts-view-all').props.accessibilityLabel).toBe('you.profile.viewAll:2');
    });

    it('View all and Review open their You-stack screens', () => {
        const r = render(<ProfileHub header={header} active />);
        fireEvent.press(r.getByTestId('profile-card-facts-view-all'));
        fireEvent.press(r.getByTestId('profile-card-pay-for-view-all'));
        fireEvent.press(r.getByTestId('profile-cleanup-review'));
        expect(mockPush.mock.calls.map((c) => c[0])).toEqual([
            '/logged-in/app_container/you/facts',
            '/logged-in/app_container/you/sources',
            '/logged-in/app_container/you/hygiene-review',
        ]);
    });

    it('a card "?" opens its hint box with a labelled button', () => {
        const r = render(<ProfileHub header={header} active />);
        const q = r.getByTestId('profile-card-places-hint');
        expect(q.props.accessibilityLabel).toBe('you.profile.aboutA11y');
        fireEvent.press(q);
        expect(r.getByText('you.hints.places.title')).toBeTruthy();
        expect(r.getByText('you.hints.places.body2')).toBeTruthy();
    });
});
