/* eslint-disable @typescript-eslint/no-require-imports */
// S10 welcome-back screen: copy, the Support ID handoff, and the single
// continue affordance. Gating lives UPSTREAM (device-auth's welcomeBack
// verdict + AuthScreen's routing spec) — this screen is deliberately dumb.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable: (p: any) => <Pressable {...p} /> };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
    router: { replace: (...a: any[]) => mockRouterReplace(...a) },
}));

const mockGetSupportId = jest.fn(async (..._a: unknown[]): Promise<string | null> => null);
jest.mock('@/lib/support-id', () => ({
    getSupportId: (...a: unknown[]) => mockGetSupportId(...a),
}));

import WelcomeBackScreen from '../WelcomeBackScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupportId.mockResolvedValue(null);
});

it('shows the headline, the body, and a continue button that lands on /logged-in', async () => {
    const { findByText, findByTestId } = render(<WelcomeBackScreen />);

    expect(await findByText('welcomeBack.title')).toBeTruthy();
    expect(await findByText('welcomeBack.body')).toBeTruthy();

    const cta = await findByTestId('welcome-back-continue');
    expect(cta.props.accessibilityRole).toBe('button');
    expect(cta.props.accessibilityLabel).toBe('welcomeBack.continue');
    fireEvent.press(cta);
    expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in');
});

it('shows the Support ID with the save hint when the account has one, hides it otherwise', async () => {
    mockGetSupportId.mockResolvedValue('1234567');
    const withId = render(<WelcomeBackScreen />);
    expect(await withId.findByTestId('welcome-back-support-id')).toBeTruthy();
    expect(await withId.findByText('support.saveHint')).toBeTruthy();
    withId.unmount();

    mockGetSupportId.mockResolvedValue(null);
    const withoutId = render(<WelcomeBackScreen />);
    await withoutId.findByText('welcomeBack.title');
    await waitFor(() => expect(mockGetSupportId).toHaveBeenCalled());
    expect(withoutId.queryByTestId('welcome-back-support-id')).toBeNull();
});

it('wrappers are not accessibility elements (F2 discipline)', async () => {
    const { findByTestId } = render(<WelcomeBackScreen />);
    const root = await findByTestId('welcome-back-root');
    expect(root.props.accessible).toBe(false);
    expect(root.props.accessibilityLabel).toBeUndefined();
});
