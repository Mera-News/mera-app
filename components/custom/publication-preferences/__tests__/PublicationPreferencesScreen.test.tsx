/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// The animated gradient backdrop is pure decoration and asserts nothing here,
// but it imports react-native-reanimated, whose worklets runtime cannot
// initialise under Jest. Stubbing the component keeps reanimated out of this
// suite's module graph entirely — cheaper and less fragile than mocking the
// whole animation library for a view that renders no testable content.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: any) => o?.defaultValue ?? k }),
}));

// The screen gained a "Your subscriptions" section. Both the section and the
// subscription service reach `lib/database/index`, which constructs the SQLite
// adapter at module evaluation — so without these the jest WORKER dies with
// `initializeJSI` and nothing in this file is named in the error.
//
// The section is stubbed rather than exercised: it has its own suite, and this
// file is about the "Other sources" list.
jest.mock('../SubscriptionsSection', () => ({
    __esModule: true,
    default: () => null,
}));
// Search has its own suite.
jest.mock('../SourceSearch', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/navigation/tab-bar', () => ({ useTabBarClearance: () => 0 }));
jest.mock('@/lib/database/services/user-publication-subscription-service', () => ({
    // No active subscriptions ⇒ nothing is suppressed, so every existing
    // assertion about the lower list still describes the same list it always
    // did. Observed rather than fetched, matching the screen.
    observeActive: () => ({
        subscribe: (fn: (rows: unknown[]) => void) => {
            fn([]);
            return { unsubscribe: () => {} };
        },
    }),
    parseSourceNames: () => [],
    normalizeSubscriptionName: (x: string) =>
        (x ?? '').toLowerCase().trim().replace(/\s+/g, ' '),
}));

// jest-expo mis-transforms RN's ScrollView native-component file, which
// FlatList pulls in transitively — proxy RN so ScrollView renders as a plain
// View; every other export stays lazy/real. Same trick as LocationsScreen.test.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            return (target as any)[prop];
        },
    });
});

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });


jest.mock('@/components/custom/config-panel/DrillDownHeader', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ title, subtitle, onBack }: any) => (
            <View>
                <Pressable accessibilityLabel="drilldown-back" onPress={onBack} />
                <Text>{title}</Text>
                {subtitle ? <Text>{subtitle}</Text> : null}
            </View>
        ),
    };
});

// Row rendering/behavior is covered by PublicationPrefRow.test.tsx — stub it
// here so this suite exercises only the screen's wiring (busy-key, open-key,
// which branch each handler takes, what it calls).
jest.mock('../PublicationPrefRow', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ pref, busy, isOpen, onToggle, onSetKind, onClear }: any) => (
            <View testID={`row-${pref.id}`}>
                <Text>{pref.publicationName}</Text>
                <Text testID={`row-${pref.id}-busy`}>{String(busy)}</Text>
                <Text testID={`row-${pref.id}-open`}>{String(isOpen)}</Text>
                <Pressable testID={`row-${pref.id}-toggle`} onPress={() => onToggle(pref)} />
                <Pressable testID={`row-${pref.id}-boost`} onPress={() => onSetKind(pref, 'boost')} />
                <Pressable testID={`row-${pref.id}-mute`} onPress={() => onSetKind(pref, 'mute')} />
                <Pressable testID={`row-${pref.id}-clear`} onPress={() => onClear(pref)} />
            </View>
        ),
    };
});

// --- services ---------------------------------------------------------------
let mockObservedRows: any[] = [];
const mockObserveActive = jest.fn(() => ({
    subscribe: (cb: (rows: any[]) => void) => {
        cb(mockObservedRows);
        return { unsubscribe: jest.fn() };
    },
}));
const mockGetPreferenceKind = jest.fn(async (..._a: unknown[]) => 'mute');
const mockSetPreferenceKind = jest.fn(async (..._a: unknown[]) => {});
const mockGetScopePreferenceKind = jest.fn(async (..._a: unknown[]) => 'none');
const mockSetScopePreferenceKind = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/database/services/publication-preference-service', () => ({
    observeActive: () => mockObserveActive(),
    weightToPrefKind: (w: number) => (w <= -0.9 ? 'mute' : w < 0 ? 'deprioritize' : w > 0 ? 'boost' : null),
    getPreferenceKind: (...a: unknown[]) => mockGetPreferenceKind(...a),
    setPreferenceKind: (...a: unknown[]) => mockSetPreferenceKind(...a),
    getScopePreferenceKind: (...a: unknown[]) => mockGetScopePreferenceKind(...a),
    setScopePreferenceKind: (...a: unknown[]) => mockSetScopePreferenceKind(...a),
}));

