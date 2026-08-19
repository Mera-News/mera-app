// The recovery flow — "I already have a backup".
//
// Extracted from BackupSection so onboarding and settings run ONE
// implementation. These are the properties that must hold on both:
//
//   1. It asks WHERE THE BACKUP IS, not where backups should go. Wiring those
//      two questions to the same screen is what shipped first, and the symptom
//      on device was: enter your code, get a destination picker, nothing
//      restores.
//   2. It shows what is actually there BEFORE anything is replaced.
//   3. It RELOADS afterwards. A restore replaces rows underneath every Zustand
//      store, and those hydrate once at startup.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const calls: string[] = [];

const mockAdopt = jest.fn(async (_c: string) => { calls.push('adopt'); return true; });
jest.mock('@/lib/backup/key-store', () => ({ adoptRecoveryCode: (c: string) => mockAdopt(c) }));

const mockListBackups = jest.fn(async () => {
    calls.push('listBackups');
    return ['/mera-backup/mera-backup-2026-08-18T00-00-00-000Z.bin'];
});
const mockRunRestore = jest.fn(async () => { calls.push('runRestore'); return { rowsRestored: 13 }; });
const mockVerify = jest.fn(async () => { calls.push('verify'); });
jest.mock('@/lib/backup/backup-service', () => ({
    listBackups: () => mockListBackups(),
    runRestore: () => mockRunRestore(),
    verifyProviderAccess: () => mockVerify(),
}));

const mockSetProviderId = jest.fn(async (id: string) => { calls.push(`setProvider:${id}`); });
jest.mock('@/lib/backup/backup-settings', () => ({
    setBackupProviderId: (id: string) => mockSetProviderId(id),
}));

let mockConnectResult: unknown = { ok: true };
const mockConnect = jest.fn(async () => { calls.push('connect'); return mockConnectResult; });
jest.mock('@/lib/backup/providers/google-drive', () => ({
    connectGoogleDrive: () => mockConnect(),
    googleDriveProvider: { id: 'google-drive' },
    isGoogleDriveConfigured: () => true,
}));
let mockICloudSupported = true;
jest.mock('@/lib/backup/providers/icloud', () => ({
    icloudProvider: { id: 'icloud' },
    isICloudSupported: () => mockICloudSupported,
}));

const mockReload = jest.fn(async () => { calls.push('reload'); });
jest.mock('expo-updates', () => ({ reloadAsync: () => mockReload() }));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), addBreadcrumb: jest.fn(), info: jest.fn() },
}));

