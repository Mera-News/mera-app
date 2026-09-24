/* eslint-disable @typescript-eslint/no-require-imports */
// F1: a blocked install shows ForceUpdateScreen in place of the app, so no
// route ever releases the held splash. The gate must release it itself.
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/ForceUpdateScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="force-update" /> };
});
jest.mock('@/lib/config/endpoints', () => ({ FORCE_UPDATE_CHECK_IN_DEV: true }));
let mockMin: string | null = '99.0.0';
jest.mock('@/lib/app-version-service', () => ({
    AppVersionService: { getVersionInfo: async () => ({ minSupportedVersion: mockMin, storeUrl: null }) },
}));
jest.mock('@/lib/version', () => ({
    getAppVersion: () => '1.3.1',
    isVersionOlder: (a: string, b: string) => a !== b && b === '99.0.0',
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/scheduler/AppScheduler', () => ({ AppScheduler: { suspend: jest.fn() } }));
jest.mock('@/lib/utils/transient-error', () => ({ isTransientNetworkError: () => false }));
const mockReleaseSplash = jest.fn();
jest.mock('@/lib/splash-hold', () => ({ releaseSplash: (r: string) => mockReleaseSplash(r) }));

import NativeUpdateGate from '../NativeUpdateGate';

beforeEach(() => mockReleaseSplash.mockClear());

it('releases the splash when it blocks on an update', async () => {
    mockMin = '99.0.0';
    const r = render(<NativeUpdateGate><></></NativeUpdateGate>);
    await waitFor(() => r.getByTestId('force-update'));
    expect(mockReleaseSplash).toHaveBeenCalledWith('force-update');
});

it('leaves the splash to the router when the version is fine', async () => {
    mockMin = null;
    const { View } = require('react-native');
    const r = render(<NativeUpdateGate><View testID="app" /></NativeUpdateGate>);
    await waitFor(() => r.getByTestId('app'));
    expect(mockReleaseSplash).not.toHaveBeenCalled();
});
