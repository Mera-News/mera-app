/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

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
// here so this suite exercises only the screen's wiring (busy-key, which
// branch each handler takes, what it calls).
jest.mock('../PublicationPrefRow', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ pref, busy, onSetKind, onClear }: any) => (
            <View testID={`row-${pref.id}`}>
                <Text>{pref.publicationName}</Text>
                <Text testID={`row-${pref.id}-busy`}>{String(busy)}</Text>
                <Pressable testID={`row-${pref.id}-boost`} onPress={() => onSetKind(pref, 'boost')} />
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
const mockGetPreferenceKind = jest.fn(async () => 'mute');
const mockSetPreferenceKind = jest.fn(async () => {});
const mockGetScopePreferenceKind = jest.fn(async () => 'none');
const mockSetScopePreferenceKind = jest.fn(async () => {});
jest.mock('@/lib/database/services/publication-preference-service', () => ({
    observeActive: () => mockObserveActive(),
    getPreferenceKind: (...a: unknown[]) => mockGetPreferenceKind(...a),
    setPreferenceKind: (...a: unknown[]) => mockSetPreferenceKind(...a),
    getScopePreferenceKind: (...a: unknown[]) => mockGetScopePreferenceKind(...a),
    setScopePreferenceKind: (...a: unknown[]) => mockSetScopePreferenceKind(...a),
}));

const mockApplyPersonaAction = jest.fn(async () => ({ applied: true, summary: 'ok' }));
jest.mock('@/lib/database/services/persona-action-executor', () => ({
    applyPersonaAction: (...a: unknown[]) => mockApplyPersonaAction(...a),
}));

const mockAppend = jest.fn(async () => ({ id: 'log1' }));
jest.mock('@/lib/database/services/persona-change-log-service', () => ({
    append: (...a: unknown[]) => mockAppend(...a),
}));

const mockMarkFeedNeedsRefresh = jest.fn();
const mockRunSweepFor = jest.fn(async () => false);
const mockSweepForMutation = jest.fn(() => 'unexclude');
jest.mock('@/lib/database/services/persona-mutation-sweeps', () => ({
    markFeedNeedsRefresh: (...a: unknown[]) => mockMarkFeedNeedsRefresh(...a),
    runSweepFor: (...a: unknown[]) => mockRunSweepFor(...a),
    sweepForMutation: (...a: unknown[]) => mockSweepForMutation(...a),
}));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

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

    it('named-publication set-kind routes through applyPersonaAction with SET_PUBLICATION_PREF', async () => {
        mockObservedRows = [makeNamedPref()];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-pref1-boost'));
        await waitFor(() => expect(mockApplyPersonaAction).toHaveBeenCalledTimes(1));
        expect(mockApplyPersonaAction).toHaveBeenCalledWith(
            expect.objectContaining({
                action_type: 'set_publication_pref',
                publicationId: 'The Times',
                publicationPref: 'boost',
            }),
            'user',
        );
        expect(mockSetScopePreferenceKind).not.toHaveBeenCalled();
    });

    it('scope set-kind does NOT go through applyPersonaAction — it calls setScopePreferenceKind + hand-appends the change-log row (TODO(source-pref P3))', async () => {
        mockObservedRows = [makeScopePref()];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-scope1-boost'));
        await waitFor(() => expect(mockSetScopePreferenceKind).toHaveBeenCalledTimes(1));
        expect(mockApplyPersonaAction).not.toHaveBeenCalled();
        expect(mockSetScopePreferenceKind).toHaveBeenCalledWith(
            { scopeKind: 'country', scopeValue: 'IND' },
            'boost',
            'India',
            'user',
        );
        expect(mockAppend).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: 'set_source_scope_pref' }),
        );
        // Scopes are never hard filters — no sweep, just a dirty-flag.
        expect(mockRunSweepFor).not.toHaveBeenCalled();
        expect(mockMarkFeedNeedsRefresh).toHaveBeenCalledTimes(1);
    });

    it('named-publication clear hand-appends the change-log row AND runs the un-exclude sweep (the P4 asymmetry fix)', async () => {
        mockObservedRows = [makeNamedPref()];
        mockGetPreferenceKind.mockResolvedValue('mute' as any);
        mockSweepForMutation.mockReturnValue('unexclude' as any);
        mockRunSweepFor.mockResolvedValue(false as any); // unexclude never reports "purged"
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-pref1-clear'));
        await waitFor(() => expect(mockSetPreferenceKind).toHaveBeenCalledWith('The Times', 'none', 'user'));
        expect(mockAppend).toHaveBeenCalledWith(
            expect.objectContaining({
                actionType: 'set_publication_pref',
                action: { targetId: 'The Times', before: 'mute', after: 'none' },
            }),
        );
        expect(mockSweepForMutation).toHaveBeenCalledWith({
            actionType: 'set_publication_pref',
            prefBefore: 'mute',
            prefAfter: 'none',
        });
        expect(mockRunSweepFor).toHaveBeenCalledWith('unexclude', 'set_publication_pref');
        // runSweepFor resolved false (not a successful purge) → the screen must
        // still mark the feed dirty, exactly like applyPersonaAction would.
        expect(mockMarkFeedNeedsRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not double-dirty the feed when the sweep already reconciled it (a purge that reports true)', async () => {
        mockObservedRows = [makeNamedPref()];
        mockRunSweepFor.mockResolvedValue(true as any);
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-pref1-clear'));
        await waitFor(() => expect(mockRunSweepFor).toHaveBeenCalledTimes(1));
        expect(mockMarkFeedNeedsRefresh).not.toHaveBeenCalled();
    });

    it('scope clear calls setScopePreferenceKind with "none" and hand-appends, without touching the named-publication service calls', async () => {
        mockObservedRows = [makeScopePref()];
        const { getByTestId } = render(<PublicationPreferencesScreen onBack={jest.fn()} />);
        fireEvent.press(getByTestId('row-scope1-clear'));
        await waitFor(() =>
            expect(mockSetScopePreferenceKind).toHaveBeenCalledWith(
                { scopeKind: 'country', scopeValue: 'IND' },
                'none',
                'India',
                'user',
            ),
        );
        expect(mockSetPreferenceKind).not.toHaveBeenCalled();
        expect(mockMarkFeedNeedsRefresh).toHaveBeenCalledTimes(1);
    });

    it('keys busy state on pref.id, so a scope row and a same-named publication row never share a busy lock', async () => {
        // Both rows share the label "India" — under the old name-keyed busy
        // state, pressing one would mark BOTH busy. Leave applyPersonaAction
        // (the named-publication path) unresolved so the busy flag stays set
        // long enough to observe.
        mockApplyPersonaAction.mockReturnValue(new Promise(() => {}));
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
});
