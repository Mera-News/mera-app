/* eslint-disable @typescript-eslint/no-require-imports */
// Settings > Mera Protocol: the "Background refresh" row.
//
// Default ON; OFF must reach the settings module (which unregisters the OS
// task); a failed save puts the switch back; the copy follows the mode the run
// will actually use; the row is hidden during onboarding, which reuses this
// screen. Copy is asserted by KEY (`t` echoes it).
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, opts?: any) => (opts ? `${k}:${JSON.stringify(opts)}` : k) }),
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/progress', () => {
    const { View } = require('react-native');
    return { Progress: (p: any) => <View {...p} />, ProgressFilledTrack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const C = (p: any) => <View {...p} />;
    return { Modal: ({ isOpen, children }: any) => (isOpen ? children : null), ModalBackdrop: C, ModalBody: C, ModalContent: C, ModalFooter: C, ModalHeader: C };
});
jest.mock('@/components/ui/switch', () => {
    const { Pressable } = require('react-native');
    return {
        Switch: ({ onToggle, value, testID, ...p }: any) => (
            <Pressable testID={testID} accessibilityState={{ checked: value }} onPress={() => onToggle(!value)} {...p} />
        ),
    };
});
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: (p: any) => { const { View } = require('react-native'); return <View {...p} />; },
    ToastTitle: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
    ToastDescription: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
}));
// The real ScrollView pulls a native-component spec Jest cannot parse.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return actual.View;
            return (target as any)[prop];
        },
    });
});
jest.mock('@/components/ui/gluestack-ui-provider', () => ({ GluestackUIProvider: ({ children }: any) => children }));
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

jest.mock('@/components/custom/config-mera/AttestationVerificationRow', () => ({ AttestationVerificationRow: () => null }));
jest.mock('@/components/custom/BetaBadge', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-mera/ProcessingModePill', () => ({ __esModule: true, default: () => null }));

jest.mock('@/lib/account-service', () => ({
    AccountService: {
        getUserPersona: jest.fn(async () => ({ processingMode: mockMode })),
        updateProcessingMode: jest.fn(async () => {}),
    },
}));
jest.mock('@/lib/auth-client', () => ({
    authClient: { getSession: jest.fn(async () => ({ data: { user: { id: 'u1' } } })) },
}));
jest.mock('@/lib/mera-protocol-toolkit/core/downloadService', () => ({
    cancelModelDownload: jest.fn(), isDownloadInProgress: () => false, startModelDownload: jest.fn(),
}));
jest.mock('@/lib/mera-protocol-toolkit/core/modelManager', () => ({
    deleteBaseModel: jest.fn(), disposeModel: jest.fn(), isModelDownloaded: jest.fn(async () => false),
}));
jest.mock('@/lib/mera-protocol-toolkit/core/systemRequirements', () => ({
    checkRequirements: jest.fn(async () => ({ supported: true })),
}));
jest.mock('@/lib/mera-protocol-toolkit/core/inference-stats', () => ({
    averageMs: () => null, resetInferenceStats: jest.fn(), useInferenceStats: () => ({ relevance: [], reason: [] }),
}));

let mockMode = 'CLOUD';
const mockStore = {
    setProcessingMode: jest.fn(), setModelState: jest.fn(), setRelevanceV4: jest.fn(),
    setWebSearchInChat: jest.fn(), setDeepInterview: jest.fn(), setShowExtractedMetadata: jest.fn(),
    setSelectedModelId: jest.fn(), setDownloadProgress: jest.fn(),
};
jest.mock('@/lib/stores/mera-protocol-store', () => ({
    useMeraProtocolStore: Object.assign(() => mockStore, {
        getState: () => ({ ...mockStore, modelState: 'not_downloaded' }),
        subscribe: () => () => {},
    }),
    useProcessingMode: () => mockMode,
    useSelectedModelId: () => 'mera-qwen3.5-2b',
    useModelState: () => 'not_downloaded',
    useDownloadProgress: () => 0,
    useRelevanceV4: () => false,
    useWebSearchInChat: () => true,
    useDeepInterview: () => false,
    useShowExtractedMetadata: () => false,
}));

let mockStoredToggle = true;
const mockSave = jest.fn(async (_on: boolean) => {});
jest.mock('@/lib/background/bg-refresh-ui', () => ({
    ...jest.requireActual('@/lib/background/bg-refresh-ui'),
    loadBgRefreshToggle: jest.fn(async () => mockStoredToggle),
    saveBgRefreshToggle: (on: boolean) => mockSave(on),
}));

import MeraProtocolSettingsScreen from '../MeraProtocolSettingsScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockMode = 'CLOUD';
    mockStoredToggle = true;
});

async function renderSettings() {
    const utils = render(<MeraProtocolSettingsScreen onBack={jest.fn()} />);
    await waitFor(() => expect(utils.queryByTestId('mera-protocol-bg-refresh')).toBeTruthy());
    return utils;
}

describe('Background refresh row', () => {
    it('shows the title and the cloud description, ON by default', async () => {
        const { getByText, getByTestId } = await renderSettings();
        expect(getByText('meraProtocol.bgRefreshTitle')).toBeTruthy();
        expect(getByText('meraProtocol.bgRefreshCloudIos')).toBeTruthy();
        expect(getByTestId('mera-protocol-bg-refresh-switch').props.accessibilityState).toEqual({ checked: true });
    });

    it('in on-device mode says the phone ranks on open', async () => {
        mockMode = 'ON_DEVICE';
        const { getByText } = await renderSettings();
        expect(getByText('meraProtocol.bgRefreshOnDevice')).toBeTruthy();
    });

    it('reflects a stored OFF', async () => {
        mockStoredToggle = false;
        const { getByTestId } = await renderSettings();
        await waitFor(() =>
            expect(getByTestId('mera-protocol-bg-refresh-switch').props.accessibilityState).toEqual({ checked: false }),
        );
    });

    it('turning it off saves OFF (the settings module unregisters the task)', async () => {
        const { getByTestId } = await renderSettings();
        fireEvent.press(getByTestId('mera-protocol-bg-refresh-switch'));
        expect(mockSave).toHaveBeenCalledWith(false);
        expect(getByTestId('mera-protocol-bg-refresh-switch').props.accessibilityState).toEqual({ checked: false });
    });

    it('puts the switch back when the save fails', async () => {
        mockSave.mockRejectedValueOnce(new Error('db'));
        const { getByTestId } = await renderSettings();
        fireEvent.press(getByTestId('mera-protocol-bg-refresh-switch'));
        await waitFor(() =>
            expect(getByTestId('mera-protocol-bg-refresh-switch').props.accessibilityState).toEqual({ checked: true }),
        );
    });

    it('is hidden during onboarding, which reuses this screen', async () => {
        const { queryByTestId } = render(<MeraProtocolSettingsScreen isOnboarding onBack={jest.fn()} />);
        await waitFor(() => expect(queryByTestId('mera-protocol-relevance-v4')).toBeTruthy());
        expect(queryByTestId('mera-protocol-bg-refresh')).toBeNull();
    });
});