// --- chrome -----------------------------------------------------------------
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable: (p: any) => <Pressable {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/input', () => {
    const { View, TextInput } = require('react-native');
    return { Input: ({ children }: any) => <View>{children}</View>, InputField: (p: any) => <TextInput {...p} /> };
});
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: ({ children, onPress, isDisabled, testID, ...p }: any) => (
            <Pressable onPress={onPress} disabled={isDisabled} testID={testID} {...p}>{children}</Pressable>
        ),
        ButtonText: ({ children }: any) => <Text>{children}</Text>,
    };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const pass = ({ children }: any) => <View>{children}</View>;
    return {
        Modal: ({ children, isOpen }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: () => null, ModalContent: pass, ModalHeader: pass, ModalBody: pass, ModalFooter: pass,
    };
});
jest.mock('@/components/ui/toast', () => {
    const { View, Text } = require('react-native');
    return {
        useToast: () => ({ show: (o: any) => { calls.push('toast'); o.render?.(); } }),
        Toast: (p: any) => <View {...p} />, ToastTitle: (p: any) => <Text {...p} />, ToastDescription: (p: any) => <Text {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import BackupRecoveryFlow from '../BackupRecoveryFlow';

const onSkip = jest.fn();

function renderFlow() {
    return render(<BackupRecoveryFlow onSkip={onSkip} skipLabel="skip" />);
}

async function enterCode(r: ReturnType<typeof render>, code = 'abcde fghjk') {
    fireEvent.changeText(r.getByTestId('recovery-code-input'), code);
    fireEvent.press(r.getByTestId('recovery-continue'));
    await waitFor(() => expect(mockAdopt).toHaveBeenCalled());
}

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockConnectResult = { ok: true };
    mockICloudSupported = true;
    mockAdopt.mockResolvedValue(true);
});

describe('the code step', () => {
    it('will not submit an empty code', () => {
        const r = renderFlow();
        fireEvent.press(r.getByTestId('recovery-continue'));
        expect(mockAdopt).not.toHaveBeenCalled();
    });

    it('says the code is wrong and stays put', async () => {
        mockAdopt.mockResolvedValueOnce(false);
        const r = renderFlow();
        await enterCode(r, 'nope');
        await waitFor(() => expect(calls).toContain('toast'));
        r.getByTestId('recovery-code-input');
    });

    it('moves to WHERE THE BACKUP IS, having configured nothing', async () => {
        const r = renderFlow();
        await enterCode(r);
        await waitFor(() => r.getByTestId('recovery-source-icloud'));
        // The bug this pins: an earlier version sent the user to the SETUP
        // destination picker, silently configured a backup destination, and
        // never restored anything.
        expect(mockSetProviderId).not.toHaveBeenCalled();
    });

    it('can be declined at any point', () => {
        const r = renderFlow();
        fireEvent.press(r.getByTestId('recovery-skip'));
        expect(onSkip).toHaveBeenCalled();
    });
});

describe('the source step', () => {
    it('hides a platform that can never hold the backup', async () => {
        mockICloudSupported = false;
        const r = renderFlow();
        await enterCode(r);
        await waitFor(() => r.getByTestId('recovery-source-google-drive'));
        expect(r.queryByTestId('recovery-source-icloud')).toBeNull();
    });

    it('proves access BEFORE listing, so a scope problem is not shown as "no backups"', async () => {
        const r = renderFlow();
        await enterCode(r);
        await waitFor(() => r.getByTestId('recovery-source-icloud'));
        fireEvent.press(r.getByTestId('recovery-source-icloud'));
        await waitFor(() => expect(mockListBackups).toHaveBeenCalled());
        expect(calls.indexOf('verify')).toBeLessThan(calls.indexOf('listBackups'));
    });

    it('connects Drive first, and does not list when that fails', async () => {
        mockConnectResult = { ok: false, reason: 'misconfigured', detail: 'DEVELOPER_ERROR' };
        const r = renderFlow();
        await enterCode(r);
        await waitFor(() => r.getByTestId('recovery-source-google-drive'));
        fireEvent.press(r.getByTestId('recovery-source-google-drive'));
        await waitFor(() => expect(mockConnect).toHaveBeenCalled());
        expect(mockListBackups).not.toHaveBeenCalled();
        expect(calls).toContain('toast');
    });

    it('stays quiet when the user just cancels the account chooser', async () => {
        mockConnectResult = { ok: false, reason: 'cancelled' };
        const r = renderFlow();
        await enterCode(r);
        await waitFor(() => r.getByTestId('recovery-source-google-drive'));
        fireEvent.press(r.getByTestId('recovery-source-google-drive'));
        await waitFor(() => expect(mockConnect).toHaveBeenCalled());
        expect(calls).not.toContain('toast');
    });

    it('says so when the destination holds no backups', async () => {
        mockListBackups.mockResolvedValueOnce([]);
        const r = renderFlow();
        await enterCode(r);
        await waitFor(() => r.getByTestId('recovery-source-icloud'));
        fireEvent.press(r.getByTestId('recovery-source-icloud'));
        await waitFor(() => r.getByText('backup.restoreEmpty'));
    });
});

describe('the restore', () => {
    async function reachList(r: ReturnType<typeof render>) {
        await enterCode(r);
        await waitFor(() => r.getByTestId('recovery-source-icloud'));
        fireEvent.press(r.getByTestId('recovery-source-icloud'));
        await waitFor(() => r.getByText('mera-backup-2026-08-18T00-00-00-000Z.bin'));
    }

    it('needs an explicit confirmation, because it REPLACES', async () => {
        const r = renderFlow();
        await reachList(r);
        fireEvent.press(r.getByText('mera-backup-2026-08-18T00-00-00-000Z.bin'));
        await waitFor(() => r.getByTestId('recovery-confirm'));
        expect(mockRunRestore).not.toHaveBeenCalled();
    });

    it('restores, remembers the destination, and RELOADS', async () => {
        const r = renderFlow();
        await reachList(r);
        fireEvent.press(r.getByText('mera-backup-2026-08-18T00-00-00-000Z.bin'));
        await waitFor(() => r.getByTestId('recovery-confirm'));
        fireEvent.press(r.getByTestId('recovery-confirm'));

        await waitFor(() => expect(calls).toContain('reload'));
        expect(mockSetProviderId).toHaveBeenCalledWith('icloud');
        // Without the reload the user is told "13 items restored" and shown the
        // same empty persona, because every store hydrated at startup.
        expect(calls.indexOf('runRestore')).toBeLessThan(calls.indexOf('reload'));
    });

    it('falls back to asking for a restart when the reload itself fails', async () => {
        mockReload.mockRejectedValueOnce(new Error('no updates module'));
        const onRestored = jest.fn();
        const r = render(
            <BackupRecoveryFlow onSkip={onSkip} skipLabel="skip" onRestoredWithoutReload={onRestored} />,
        );
        await reachList(r);
        fireEvent.press(r.getByText('mera-backup-2026-08-18T00-00-00-000Z.bin'));
        await waitFor(() => r.getByTestId('recovery-confirm'));
        fireEvent.press(r.getByTestId('recovery-confirm'));
        // The data IS restored; the app is just showing stale state.
        await waitFor(() => expect(onRestored).toHaveBeenCalled());
    });
});