const mockApplyPersonaAction = jest.fn(async (..._a: unknown[]) => ({ applied: true, summary: 'ok' }));
jest.mock('@/lib/database/services/persona-action-executor', () => ({
    applyPersonaAction: (...a: unknown[]) => mockApplyPersonaAction(...a),
}));

const mockAppend = jest.fn(async (..._a: unknown[]) => ({ id: 'log1' }));
jest.mock('@/lib/database/services/persona-change-log-service', () => ({
    append: (...a: unknown[]) => mockAppend(...a),
}));

const mockRunSweepFor = jest.fn(async (..._a: unknown[]) => false);
const mockSweepForMutation = jest.fn((..._a: unknown[]) => 'unexclude');
jest.mock('@/lib/database/services/persona-mutation-sweeps', () => ({
    runSweepFor: (...a: unknown[]) => mockRunSweepFor(...a),
    sweepForMutation: (...a: unknown[]) => mockSweepForMutation(...a),
}));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

// The shared ↑/↓ writer has its own suite; here we assert WHAT the screen
// asks it for: a publisher target naming every source of the publication, or
// a country target for a scope row.
const mockSetSourcePrefFromUi = jest.fn(async (..._a: unknown[]) => ({ applied: true }));
jest.mock('@/lib/database/services/publication-pref-ui-actions', () => ({
    setSourcePrefFromUi: (...a: unknown[]) => mockSetSourcePrefFromUi(...a),
}));

