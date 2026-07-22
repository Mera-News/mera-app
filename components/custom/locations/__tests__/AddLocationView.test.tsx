/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

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
    useTranslation: () => ({ t: (k: string) => k }),
}));

// jest-expo mis-transforms RN's ScrollView native-component file ("Unexpected
// token 'export'"), which FlatList pulls in transitively. Proxy RN so
// ScrollView renders as a plain View; every other export stays lazy/real.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    // VirtualizedList reads `ScrollView.Context.Consumer` (dev-only nesting
    // check) — a fresh dummy context satisfies the shape without pulling in
    // the real ScrollView native-component file (which jest-expo mis-parses).
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return StubScrollView;
            }
            return (target as any)[prop];
        },
    });
});

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text: RNText } = require('react-native'); return { Text: RNText }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text: RNText } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <RNText {...p} /> };
});
jest.mock('@/components/ui/input', () => {
    const { View, TextInput } = require('react-native');
    return {
        Input: (p: any) => <View {...p} />,
        InputField: (p: any) => <TextInput {...p} />,
        InputSlot: (p: any) => <View {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// --- child components → light stubs ----------------------------------------
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => {
    const { View, Text: RNText, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ title, onBack, rightAction }: any) => (
            <View>
                <Pressable accessibilityLabel="drilldown-back" onPress={onBack} />
                <RNText>{title}</RNText>
                {rightAction}
            </View>
        ),
    };
});
jest.mock('../LocationRolePicker', () => {
    const { Text: RNText } = require('react-native');
    return { __esModule: true, default: () => <RNText>role-picker</RNText> };
});
jest.mock('../WeightSegments', () => {
    const { Text: RNText } = require('react-native');
    return { __esModule: true, default: () => <RNText>weight-segments</RNText> };
});

// --- services -----------------------------------------------------------
jest.mock('@/lib/account-service', () => ({
    AccountService: { getAllCountries: jest.fn().mockResolvedValue([]) },
}));
const mockAddUserLocation = jest.fn();
jest.mock('@/lib/database/services/location-persona-actions', () => ({
    addUserLocation: (...a: unknown[]) => mockAddUserLocation(...a),
}));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/toast-manager', () => ({
    toastManager: { showInfo: jest.fn(), showError: jest.fn() },
}));

const mockSearchPlaces = jest.fn();
jest.mock('@/lib/place-service', () => ({
    searchPlaces: (...a: unknown[]) => mockSearchPlaces(...a),
}));

import AddLocationView from '../AddLocationView';

function makePlace(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'p1',
        city: 'Amsterdam',
        region: 'North Holland',
        countryCode: 'NL',
        displayName: 'Amsterdam, North Holland, NL',
        normalized: 'amsterdam',
        population: 900000,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockAddUserLocation.mockResolvedValue({ updated: false });
});

