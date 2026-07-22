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
    useTranslation: () => ({ t: (k: string, o?: any) => (o?.date != null ? `${k}:${o.date}` : k) }),
}));

// jest-expo mis-transforms RN's ScrollView native-component file ("Unexpected
// token 'export'"), which FlatList pulls in transitively. Proxy RN so
// ScrollView renders as a plain View; every other export stays lazy/real.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
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
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const Passthrough = (p: any) => <View {...p} />;
    const Modal = ({ isOpen, children, ...rest }: any) => (isOpen ? <View {...rest}>{children}</View> : null);
    return {
        Modal,
        ModalBackdrop: Passthrough,
        ModalContent: Passthrough,
        ModalHeader: Passthrough,
        ModalBody: Passthrough,
        ModalFooter: Passthrough,
    };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// --- child components → light stubs ----------------------------------------
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ title, subtitle, onBack, rightAction }: any) => (
            <View>
                <Pressable accessibilityLabel="drilldown-back" onPress={onBack} />
                <Text>{title}</Text>
                {subtitle ? <Text>{subtitle}</Text> : null}
                {rightAction}
            </View>
        ),
    };
});
jest.mock('../WeightSegments', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: () => <Text>weight-segments</Text> };
});

// AddLocationView is refactored/tested on its own — stub it here so
// LocationsScreen tests exercise only the toggle + wiring, not its internals.
const mockAddLocationView = jest.fn();
jest.mock('../AddLocationView', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: (props: any) => {
            mockAddLocationView(props);
            return (
                <View testID="add-location-panel">
                    <Pressable accessibilityLabel="panel-close" onPress={props.onClose} />
                    <Pressable accessibilityLabel="panel-saved" onPress={props.onSaved} />
                    <Text>{props.renderIdle ? 'has-render-idle' : 'no-render-idle'}</Text>
                    {props.renderIdle()}
                </View>
            );
        },
    };
});

// --- services / stores ------------------------------------------------------
let mockObservedRows: any[] = [];
const mockObserveAll = jest.fn(() => ({
    subscribe: (cb: (rows: any[]) => void) => {
        cb(mockObservedRows);
        return { unsubscribe: jest.fn() };
    },
}));
const mockSetPinnedForWeather = jest.fn();
jest.mock('@/lib/database/services/location-service', () => ({
    observeAll: () => mockObserveAll(),
    setPinnedForWeather: (...a: unknown[]) => mockSetPinnedForWeather(...a),
}));

const mockDeleteUserLocation = jest.fn();
const mockSetLocationWeightLogged = jest.fn();
jest.mock('@/lib/database/services/location-persona-actions', () => ({
    deleteUserLocation: (...a: unknown[]) => mockDeleteUserLocation(...a),
    setLocationWeightLogged: (...a: unknown[]) => mockSetLocationWeightLogged(...a),
}));

jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/toast-manager', () => ({
    toastManager: { showInfo: jest.fn(), showError: jest.fn() },
}));

import LocationsScreen from '../LocationsScreen';

function makeLocation(overrides: Record<string, unknown> = {}) {
    return {
        id: 'loc1',
        city: 'Amsterdam',
        region: null,
        countryCode: 'NL',
        role: 'home',
        weight: 0.6,
        validUntil: null,
        pinnedForWeather: false,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockObservedRows = [];
});

describe('LocationsScreen', () => {
    it('renders the saved-places list directly when the search panel is closed', () => {
        mockObservedRows = [makeLocation()];
        const { queryByTestId, getByText } = render(<LocationsScreen onBack={jest.fn()} />);
        expect(queryByTestId('add-location-panel')).toBeNull();
        expect(getByText('Amsterdam, NL')).toBeTruthy();
    });

    it('the + header action opens the inline search panel in place of a full-screen swap', () => {
        mockObservedRows = [makeLocation()];
        const { getByLabelText, getByTestId } = render(<LocationsScreen onBack={jest.fn()} />);
        fireEvent.press(getByLabelText('locations.add'));
        expect(getByTestId('add-location-panel')).toBeTruthy();
    });

    it('passes the saved list to AddLocationView as renderIdle (list stays part of the same screen)', () => {
        mockObservedRows = [makeLocation({ city: 'Berlin', countryCode: 'DE' })];
        const { getByLabelText, getByText } = render(<LocationsScreen onBack={jest.fn()} />);
        fireEvent.press(getByLabelText('locations.add'));
        expect(getByText('has-render-idle')).toBeTruthy();
        // renderIdle() was invoked inline by the stub and rendered the real list.
        expect(getByText('Berlin, DE')).toBeTruthy();
    });

    it('closing the panel (via its onClose) collapses back to the plain list + "+" header action', () => {
        mockObservedRows = [makeLocation()];
        const { getByLabelText, queryByTestId } = render(<LocationsScreen onBack={jest.fn()} />);
        fireEvent.press(getByLabelText('locations.add'));
        expect(queryByTestId('add-location-panel')).toBeTruthy();

        fireEvent.press(getByLabelText('panel-close'));
        expect(queryByTestId('add-location-panel')).toBeNull();
        expect(getByLabelText('locations.add')).toBeTruthy();
    });

    it('a save (via onSaved) also collapses the panel back to the list', () => {
        mockObservedRows = [makeLocation()];
        const { getByLabelText, queryByTestId } = render(<LocationsScreen onBack={jest.fn()} />);
        fireEvent.press(getByLabelText('locations.add'));
        fireEvent.press(getByLabelText('panel-saved'));
        expect(queryByTestId('add-location-panel')).toBeNull();
    });

    it('the empty-state "add first place" CTA opens the same inline search panel', async () => {
        mockObservedRows = [];
        const { getByText, getByTestId } = render(<LocationsScreen onBack={jest.fn()} />);
        fireEvent.press(getByText('locations.addFirst'));
        await waitFor(() => expect(getByTestId('add-location-panel')).toBeTruthy());
    });
});
