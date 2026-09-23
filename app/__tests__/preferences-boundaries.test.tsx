// S7: a crash inside one settings screen used to reach the ROOT boundary,
// which swaps the whole app for a fallback. Each preferences route now holds
// its own screen boundary, so only that page shows the retry.
import { render } from '@testing-library/react-native';
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
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('expo-router', () => ({
    useRouter: () => ({ back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    Stack: { Screen: () => null },
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: ({ children }: any) => <Pressable>{children}</Pressable>, ButtonText: ({ children }: any) => <Text>{children}</Text> };
});
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });

function mockBoom(): never {
    throw new Error('screen crashed');
}
jest.mock('@/components/custom/config-mera/DisplaySettingsScreen', () => ({ __esModule: true, default: () => mockBoom() }));
jest.mock('@/components/custom/config-mera/LanguageSettingsScreen', () => ({ __esModule: true, default: () => mockBoom() }));
jest.mock('@/components/custom/config-mera/ManageDataScreen', () => ({ __esModule: true, default: () => mockBoom() }));
jest.mock('@/components/custom/config-mera/ManageSubscriptionScreen', () => ({ __esModule: true, default: () => mockBoom() }));
jest.mock('@/components/custom/config-mera/MeraProtocolSettingsScreen', () => ({ __esModule: true, default: () => mockBoom() }));
jest.mock('@/components/custom/config-mera/NotificationSettingsScreen', () => ({ __esModule: true, default: () => mockBoom() }));
jest.mock('@/components/custom/config-mera/ObservabilityScreen', () => ({ __esModule: true, default: () => mockBoom() }));

const ROUTES: [string, () => React.ComponentType][] = [
    ['display', () => require('../logged-in/preferences/display').default],
    ['language', () => require('../logged-in/preferences/language').default],
    ['manage-data', () => require('../logged-in/preferences/manage-data').default],
    ['manage-subscription', () => require('../logged-in/preferences/manage-subscription').default],
    ['mera-protocol', () => require('../logged-in/preferences/mera-protocol').default],
    ['notifications', () => require('../logged-in/preferences/notifications').default],
    ['observability', () => require('../logged-in/preferences/observability').default],
];

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    (console.error as jest.Mock).mockRestore();
});

describe.each(ROUTES)('preferences/%s', (_name, load) => {
    it('keeps a crash inside its own screen boundary', () => {
        const Route = load();
        const r = render(<Route />);
        expect(r.getByText('errors.somethingWentWrong')).toBeTruthy();
    });
});