import { __clearPublisherSourceNames, rememberPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import PublicationPreferencesScreen from '../PublicationPreferencesScreen';

function makeNamedPref(overrides: Record<string, unknown> = {}) {
    return {
        id: 'pref1',
        publicationName: 'The Times',
        weight: 0,
        scopeKind: null,
        scopeValue: null,
        ...overrides,
    } as any;
}

function makeScopePref(overrides: Record<string, unknown> = {}) {
    return {
        id: 'scope1',
        publicationName: 'India',
        weight: 0,
        scopeKind: 'country',
        scopeValue: 'IND',
        ...overrides,
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    __clearPublisherSourceNames();
    mockObservedRows = [];
    mockGetPreferenceKind.mockResolvedValue('mute' as any);
    mockGetScopePreferenceKind.mockResolvedValue('none' as any);
    mockRunSweepFor.mockResolvedValue(false as any);
    mockSweepForMutation.mockReturnValue('unexclude' as any);
});

describe('PublicationPreferencesScreen', () => {
    it('renders both named-publication and scope rows from the same observeActive subscription', () => {
        mockObservedRows = [makeNamedPref(), makeScopePref()];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        expect(getByTestId('row-pref1')).toBeTruthy();
        expect(getByTestId('row-scope1')).toBeTruthy();
    });

    it('named-publication boost writes the publisher target with its name', async () => {
        mockObservedRows = [makeNamedPref()];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-pref1-boost'));
        await waitFor(() =>
            expect(mockSetSourcePrefFromUi).toHaveBeenCalledWith({ kind: 'publisher', names: ['The Times'] }, 'prioritised'),
        );
    });

    it('scope boost keeps the country target, converted to alpha-2 once', async () => {
        mockObservedRows = [makeScopePref()];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-scope1-boost'));
        await waitFor(() =>
            expect(mockSetSourcePrefFromUi).toHaveBeenCalledWith(
                { kind: 'country', countryAlpha2: 'IN', label: 'India' },
                'prioritised',
            ),
        );
        expect(mockApplyPersonaAction).not.toHaveBeenCalled();
    });

    it('scope clear writes "none" through the country target', async () => {
        mockObservedRows = [makeScopePref()];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-scope1-clear'));
        await waitFor(() =>
            expect(mockSetSourcePrefFromUi).toHaveBeenCalledWith(
                { kind: 'country', countryAlpha2: 'IN', label: 'India' },
                'none',
            ),
        );
    });

    describe('one row per publication', () => {
        const rows = () => [
            makeNamedPref({ id: 'p-main', publicationName: 'The Hindu', weight: 1 }),
            makeNamedPref({ id: 'p-biz', publicationName: 'The Hindu BusinessLine', weight: -0.5 }),
            makeNamedPref({ id: 'p-other', publicationName: 'Deccan Herald', weight: 1 }),
        ];

        beforeEach(() => {
            rememberPublisherSourceNames('pub-hindu', ['The Hindu', 'The Hindu BusinessLine']);
        });

        it('collapses a publication whose sources are named differently into one row', () => {
            mockObservedRows = rows();
            const { queryAllByTestId, getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
            expect(queryAllByTestId(/^row-p-(main|biz)$/)).toHaveLength(1);
            // The row shows the strongest setting: fewer wins over more.
            expect(getByTestId('row-p-biz')).toBeTruthy();
            // An unrelated publication keeps its own row.
            expect(getByTestId('row-p-other')).toBeTruthy();
        });

        it('clearing the row clears every name in the group', async () => {
            mockObservedRows = rows();
            const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
            fireEvent.press(getByTestId('row-p-biz-clear'));
            await waitFor(() => expect(mockSetSourcePrefFromUi).toHaveBeenCalledTimes(1));
            const [target, level] = mockSetSourcePrefFromUi.mock.calls[0] as any[];
            expect(level).toBe('none');
            expect(target.kind).toBe('publisher');
            expect([...target.names].sort()).toEqual(['The Hindu', 'The Hindu BusinessLine']);
        });

        it('mute reaches every name in the group', async () => {
            mockObservedRows = rows();
            const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
            fireEvent.press(getByTestId('row-p-biz-mute'));
            await waitFor(() => expect(mockApplyPersonaAction).toHaveBeenCalledTimes(2));
            const muted = mockApplyPersonaAction.mock.calls.map((c: any[]) => c[0].publicationId).sort();
            expect(muted).toEqual(['The Hindu', 'The Hindu BusinessLine']);
            for (const c of mockApplyPersonaAction.mock.calls as any[]) {
                expect(c[0]).toEqual(expect.objectContaining({ action_type: 'set_publication_pref', publicationPref: 'mute' }));
            }
        });

        it('a name the device cannot tie to one publisher stays its own row', () => {
            mockObservedRows = [...rows(), makeNamedPref({ id: 'p-unknown', publicationName: 'Hindu Tamil', weight: 1 })];
            const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
            expect(getByTestId('row-p-unknown')).toBeTruthy();
            expect(getByTestId('row-p-biz')).toBeTruthy();
        });
    });

    it('keys busy state on pref.id, so a scope row and a same-named publication row never share a busy lock', async () => {
        // Both rows share the label "India" — under the old name-keyed busy
        // state, pressing one would mark BOTH busy. Leave applyPersonaAction
        // (the named-publication path) unresolved so the busy flag stays set
        // long enough to observe.
        mockSetSourcePrefFromUi.mockReturnValue(new Promise(() => {}));
        mockObservedRows = [
            makeScopePref({ id: 'scope1', publicationName: 'India' }),
            makeNamedPref({ id: 'pubIndia', publicationName: 'India' }),
        ];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-pubIndia-boost'));
        await waitFor(() => expect(getByTestId('row-pubIndia-busy').props.children).toBe('true'));
        // The id-keyed scope row must NOT be dragged into the named row's busy
        // lock just because they share a display label.
        expect(getByTestId('row-scope1-busy').props.children).toBe('false');
    });

    it('keeps one row open at a time', () => {
        mockObservedRows = [makeNamedPref({ id: 'a', publicationName: 'A', weight: 1 }), makeNamedPref({ id: 'b', publicationName: 'B', weight: 1 })];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-a-toggle'));
        expect(getByTestId('row-a-open').props.children).toBe('true');
        fireEvent.press(getByTestId('row-b-toggle'));
        expect(getByTestId('row-a-open').props.children).toBe('false');
        expect(getByTestId('row-b-open').props.children).toBe('true');
    });

    it('says how to adjust a source when nothing is adjusted', () => {
        mockObservedRows = [];
        const { getByTestId, queryByText } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        expect(getByTestId('sources-empty')).toBeTruthy();
        expect(queryByText('you.sources.adjusted')).toBeNull();
    });
});
