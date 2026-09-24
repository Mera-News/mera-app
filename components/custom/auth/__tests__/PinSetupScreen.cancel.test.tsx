/* eslint-disable @typescript-eslint/no-require-imports */
// C-SEC measured the PIN setup Cancel at 45x21pt; it needs a 44pt frame.
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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/auth/PinKeypad', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), captureException: jest.fn() } }));
jest.mock('@/lib/security/pin-service', () => ({ setPin: jest.fn() }));
jest.mock('@/lib/stores/pin-store', () => ({ usePinStore: (sel: any) => sel({ setPinSet: jest.fn(), refresh: jest.fn() }) }));

import PinSetupScreen from '../PinSetupScreen';

it('gives Cancel a 44pt frame and still cancels', () => {
    const onCancel = jest.fn();
    const r = render(<PinSetupScreen onComplete={jest.fn()} onCancel={onCancel} />);
    const cancel = r.getByTestId('pin-setup-cancel-button');
    expect(cancel.props.style.minHeight).toBeGreaterThanOrEqual(44);
    expect(cancel.props.style.minWidth).toBeGreaterThanOrEqual(44);
    fireEvent.press(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
});
