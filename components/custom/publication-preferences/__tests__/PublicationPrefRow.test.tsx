/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
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

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// The real service module opens the native WatermelonDB/SQLite adapter at
// import time — mock it with the same pure classifier so the row renders
// without touching the database, mirroring how the screen's own test mocks it.
jest.mock('@/lib/database/services/publication-preference-service', () => ({
    weightToPrefKind: (weight: number) => {
        if (weight <= -0.9) return 'mute';
        if (weight < 0) return 'deprioritize';
        if (weight > 0) return 'boost';
        return null;
    },
}));

import PublicationPrefRow from '../PublicationPrefRow';

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

describe('PublicationPrefRow', () => {
    it('renders a named-publication row with no kind chip', () => {
        const pref = makeNamedPref();
        const { getByTestId, queryByTestId } = render(
            <PublicationPrefRow pref={pref} busy={false} onSetKind={jest.fn()} onClear={jest.fn()} />,
        );
        expect(getByTestId('pub-pref-the-times')).toBeTruthy();
        expect(queryByTestId('pub-pref-the-times-kind-chip')).toBeNull();
    });

    it('renders a source-scope row with a "Country" kind chip so it never reads as a publication', () => {
        const pref = makeScopePref();
        const { getByTestId, getByText } = render(
            <PublicationPrefRow pref={pref} busy={false} onSetKind={jest.fn()} onClear={jest.fn()} />,
        );
        expect(getByTestId('pub-pref-scope-country-ind-kind-chip')).toBeTruthy();
        expect(getByText('Country')).toBeTruthy();
    });

    it('keys a scope row testID off scopeValue, not the label, so it never collides with a same-named publication', () => {
        const scope = makeScopePref({ publicationName: 'India', scopeValue: 'IND' });
        const namedPub = makeNamedPref({ publicationName: 'India' });
        const { getByTestId } = render(
            <>
                <PublicationPrefRow pref={scope} busy={false} onSetKind={jest.fn()} onClear={jest.fn()} />
                <PublicationPrefRow pref={namedPub} busy={false} onSetKind={jest.fn()} onClear={jest.fn()} />
            </>,
        );
        expect(getByTestId('pub-pref-scope-country-ind')).toBeTruthy();
        expect(getByTestId('pub-pref-india')).toBeTruthy();
    });

    it('passes the whole pref object (not just the name) to onSetKind and onClear', () => {
        const pref = makeScopePref();
        const onSetKind = jest.fn();
        const onClear = jest.fn();
        const { getByTestId } = render(
            <PublicationPrefRow pref={pref} busy={false} onSetKind={onSetKind} onClear={onClear} />,
        );
        fireEvent.press(getByTestId('pub-pref-scope-country-ind-boost'));
        expect(onSetKind).toHaveBeenCalledWith(pref, 'boost');
        fireEvent.press(getByTestId('pub-pref-scope-country-ind-clear'));
        expect(onClear).toHaveBeenCalledWith(pref);
    });

    it('disables the kind + clear controls while busy (presses are no-ops)', () => {
        const pref = makeNamedPref();
        const onSetKind = jest.fn();
        const onClear = jest.fn();
        const { getByTestId } = render(
            <PublicationPrefRow pref={pref} busy onSetKind={onSetKind} onClear={onClear} />,
        );
        fireEvent.press(getByTestId('pub-pref-the-times-boost'));
        fireEvent.press(getByTestId('pub-pref-the-times-clear'));
        expect(onSetKind).not.toHaveBeenCalled();
        expect(onClear).not.toHaveBeenCalled();
    });
});
