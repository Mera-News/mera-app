/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: () => <View /> }; });
jest.mock('@/components/ui/input', () => {
    const { View, TextInput } = require('react-native');
    return { Input: ({ children }: any) => <View>{children}</View>, InputSlot: ({ children }: any) => <View>{children}</View>, InputField: (p: any) => <TextInput {...p} /> };
});
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/lib/hooks/use-debounced-value', () => ({ useDebouncedValue: (v: string) => v }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/stores/publication-display-store', () => ({ DisplayPublicationName: () => null }));
jest.mock('@/lib/database/services/publication-preference-service', () => ({ weightToPrefKind: () => null }));
jest.mock('@/lib/source-service', () => ({
    __esModule: true,
    default: {
        searchPublishers: async () => ({ publishers: [{ _id: 'pub1', name: 'Bild', country_code: 'DEU' }] }),
    },
}));
const mockResolve = jest.fn(async (..._a: unknown[]) => ['Bild', 'Bild Plus']);
jest.mock('@/lib/subscriptions/publisher-sources', () => ({
    resolveSubscriptionSourceNames: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock('@/lib/database/services/publisher-source-names', () => ({
    rememberPublisherSourceNames: jest.fn(),
    resolvePublicationPrefNames: async () => ['Bild'],
}));
const mockSetKind = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../set-publisher-kind', () => ({ setPublisherKind: (...a: unknown[]) => mockSetKind(...a) }));

import SourceSearch from '../SourceSearch';

async function openBild() {
    const r = render(<SourceSearch />);
    fireEvent.changeText(r.getByTestId('sources-search'), 'Bil');
    await waitFor(() => r.getByTestId('sources-hit-bild'));
    fireEvent.press(r.getByTestId('sources-hit-bild'));
    return r;
}

beforeEach(() => jest.clearAllMocks());

it('a result opens More, Fewer and Mute in place and writes under every source name', async () => {
    const r = await openBild();
    await act(async () => { fireEvent.press(r.getByTestId('sources-hit-bild-mute')); });
    expect(mockResolve).toHaveBeenCalledWith('pub1', 'Bild');
    expect(mockSetKind).toHaveBeenCalledWith(['Bild', 'Bild Plus'], 'mute');
    // Closes once set; the publication joins the Adjusted list.
    expect(r.queryByTestId('sources-hit-bild-mute')).toBeNull();
});

it('falls back to the names the device knows when the server cannot list sources', async () => {
    mockResolve.mockRejectedValueOnce(new Error('offline'));
    const r = await openBild();
    await act(async () => { fireEvent.press(r.getByTestId('sources-hit-bild-deprioritize')); });
    expect(mockSetKind).toHaveBeenCalledWith(['Bild'], 'deprioritize');
});

it('asks for two characters before searching', () => {
    const r = render(<SourceSearch />);
    fireEvent.changeText(r.getByTestId('sources-search'), 'B');
    expect(r.getByText('subscriptions.searchTooShort')).toBeTruthy();
});