describe('AddLocationView (inline search panel)', () => {
    it('defers to renderIdle on mount (empty query) and skips the search call below 2 chars', async () => {
        const renderIdle = jest.fn(() => <Text>IDLE-LIST</Text>);
        const { getByPlaceholderText, getByText, queryByText } = render(
            <AddLocationView onClose={jest.fn()} onSaved={jest.fn()} renderIdle={renderIdle} />,
        );

        expect(getByText('IDLE-LIST')).toBeTruthy();

        fireEvent.changeText(getByPlaceholderText('locations.searchPlaceholder'), 'a');
        await waitFor(() => expect(queryByText('IDLE-LIST')).toBeNull());

        // Give the 250ms debounce a chance to fire — it must not, below 2 chars.
        await new Promise((r) => setTimeout(r, 400));
        expect(mockSearchPlaces).not.toHaveBeenCalled();
        expect(queryByText('locations.noMatches')).toBeNull();
        expect(queryByText('locations.searchUnavailable')).toBeNull();
    });

    it('renders results inline when the service resolves ok', async () => {
        mockSearchPlaces.mockResolvedValueOnce({ ok: true, places: [makePlace()] });
        const { getByPlaceholderText, getByText } = render(
            <AddLocationView onClose={jest.fn()} onSaved={jest.fn()} renderIdle={() => <Text>IDLE-LIST</Text>} />,
        );

        fireEvent.changeText(getByPlaceholderText('locations.searchPlaceholder'), 'amster');
        await waitFor(() => expect(mockSearchPlaces).toHaveBeenCalledWith('amster'), { timeout: 2000 });
        await waitFor(() => expect(getByText('Amsterdam, North Holland, NL')).toBeTruthy());
    });

    it('shows the "search unavailable" state (not "no matches") when the service resolves ok:false', async () => {
        mockSearchPlaces.mockResolvedValueOnce({ ok: false });
        const { getByPlaceholderText, getByText, queryByText } = render(
            <AddLocationView onClose={jest.fn()} onSaved={jest.fn()} renderIdle={() => <Text>IDLE-LIST</Text>} />,
        );

        fireEvent.changeText(getByPlaceholderText('locations.searchPlaceholder'), 'berlin');
        await waitFor(() => expect(getByText('locations.searchUnavailable')).toBeTruthy(), { timeout: 2000 });
        expect(queryByText('locations.noMatches')).toBeNull();
    });

    it('shows "no matches" (not "unavailable") when the service resolves an empty ok list', async () => {
        mockSearchPlaces.mockResolvedValueOnce({ ok: true, places: [] });
        const { getByPlaceholderText, getByText, queryByText } = render(
            <AddLocationView onClose={jest.fn()} onSaved={jest.fn()} renderIdle={() => <Text>IDLE-LIST</Text>} />,
        );

        fireEvent.changeText(getByPlaceholderText('locations.searchPlaceholder'), 'nowhere');
        await waitFor(() => expect(getByText('locations.noMatches')).toBeTruthy(), { timeout: 2000 });
        expect(queryByText('locations.searchUnavailable')).toBeNull();
    });

    it('selecting a result advances to the role/weight configure step (same components, inline)', async () => {
        mockSearchPlaces.mockResolvedValueOnce({ ok: true, places: [makePlace()] });
        const { getByPlaceholderText, getByText } = render(
            <AddLocationView onClose={jest.fn()} onSaved={jest.fn()} renderIdle={() => <Text>IDLE-LIST</Text>} />,
        );

        fireEvent.changeText(getByPlaceholderText('locations.searchPlaceholder'), 'amster');
        await waitFor(() => expect(getByText('Amsterdam, North Holland, NL')).toBeTruthy());
        fireEvent.press(getByText('Amsterdam, North Holland, NL'));

        expect(getByText('role-picker')).toBeTruthy();
        expect(getByText('weight-segments')).toBeTruthy();
        expect(getByText('locations.saveCta')).toBeTruthy();
    });

    it('saving calls addUserLocation and then onSaved', async () => {
        mockSearchPlaces.mockResolvedValueOnce({ ok: true, places: [makePlace()] });
        const onSaved = jest.fn();
        const { getByPlaceholderText, getByText } = render(
            <AddLocationView onClose={jest.fn()} onSaved={onSaved} renderIdle={() => <Text>IDLE-LIST</Text>} />,
        );

        fireEvent.changeText(getByPlaceholderText('locations.searchPlaceholder'), 'amster');
        await waitFor(() => expect(getByText('Amsterdam, North Holland, NL')).toBeTruthy());
        fireEvent.press(getByText('Amsterdam, North Holland, NL'));
        fireEvent.press(getByText('locations.saveCta'));

        await waitFor(() => expect(mockAddUserLocation).toHaveBeenCalledWith(
            expect.objectContaining({ city: 'Amsterdam', countryCode: 'NL' }),
        ));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    it('the trailing icon closes the whole panel via onClose when the query is empty', () => {
        const onClose = jest.fn();
        const { getByLabelText } = render(
            <AddLocationView onClose={onClose} onSaved={jest.fn()} renderIdle={() => <Text>IDLE-LIST</Text>} />,
        );
        fireEvent.press(getByLabelText('common.cancel'));
        expect(onClose).toHaveBeenCalled();
    });

    it('the trailing icon clears (not closes) when the query is non-empty, restoring the idle list', async () => {
        const onClose = jest.fn();
        const { getByPlaceholderText, getByLabelText, getByText } = render(
            <AddLocationView onClose={onClose} onSaved={jest.fn()} renderIdle={() => <Text>IDLE-LIST</Text>} />,
        );

        fireEvent.changeText(getByPlaceholderText('locations.searchPlaceholder'), 'a');
        fireEvent.press(getByLabelText('common.cancel'));

        expect(onClose).not.toHaveBeenCalled();
        await waitFor(() => expect(getByText('IDLE-LIST')).toBeTruthy());
    });
});
