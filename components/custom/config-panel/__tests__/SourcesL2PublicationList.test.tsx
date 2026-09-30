// SourcesL2PublicationList: plain publication rows (name, host, more/fewer
// glyph, chevron) that open the publication page. No feeds, no accordion.
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
    useTranslation: () => ({ t: (key: string, o?: any) => o?.defaultValue ?? key }),
}));

// jest-expo mis-transforms RN's ScrollView; FlatList's VirtualizedList tree is
// brittle under the test renderer — proxy both to plain renderers, same trick
// as SourcesL1CountryList.test.tsx.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            if (prop === 'FlatList') {
                // Renders the header, footer AND empty slots, not just rows.
                // A mock that destructures only {data, renderItem} silently
                // drops every other prop, and an assertion over what one of
                // them WOULD have rendered then passes because the mock never
                // drew it - not because the component did not. That is not
                // hypothetical: it hid three gating assertions on the
                // publication-history subscribe card, and THIS file's mock was
                // already dropping the load-more footer the component passes.
                return ({
                    data,
                    renderItem,
                    keyExtractor,
                    ListHeaderComponent,
                    ListFooterComponent,
                    ListEmptyComponent,
                }: any) => {
                    const slot = (c: any) =>
                        ReactLib.isValidElement(c)
                            ? c
                            : typeof c === 'function'
                              ? ReactLib.createElement(c)
                              : null;
                    const rows = data ?? [];
                    return ReactLib.createElement(
                        actual.View,
                        null,
                        slot(ListHeaderComponent),
                        rows.length === 0
                            ? slot(ListEmptyComponent)
                            : rows.map((item: any, index: number) =>
                                  ReactLib.createElement(
                                      ReactLib.Fragment,
                                      { key: keyExtractor ? keyExtractor(item, index) : index },
                                      renderItem({ item, index }),
                                  ),
                              ),
                        slot(ListFooterComponent),
                    );
                };
            }
            return (target as any)[prop];
        },
    });
});

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });


jest.mock('@/components/custom/config-panel/DrillDownHeader', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ title, onBack }: any) => (
            <View>
                <Pressable accessibilityLabel="drilldown-back" onPress={onBack} />
                <Text>{title}</Text>
            </View>
        ),
    };
});


const mockGetNewsPublishers = jest.fn();
jest.mock('@/lib/source-service', () => ({
    SourceService: { getNewsPublishers: (...a: unknown[]) => mockGetNewsPublishers(...a) },
}));

let observedPrefRows: any[] = [];
const mockObserveActivePrefs = jest.fn(() => ({
    subscribe: (cb: (rows: any[]) => void) => {
        cb(observedPrefRows);
        return { unsubscribe: jest.fn() };
    },
}));
jest.mock('@/lib/database/services/publication-preference-service', () => ({
    observeActive: () => mockObserveActivePrefs(),
}));

jest.mock('@/lib/stores/publication-display-store', () => ({ useDisplayPublication: (n: string) => n }));
jest.mock('@/lib/nav-state', () => ({ getCurrentPathname: () => '/logged-in/sources-publishers' }));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...args: any[]) => mockRouterPush(...args) } }));

import SourcesL2PublisherList from '../SourcesL2PublicationList';

// The row's VISUAL is hidden from accessibility (a childless labelled button
// sits over it), so text and glyph queries must include hidden elements or an
// absence assertion passes for the wrong reason.
const HIDDEN = { includeHiddenElements: true } as const;

function makeSource(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'src-1',
        publication_name: 'The Times',
        category: 'general_news',
        publication_type: null,
        categories: [],
        ...overrides,
    };
}

function makePublisher(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'pub-1',
        name: 'The Times',
        website_url: 'https://thetimes.example',
        country_code: 'IN',
        publicationSources: [makeSource()],
        ...overrides,
    };
}

function mockPublishers(newsPublishers: any[]) {
    mockGetNewsPublishers.mockResolvedValue({
        newsPublishers,
        pageInfo: { endCursor: null, hasNextPage: false, pageSize: 5 },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    observedPrefRows = [];
});

describe('plain publication rows', () => {
    it('shows the name and the website host, and no feed rows even when the publisher has several', async () => {
        mockPublishers([
            makePublisher({
                website_url: 'https://www.thetimes.example/news/',
                publicationSources: [
                    makeSource({ _id: 'src-1', category: 'general_news' }),
                    makeSource({ _id: 'src-2', category: 'sports' }),
                ],
            }),
        ]);
        const { findByText, queryByText, getByTestId } = render(
            <SourcesL2PublisherList countryCode="IN" countryName="India" onBack={jest.fn()} />,
        );
        expect(await findByText('The Times', HIDDEN)).toBeTruthy();
        expect(queryByText('thetimes.example', HIDDEN)).toBeTruthy();
        // The feed rows the accordion used to list are gone.
        expect(queryByText('All', HIDDEN)).toBeNull();
        expect(queryByText('Sports', HIDDEN)).toBeNull();
        // No up/down, Top headlines pill or Subscribe on the row any more.
        expect(queryByText('sources.viewTopHeadlines', HIDDEN)).toBeNull();
        expect(getByTestId('sources-publisher-pub-1')).toBeTruthy();
    });

    it('opens the publication page by publisher id, carrying the raw name and country', async () => {
        mockPublishers([makePublisher()]);
        const { findByTestId } = render(
            <SourcesL2PublisherList countryCode="IN" countryName="India" onBack={jest.fn()} />,
        );
        fireEvent.press(await findByTestId('sources-publisher-pub-1'));
        expect(mockRouterPush).toHaveBeenCalledWith({
            pathname: '/logged-in/publication',
            params: { publisherId: 'pub-1', name: 'The Times', country: 'IN' },
        });
    });
});

describe('the more/fewer state glyph', () => {
    it('shows "more" for a boosted publication and says so in the row label', async () => {
        observedPrefRows = [{ publicationName: 'the times', weight: 1, scopeKind: null }];
        mockPublishers([makePublisher()]);
        const { findByTestId, getByTestId } = render(
            <SourcePublishersUnderTest />,
        );
        expect(await findByTestId('sources-publisher-pub-1-pref-prioritised', HIDDEN)).toBeTruthy();
        expect(getByTestId('sources-publisher-pub-1').props.accessibilityLabel).toContain('publicationPage.prefMoreA11y');
    });

    it('shows "fewer" for a downranked one', async () => {
        observedPrefRows = [{ publicationName: 'The Times', weight: -0.5, scopeKind: null }];
        mockPublishers([makePublisher()]);
        const { findByTestId } = render(<SourcePublishersUnderTest />);
        expect(await findByTestId('sources-publisher-pub-1-pref-deprioritised', HIDDEN)).toBeTruthy();
    });

    it('shows no glyph with no preference, and a scope row never matches a publication', async () => {
        observedPrefRows = [{ publicationName: 'The Times', weight: 1, scopeKind: 'country' }];
        mockPublishers([makePublisher()]);
        const { findByTestId, queryByTestId } = render(<SourcePublishersUnderTest />);
        expect(await findByTestId('sources-publisher-pub-1')).toBeTruthy();
        expect(queryByTestId('sources-publisher-pub-1-pref-prioritised', HIDDEN)).toBeNull();
        expect(queryByTestId('sources-publisher-pub-1-pref-deprioritised', HIDDEN)).toBeNull();
    });
});

function SourcePublishersUnderTest() {
    return <SourcesL2PublisherList countryCode="IN" countryName="India" onBack={jest.fn()} />;
}
